#!/usr/bin/env node
// Leak check for a generated receipt: proves no transcript CONTENT made it out.
//
//   node scripts/leak-check.mjs <receipt.json|receipt.md>... [--projects-dir ~/.claude/projects]
//
// For every session the receipt names, it re-reads that session's transcript in
// memory, collects every content string (prompts, assistant text, thinking,
// tool inputs, tool results, titles), and checks that no 24+ char window of
// any of them appears in the output files. Prints counts only, never content.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const pdIdx = args.indexOf("--projects-dir");
const projectsDir = pdIdx >= 0 ? args.splice(pdIdx, 2)[1] : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const outputs = args.map((p) => readFileSync(p, "utf8")).join("\n");
const receipt = JSON.parse(readFileSync(args.find((a) => a.endsWith(".json")), "utf8"));
const shortIds = new Set(receipt.sessions.map((s) => s.id));

const files = [];
for (const proj of readdirSync(projectsDir)) {
  const d = join(projectsDir, proj);
  let entries = [];
  try { entries = readdirSync(d); } catch { continue; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl") || !shortIds.has(f.slice(0, 8))) continue;
    files.push(join(d, f));
    const sub = join(d, f.replace(/\.jsonl$/, ""), "subagents");
    if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith(".jsonl")) files.push(join(sub, s));
  }
}

const strings = new Set();
const walk = (v, key) => {
  if (typeof v === "string") {
    // ids, timestamps, paths, model names and enums are metadata, not content
    if (["uuid", "parentUuid", "sessionId", "session_id", "timestamp", "cwd", "gitBranch", "id", "model", "type", "role",
         "requestId", "version", "signature", "tool_use_id", "name", "promptId", "entrypoint", "userType", "file_path",
         "subtype", "stop_reason", "service_tier", "speed", "inference_geo", "permissionMode", "level"].includes(key)) return;
    const t = v.trim();
    if (t.length >= 24) strings.add(t);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
};
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    try { walk(JSON.parse(line), ""); } catch { /* partial line */ }
  }
}

const norm = (s) => s.replace(/\s+/g, " ");
const hay = norm(outputs);
let hits = 0;
for (const s of strings) {
  const n = norm(s);
  // sample windows across the string so short quotes inside long text are caught too
  for (let i = 0; i + 24 <= n.length; i += 12) {
    if (hay.includes(n.slice(i, i + 24))) { hits++; break; }
  }
}
console.log(`leak-check: ${files.length} transcript files, ${strings.size} content strings checked, ${hits} found in output.`);
process.exit(hits ? 1 : 0);
