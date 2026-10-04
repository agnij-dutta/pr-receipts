// Reads Claude Code session transcripts (~/.claude/projects/<encoded-cwd>/*.jsonl,
// plus <session>/subagents/*.jsonl) and extracts USAGE METADATA ONLY.
//
// Privacy contract: this module is the only code that touches raw transcript
// lines. It copies out numbers, ids, timestamps, cwd/gitBranch, tool NAMES, and
// file paths from file-editing tools. It never copies prompt text, assistant
// text, thinking, tool inputs (other than file_path), or tool results. Raw
// parsed objects are dropped as soon as the fields are pulled out.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MetaEvent, UsageEvent } from "./types.js";

/** Tools whose input carries a path we may record (path only, never content). */
const FILE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

export function defaultProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/** All transcript files, optionally only those modified at/after `since`. */
export function listTranscriptFiles(projectsDir: string, since?: Date): string[] {
  if (!existsSync(projectsDir)) return [];
  const out: string[] = [];
  const keep = (p: string) => {
    if (!since) return true;
    try {
      return statSync(p).mtimeMs >= since.getTime();
    } catch {
      return false;
    }
  };
  for (const proj of safeReaddir(projectsDir)) {
    const projDir = join(projectsDir, proj);
    for (const entry of safeReaddir(projDir)) {
      const p = join(projDir, entry);
      if (entry.endsWith(".jsonl")) {
        if (keep(p)) out.push(p);
        continue;
      }
      const sub = join(p, "subagents");
      for (const s of safeReaddir(sub)) {
        const sp = join(sub, s);
        if (s.endsWith(".jsonl") && keep(sp)) out.push(sp);
      }
    }
  }
  return out.sort();
}

function safeReaddir(p: string): string[] {
  try {
    return statSync(p).isDirectory() ? readdirSync(p) : [];
  } catch {
    return [];
  }
}

export interface ParsedTranscripts {
  usage: Map<string, UsageEvent>; // keyed by message id (deduplicated)
  meta: MetaEvent[];
  filesScanned: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse transcripts. Claude Code writes one JSONL record per streamed content
 * block, so a single API response appears several times with the same
 * message.id and (almost always) identical usage. We dedupe by message.id and
 * keep the max of each counter (output_tokens can grow across chunks).
 */
export async function parseTranscripts(
  files: string[],
  window?: { start: Date; end: Date },
): Promise<ParsedTranscripts> {
  const usage = new Map<string, UsageEvent>();
  const meta: MetaEvent[] = [];
  const startMs = window?.start.getTime() ?? -Infinity;
  const endMs = window?.end.getTime() ?? Infinity;

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || line.length < 10) continue;
      // Cheap prefilter before JSON.parse.
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"type":"system"')) {
        continue;
      }
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const type = o?.type;
      const ts = str(o?.timestamp);
      const t = ts ? Date.parse(ts) : NaN;
      if (!Number.isNaN(t) && (t < startMs || t > endMs)) continue;
      const base = {
        sessionId: str(o.sessionId),
        timestamp: ts,
        cwd: str(o.cwd),
        gitBranch: str(o.gitBranch),
      };
      if (type === "assistant") {
        extractAssistant(o, base, usage);
      } else if (type === "user") {
        if (o.isSidechain || o.isMeta) continue;
        if (isHumanPrompt(o?.message?.content)) meta.push({ kind: "prompt", ...base });
      } else if (type === "system") {
        if (o.subtype === "turn_duration") meta.push({ kind: "turn", ...base, durationMs: num(o.durationMs) });
        else if (o.subtype === "api_error") meta.push({ kind: "apiError", ...base });
      }
      o = undefined; // drop the raw record
    }
  }
  return { usage, meta, filesScanned: files.length };
}

/** A human turn: string content, or blocks that are not purely tool results. Inspects block TYPES only. */
function isHumanPrompt(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && (b.type === "text" || b.type === "image"));
}

function extractAssistant(
  o: any,
  base: { sessionId: string; timestamp: string; cwd: string; gitBranch: string },
  usage: Map<string, UsageEvent>,
): void {
  const m = o.message;
  if (!m || typeof m !== "object") return;
  const model = str(m.model);
  if (!model || model === "<synthetic>") return; // local placeholder, not an API call
  const id = str(m.id) || str(o.requestId) || str(o.uuid);
  if (!id) return;
  const u = m.usage ?? {};
  const cc = u.cache_creation ?? {};
  const totalWrite = num(u.cache_creation_input_tokens);
  let w1h = num(cc.ephemeral_1h_input_tokens);
  let w5m = num(cc.ephemeral_5m_input_tokens);
  if (w1h + w5m === 0 && totalWrite > 0) w5m = totalWrite; // older records: no TTL split
  const iterations: any[] = Array.isArray(u.iterations) ? u.iterations : [];
  const fallbacks = iterations.filter((i) => i?.type === "fallback_message").length;

  let ev = usage.get(id);
  if (!ev) {
    ev = {
      messageId: id,
      ...base,
      model,
      isSidechain: Boolean(o.isSidechain),
      speed: str(u.speed) || "standard",
      inferenceGeo: str(u.inference_geo),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      webSearches: 0,
      refusalFallbacks: 0,
      tools: new Map(),
      filePaths: new Set(),
    };
    usage.set(id, ev);
  }
  ev.inputTokens = Math.max(ev.inputTokens, num(u.input_tokens));
  ev.outputTokens = Math.max(ev.outputTokens, num(u.output_tokens));
  ev.cacheReadTokens = Math.max(ev.cacheReadTokens, num(u.cache_read_input_tokens));
  ev.cacheWrite5mTokens = Math.max(ev.cacheWrite5mTokens, w5m);
  ev.cacheWrite1hTokens = Math.max(ev.cacheWrite1hTokens, w1h);
  ev.webSearches = Math.max(ev.webSearches, num(u.server_tool_use?.web_search_requests));
  ev.refusalFallbacks = Math.max(ev.refusalFallbacks, fallbacks);

  const content = Array.isArray(m.content) ? m.content : [];
  for (const b of content) {
    if (!b || b.type !== "tool_use") continue;
    const name = str(b.name);
    const bid = str(b.id) || `${id}:${ev.tools.size}`;
    if (name) ev.tools.set(bid, name);
    const key = FILE_TOOLS[name];
    if (key) {
      const p = b.input?.[key];
      if (typeof p === "string" && p.startsWith("/")) ev.filePaths.add(p);
    }
  }
}
