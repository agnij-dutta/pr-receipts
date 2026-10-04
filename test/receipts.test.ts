import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld, iso, SECRETS } from "./fixtures/generate.js";
import { activeTime, collect } from "../src/collect.js";
import { costOf, loadPricing, normalizeModel } from "../src/pricing.js";
import { renderMarkdown, sanitizeReceipt, STICKY_MARKER } from "../src/render.js";
import { duration, money } from "../src/format.js";
import { findReceipt, installHook, pushNotes, readNote, writeNote } from "../src/notes.js";
import { run, type ActionEnv } from "../src/action/main.js";
import { listTranscriptFiles, parseTranscripts } from "../src/transcripts.js";

const world = buildWorld();
const pricing = loadPricing();
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const base = { cwd: world.repo, branch: world.branch, projectsDir: world.projectsDir };

test("pricing: model id normalization", () => {
  assert.equal(normalizeModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("anthropic.claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(normalizeModel("claude-opus-4-5@20251101"), "claude-opus-4-5");
});

test("pricing: cache tiers, fast mode, US geo, unknown model", () => {
  const t = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWrite5mTokens: 1e6, cacheWrite1hTokens: 1e6 };
  close(costOf(pricing, "claude-opus-5-5", t)!, 4 + 20 + 0.2 + 5 + 8);
  close(costOf(pricing, "claude-opus-5-5", t, { speed: "fast" })!, 8 + 40 + 0.4 + 10 + 16);
  close(costOf(pricing, "claude-sonnet-5", t, { inferenceGeo: "us" })!, (2 + 10 + 0.2 + 2.5 + 4) * 1.1);
  close(costOf(pricing, "claude-fable-5-1", { ...t, inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })!, 0.25);
  assert.equal(costOf(pricing, "claude-mystery-9", t), null);
});

test("parser dedupes streamed records by message id and skips <synthetic>", async () => {
  const files = listTranscriptFiles(world.projectsDir);
  assert.equal(files.length, 6); // A, B, C, D, E + one subagent file
  const parsed = await parseTranscripts(files);
  assert.ok(parsed.usage.has("msg_A1"));
  assert.ok(!parsed.usage.has("msg_SYN"));
  const a2 = parsed.usage.get("msg_A2")!;
  assert.equal(a2.tools.size, 3); // three streamed records, three distinct tool_use blocks
  assert.equal(a2.outputTokens, 2000); // not tripled
});

test("collect: default matching (branch + cwd/time), exclusions, totals", async () => {
  const r = await collect(base);
  assert.equal(r.schema, "pr-receipts/v1");
  assert.equal(r.repo.commits, 2);
  assert.equal(r.repo.commitRange, `main..${world.branch}`);
  assert.equal(r.totals.apiRequests, 5); // A1 A2 A3 S1 B1
  assert.equal(r.totals.subagentRequests, 1);
  assert.equal(r.mapping.byBranch, 4);
  assert.equal(r.mapping.byCwd, 1);
  assert.equal(r.mapping.byFiles, 0);
  assert.equal(r.mapping.excludedOtherBranch, 2); // session C on main + session E in another worktree
  assert.equal(r.mapping.confidence, "high");
  // 0.20004 (A1) + 0.08402 (A2) + 0.0208 (A3 fast) + 0.0025 (S1 haiku) + 0.007 (B1 sonnet 5)
  close(r.totals.costUSD, 0.31436, 1e-4);
  assert.equal(r.totals.turns, 2);
  assert.equal(r.totals.agentTimeMs, 20 * 60_000);
  assert.equal(r.totals.apiErrors, 1);
  assert.equal(r.totals.refusalFallbacks, 1);
  assert.equal(r.totals.toolCalls, 6);
  assert.deepEqual(r.files, { count: 2, paths: ["src/a.ts", "src/b.ts"] });
  assert.deepEqual(r.sessions.map((s) => s.id), ["aaaaaaaa", "bbbbbbbb"]);
  assert.equal(r.tools, undefined); // opt-in only
  assert.equal(r.headline, "This PR cost $0.31 and 20 minutes of agent time.");
  assert.deepEqual(r.models.map((m) => m.model), ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"]);
});

test("collect --loose pulls in sessions that edited repo files from elsewhere; unpriced models flagged", async () => {
  const r = await collect({ ...base, loose: true });
  assert.equal(r.mapping.byFiles, 2);
  assert.equal(r.totals.apiRequests, 7);
  assert.deepEqual(r.pricing.unpricedModels, ["claude-mystery-9"]);
  close(r.totals.costUSD, 0.31436 + 0.061, 1e-4);
  assert.equal(r.totals.turns, 3);
  assert.ok(r.mapping.notes.some((n) => n.includes("No price configured")));
});

test("collect --since uses the commit time as window start", async () => {
  const first = execFileSync("git", ["rev-list", "--reverse", `main..${world.branch}`], { cwd: world.repo, encoding: "utf8" }).split("\n")[0];
  const r = await collect({ ...base, since: first });
  assert.equal(r.repo.window.start, iso(30));
  assert.equal(r.repo.commits, 1);
  assert.equal(r.totals.apiRequests, 1); // only B1 (t=41) is after the first commit
});

test("dedicated worktree branch beats the stale launch-time gitBranch", async () => {
  const r = await collect({ ...base, branch: world.wtBranch });
  assert.equal(r.repo.commits, 3);
  assert.equal(r.mapping.byBranch, 1); // msg_E1, although its record says gitBranch "main"
  assert.equal(r.mapping.byCwd, 1); // B1 in the main checkout with gitBranch HEAD
  assert.deepEqual(r.files.paths, ["src/e.ts"]); // relative to the worktree, not the main checkout
});

test("no commits ahead of base: window is derived from transcript records on the branch", async () => {
  const r = await collect({ ...base, branch: "main" });
  assert.equal(r.repo.commits, 0);
  assert.equal(r.totals.apiRequests, 1); // msg_C1
  assert.ok(r.mapping.notes[0].startsWith("Time window derived"));
});

test("collect errors clearly when there is no window at all", async () => {
  execFileSync("git", ["branch", "-f", "ghost", "main"], { cwd: world.repo });
  await assert.rejects(collect({ ...base, branch: "ghost" }), /Cannot infer a time window/);
});

test("privacy: no planted secret reaches the receipt or the rendered comment, even with every opt-in", async () => {
  for (const opts of [{}, { includeTools: true }, { includeTools: true, loose: true }]) {
    const r = await collect({ ...base, ...opts });
    const blob = JSON.stringify(r) + renderMarkdown(r, { sticky: true });
    for (const s of SECRETS) assert.ok(!blob.includes(s), `leaked: ${s}`);
  }
});

test("privacy: tool names (which can reveal MCP services) appear only with --include-tools", async () => {
  const off = await collect(base);
  assert.ok(!JSON.stringify(off).includes("mcp__gmail"));
  assert.ok(!renderMarkdown(off).includes("mcp__gmail"));
  const on = await collect({ ...base, includeTools: true });
  assert.equal(on.tools?.["Write"], 2);
  assert.equal(on.tools?.["mcp__gmail__send_email"], 1);
  assert.ok(renderMarkdown(on).includes("Tools used"));
});

test("privacy: --no-file-paths keeps the count but drops paths", async () => {
  const r = await collect({ ...base, includeFilePaths: false });
  assert.deepEqual(r.files, { count: 2 });
  assert.ok(!renderMarkdown(r).includes("src/a.ts"));
});

test("sanitizeReceipt strips unknown keys, absolute paths, and un-opted tool counts", async () => {
  const r: any = await collect(base);
  r.prompt = SECRETS[0];
  r.files.paths.push("/etc/passwd", "../outside");
  r.tools = { Bash: 1 };
  const s = sanitizeReceipt(JSON.parse(JSON.stringify(r)));
  assert.ok(!("prompt" in s));
  assert.equal(s.tools, undefined);
  assert.deepEqual(s.files.paths, ["src/a.ts", "src/b.ts"]);
  assert.throws(() => sanitizeReceipt({ schema: "nope" }), /unsupported/);
});

test("render: headline, table, sticky marker, no em dashes", async () => {
  const r = await collect(base);
  const md = renderMarkdown(r, { sticky: true });
  assert.ok(md.startsWith(STICKY_MARKER));
  assert.ok(md.includes("**This PR cost $0.31 and 20 minutes of agent time.**"));
  assert.ok(md.includes("| Cost (API list price) | **$0.31** |"));
  assert.ok(md.includes("| Models | Opus 5.5, Sonnet 5, Haiku 4.5 |"));
  assert.ok(md.includes("| API requests | 5 (1 by subagents) |"));
  assert.ok(md.includes("Confidence: **high**"));
  assert.ok(!md.includes(String.fromCharCode(0x2014)), "no em dashes");
  assert.ok(!renderMarkdown(r).includes(STICKY_MARKER));
});

test("format helpers", () => {
  assert.equal(money(4.123), "$4.12");
  assert.equal(money(0.001), "<$0.01");
  assert.equal(duration(38 * 60_000), "38 minutes");
  assert.equal(duration(72 * 60_000), "1 hour 12 minutes");
  assert.equal(duration(30_000), "30 seconds");
  assert.equal(activeTime([iso(0), iso(1), iso(2), iso(30)]), 2 * 60_000); // 28 min idle gap ignored
});

// ---- git notes + action ---------------------------------------------------

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

test("notes: attach to branch head, find from a later commit range, push to a remote and read in a fresh clone (CI)", async () => {
  const r = await collect(base);
  const head = git(world.repo, "rev-parse", world.branch);
  writeNote(world.repo, head, r);
  assert.equal(readNote(world.repo, head)?.headline, r.headline);
  assert.equal(findReceipt(world.repo, world.branch, "main")?.commit, head);

  const remote = mkdtempSync(join(tmpdir(), "pr-receipts-remote-"));
  git(remote, "init", "-q", "--bare");
  git(world.repo, "remote", "add", "origin", remote);
  git(world.repo, "push", "-q", "origin", "main", world.branch);
  pushNotes(world.repo, "origin");

  const clone = mkdtempSync(join(tmpdir(), "pr-receipts-clone-"));
  git(clone, "clone", "-q", remote, ".");
  assert.equal(findReceipt(clone, `origin/${world.branch}`, "origin/main"), null); // notes are not fetched by default
  git(clone, "fetch", "-q", "origin", "refs/notes/pr-receipts:refs/notes/pr-receipts");
  assert.equal(findReceipt(clone, `origin/${world.branch}`, "origin/main")?.receipt.headline, r.headline);
});

function eventFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), "pr-receipts-event-")), "event.json");
  writeFileSync(
    p,
    JSON.stringify({
      action: "synchronize",
      pull_request: {
        number: 7,
        head: { sha: git(world.repo, "rev-parse", world.branch) },
        base: { sha: git(world.repo, "rev-parse", "main") },
      },
    }),
  );
  return p;
}

function mockFetch(existing: { id: number; body: string }[]) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined });
    const json = method === "GET" ? existing : method === "POST" ? { id: 999 } : {};
    return new Response(JSON.stringify(json), { status: method === "POST" ? 201 : 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const actionEnv = (over: Partial<ActionEnv> = {}): ActionEnv => ({
  token: "test-token",
  eventPath: eventFile(),
  repository: "agnij-dutta/example",
  apiUrl: "https://api.github.test",
  workspace: world.repo,
  notesRef: "pr-receipts",
  dryRun: false,
  missing: "skip",
  ...over,
});

test("action: dry run renders the comment and makes zero API calls", async () => {
  const { f, calls } = mockFetch([]);
  const logs: string[] = [];
  const plan = await run(actionEnv({ dryRun: true }), f, (m) => logs.push(m));
  assert.equal(plan.reason, "dry-run");
  assert.equal(calls.length, 0);
  assert.ok(plan.body?.includes(STICKY_MARKER));
  assert.ok(logs.join("\n").includes("This PR cost $0.31"));
});

test("action: creates one sticky comment, then updates it in place", async () => {
  const first = mockFetch([{ id: 1, body: "unrelated human comment" }]);
  const created = await run(actionEnv(), first.f, () => {});
  assert.equal(created.action, "create");
  assert.deepEqual(first.calls.map((c) => c.method), ["GET", "POST"]);
  assert.ok(first.calls[1].url.endsWith("/repos/agnij-dutta/example/issues/7/comments"));

  const second = mockFetch([{ id: 1, body: "unrelated" }, { id: 42, body: `${STICKY_MARKER}\nold` }]);
  const updated = await run(actionEnv(), second.f, () => {});
  assert.equal(updated.action, "update");
  assert.equal(updated.commentId, 42);
  assert.deepEqual(second.calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.ok(second.calls[1].url.endsWith("/issues/comments/42"));
  for (const s of SECRETS) assert.ok(!second.calls[1].body!.includes(s));
});

test("action: skips quietly when no receipt is attached, and on non-PR events", async () => {
  const { f, calls } = mockFetch([]);
  const plan = await run(actionEnv({ notesRef: "nothing-here" }), f, () => {});
  assert.equal(plan.reason, "no receipt");
  assert.equal(calls.length, 0);
  const p = join(mkdtempSync(join(tmpdir(), "pr-receipts-push-")), "push.json");
  writeFileSync(p, JSON.stringify({ ref: "refs/heads/main" }));
  assert.equal((await run(actionEnv({ eventPath: p }), f, () => {})).reason, "not a pull_request event");
});

test("action entrypoint runs as the composite step would (env inputs, dry run, step summary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-receipts-gha-"));
  const summary = join(dir, "summary.md");
  const output = join(dir, "output.txt");
  const stdout = execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "action", "main.js")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_PATH: eventFile(),
      GITHUB_WORKSPACE: world.repo,
      GITHUB_REPOSITORY: "agnij-dutta/example",
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: output,
      INPUT_DRY_RUN: "true",
      INPUT_NOTES_REF: "pr-receipts",
    },
  });
  assert.ok(stdout.includes("DRY RUN"));
  assert.ok(readFileSync(summary, "utf8").includes("This PR cost $0.31"));
  assert.ok(readFileSync(output, "utf8").includes("cost-usd=0.3"));
});

test("install-hook writes an idempotent, recursion-guarded pre-push hook", () => {
  const p = installHook(world.repo);
  installHook(world.repo);
  const body = readFileSync(p, "utf8");
  assert.ok(existsSync(p));
  assert.equal(body.split("# pr-receipts hook").length - 1, 1);
  assert.ok(body.includes("PR_RECEIPTS_IN_HOOK"));
});
