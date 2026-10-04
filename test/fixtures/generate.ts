// Synthetic Claude Code transcripts shaped like the real ones in
// ~/.claude/projects (record types, field names, streaming duplication,
// subagent files, usage objects). Nothing here is copied from a real
// transcript. SECRETS below are planted so redaction tests can prove they never
// reach a receipt.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SECRETS = [
  "PLANTED_PROMPT_hunter2_DO_NOT_LEAK",
  "sk-ant-api03-PLANTEDFAKEKEYxxxxxxxxxxxxxxxxxxxxxxxx",
  "PLANTED_THINKING_internal_plan",
  "PLANTED_ASSISTANT_TEXT_reply",
  "PLANTED_TOOL_INPUT_old_string_password=swordfish",
  "PLANTED_TOOL_RESULT_contents_of_env_file",
  "PLANTED_BASH_COMMAND_curl_with_token",
  "PLANTED_AI_TITLE",
  "PLANTED_LAST_PROMPT",
  ".aws/credentials",
];

export const T0 = Date.parse("2026-09-01T10:00:00.000Z");
export const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

interface Usage {
  input?: number;
  output?: number;
  read?: number;
  w5?: number;
  w1?: number;
  speed?: string;
  fallback?: boolean;
  webSearch?: number;
}

function usage(u: Usage) {
  const base = {
    input_tokens: u.input ?? 0,
    cache_creation_input_tokens: (u.w5 ?? 0) + (u.w1 ?? 0),
    cache_read_input_tokens: u.read ?? 0,
    output_tokens: u.output ?? 0,
    output_tokens_details: { thinking_tokens: 3 },
    server_tool_use: { web_search_requests: u.webSearch ?? 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: u.w1 ?? 0, ephemeral_5m_input_tokens: u.w5 ?? 0 },
    inference_geo: "not_available",
    iterations: [] as unknown[],
    speed: u.speed ?? "standard",
  };
  base.iterations = u.fallback
    ? [
        { type: "message", input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: "fallback_message", input_tokens: base.input_tokens, output_tokens: base.output_tokens, cache_read_input_tokens: base.cache_read_input_tokens, cache_creation_input_tokens: 0 },
      ]
    : [{ type: "message", input_tokens: base.input_tokens, output_tokens: base.output_tokens }];
  return base;
}

interface Ctx {
  sessionId: string;
  cwd: string;
  gitBranch: string;
  isSidechain?: boolean;
}

const common = (c: Ctx, minutes: number, uuid: string) => ({
  parentUuid: null,
  isSidechain: c.isSidechain ?? false,
  userType: "external",
  entrypoint: "cli",
  cwd: c.cwd,
  sessionId: c.sessionId,
  session_id: c.sessionId,
  version: "2.1.287",
  gitBranch: c.gitBranch,
  uuid,
  timestamp: iso(minutes),
});

let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export function userPrompt(c: Ctx, minutes: number, text: string) {
  return { ...common(c, minutes, uid()), type: "user", promptId: uid(), message: { role: "user", content: text } };
}

export function toolResult(c: Ctx, minutes: number, toolUseId: string, text: string) {
  return {
    ...common(c, minutes, uid()),
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: text }] },
    toolUseResult: { stdout: text, stderr: "" },
  };
}

/** One API response written as several streamed records (one per content block), like Claude Code does. */
export function assistant(
  c: Ctx,
  minutes: number,
  msgId: string,
  model: string,
  u: Usage,
  blocks: unknown[],
): object[] {
  const requestId = `req_${msgId}`;
  return blocks.map((b, i) => ({
    ...common(c, minutes + i * 0.01, uid()),
    type: "assistant",
    requestId,
    message: {
      model,
      id: msgId,
      type: "message",
      role: "assistant",
      content: [b],
      stop_reason: i === blocks.length - 1 ? "tool_use" : null,
      stop_sequence: null,
      usage: usage(u),
    },
  }));
}

export const system = (c: Ctx, minutes: number, subtype: string, extra: object = {}) => ({
  ...common(c, minutes, uid()),
  type: "system",
  subtype,
  level: "info",
  isMeta: false,
  ...extra,
});

const write = (file: string, records: object[]) =>
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

const encode = (p: string) => p.replace(/[/.]/g, "-");

export interface FixtureWorld {
  repo: string;
  projectsDir: string;
  branch: string;
  otherDir: string;
  wtBranch: string;
  wtPath: string;
}

function sh(cwd: string, args: string[], date?: string) {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

/**
 * Build a temp git repo (main + feature/receipts with two commits at T0+30m and
 * T0+60m) and a fake ~/.claude/projects with sessions covering every matching rule.
 */
export function buildWorld(root = mkdtempSync(join(tmpdir(), "pr-receipts-"))): FixtureWorld {
  const repo = join(root, "repo");
  const otherDir = join(root, "elsewhere");
  const projectsDir = join(root, "claude", "projects");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "init"], iso(-600));
  const branch = "feature/receipts";
  sh(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "add a"], iso(30));
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-q", "-m", "add b"], iso(60));

  // A: launched inside the repo on the branch. Strong match.
  const A: Ctx = { sessionId: "aaaaaaaa-1111-4000-8000-000000000001", cwd: repo, gitBranch: branch };
  const dirA = join(projectsDir, encode(repo));
  mkdirSync(join(dirA, A.sessionId, "subagents"), { recursive: true });
  write(join(dirA, `${A.sessionId}.jsonl`), [
    { type: "mode", mode: "default", sessionId: A.sessionId },
    { type: "ai-title", aiTitle: SECRETS[7], sessionId: A.sessionId },
    { type: "last-prompt", lastPrompt: SECRETS[8], sessionId: A.sessionId },
    userPrompt(A, 0, `please fix it ${SECRETS[0]} ${SECRETS[1]}`),
    ...assistant(A, 1, "msg_A1", "claude-opus-5-5", { input: 10, output: 1000, read: 100_000, w1: 20_000 }, [
      { type: "thinking", thinking: SECRETS[2], signature: "sig" },
      { type: "text", text: SECRETS[3] },
      { type: "tool_use", id: "toolu_A1", name: "Edit", input: { file_path: join(repo, "src", "a.ts"), old_string: SECRETS[4], new_string: "x" } },
    ]),
    toolResult(A, 2, "toolu_A1", SECRETS[5]),
    system(A, 3, "api_error", { level: "error", retryAttempt: 1, maxRetries: 10, retryInMs: 500, error: { message: "overloaded" } }),
    ...assistant(A, 4, "msg_A2", "claude-opus-5-5[1m]", { input: 5, output: 2000, read: 120_000, w5: 4_000 }, [
      { type: "tool_use", id: "toolu_A2", name: "Bash", input: { command: SECRETS[6] } },
      { type: "tool_use", id: "toolu_A3", name: "Write", input: { file_path: "/Users/someone/.aws/credentials", content: SECRETS[1] } },
      { type: "tool_use", id: "toolu_A4", name: "Write", input: { file_path: join(repo, "src", "b.ts"), content: SECRETS[4] } },
    ]),
    // A local synthetic placeholder: never priced, never counted.
    ...assistant(A, 5, "msg_SYN", "<synthetic>", { input: 0, output: 0 }, [{ type: "text", text: "No response requested." }]),
    // Fast mode request with a refusal fallback.
    ...assistant(A, 6, "msg_A3", "claude-opus-5-5", { input: 100, output: 500, speed: "fast", fallback: true }, [
      { type: "tool_use", id: "toolu_A5", name: "mcp__gmail__send_email", input: { to: "x@example.com", body: SECRETS[0] } },
    ]),
    system(A, 20, "turn_duration", { durationMs: 20 * 60_000, messageCount: 12 }),
    { type: "cost-state", sessionId: A.sessionId, totalCostUSD: 1.23, modelUsage: {} },
  ]);
  // Subagent transcript for session A.
  const SA: Ctx = { ...A, isSidechain: true };
  write(join(dirA, A.sessionId, "subagents", "agent-a0000000000000001.jsonl"), [
    { ...userPrompt(SA, 7, `subagent brief ${SECRETS[0]}`) },
    ...assistant(SA, 8, "msg_S1", "claude-haiku-4-5-20251001", { input: 1000, output: 100, read: 10_000 }, [
      { type: "tool_use", id: "toolu_S1", name: "Grep", input: { pattern: SECRETS[4] } },
    ]),
  ]);
  writeFileSync(join(dirA, A.sessionId, "subagents", "agent-a0000000000000001.meta.json"), JSON.stringify({ agentType: "Explore" }));

  // B: launched outside git (gitBranch HEAD) but cwd in the repo; one record in window, one far outside.
  const B: Ctx = { sessionId: "bbbbbbbb-2222-4000-8000-000000000002", cwd: repo, gitBranch: "HEAD" };
  write(join(dirA, `${B.sessionId}.jsonl`), [
    userPrompt(B, 40, `another ask ${SECRETS[0]}`),
    ...assistant(B, 41, "msg_B1", "claude-sonnet-5", { input: 2000, output: 300 }, [{ type: "text", text: SECRETS[3] }]),
    ...assistant(B, 2000, "msg_B_LATE", "claude-sonnet-5", { input: 999_999, output: 999_999 }, [{ type: "text", text: "late" }]),
  ]);

  // C: same repo, different branch. Excluded.
  const C: Ctx = { sessionId: "cccccccc-3333-4000-8000-000000000003", cwd: repo, gitBranch: "main" };
  write(join(dirA, `${C.sessionId}.jsonl`), [
    userPrompt(C, 45, "work on main"),
    ...assistant(C, 46, "msg_C1", "claude-opus-5", { input: 50_000, output: 5_000 }, [{ type: "text", text: "main work" }]),
  ]);

  // D: launched from an unrelated dir, edits a file in the repo. Only counted with --loose.
  const D: Ctx = { sessionId: "dddddddd-4444-4000-8000-000000000004", cwd: otherDir, gitBranch: "HEAD" };
  const dirD = join(projectsDir, encode(otherDir));
  mkdirSync(dirD, { recursive: true });
  write(join(dirD, `${D.sessionId}.jsonl`), [
    userPrompt(D, 50, `from desktop ${SECRETS[0]}`),
    ...assistant(D, 51, "msg_D1", "claude-fable-5-1", { input: 100, output: 1000, read: 40_000 }, [
      { type: "tool_use", id: "toolu_D1", name: "Edit", input: { file_path: join(repo, "src", "b.ts"), old_string: SECRETS[4], new_string: "y" } },
    ]),
    ...assistant(D, 52, "msg_D2", "claude-mystery-9", { input: 10, output: 10 }, [{ type: "text", text: "unpriced" }]),
  ]);

  // E: a Claude Code worktree (.claude/worktrees/wt-e) on its own branch. The
  // session was launched in the main checkout, so every record carries the
  // stale launch-time gitBranch "main" even though it works in the worktree.
  const wtBranch = "feature/wt-e";
  const wtPath = join(repo, ".claude", "worktrees", "wt-e");
  sh(repo, ["worktree", "add", "-q", "-b", wtBranch, wtPath, branch]);
  writeFileSync(join(wtPath, "src", "e.ts"), "export const e = 5;\n");
  sh(wtPath, ["add", "."]);
  sh(wtPath, ["commit", "-q", "-m", "add e"], iso(70));
  const E: Ctx = { sessionId: "eeeeeeee-5555-4000-8000-000000000005", cwd: wtPath, gitBranch: "main" };
  write(join(dirA, `${E.sessionId}.jsonl`), [
    userPrompt({ ...E, cwd: repo }, 55, "work in a worktree"),
    ...assistant(E, 56, "msg_E1", "claude-opus-5-5", { input: 10, output: 100 }, [
      { type: "tool_use", id: "toolu_E1", name: "Write", input: { file_path: join(wtPath, "src", "e.ts"), content: "x" } },
    ]),
  ]);

  return { repo, projectsDir, branch, otherDir, wtBranch, wtPath };
}

// `npm run fixtures`: write a world to test/fixtures/generated for manual poking.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = join(process.cwd(), "test", "fixtures", "generated");
  mkdirSync(out, { recursive: true });
  const w = buildWorld(mkdtempSync(join(out, "world-")));
  console.log(JSON.stringify(w, null, 2));
}
