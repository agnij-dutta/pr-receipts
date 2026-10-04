import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ActionEnv, run } from "../src/action/main.js";
import { activeTime, collect, GENERATOR } from "../src/collect.js";
import { duration, money } from "../src/format.js";
import { findReceipt, installHook, pushNotes, readNote, writeNote } from "../src/notes.js";
import { costOf, loadPricing, normalizeModel } from "../src/pricing.js";
import { isSafeRelativePath, renderMarkdown, STICKY_MARKER, sanitizeReceipt } from "../src/render.js";
import { listTranscriptFiles, parseTranscripts } from "../src/transcripts.js";
import { assistant, buildWorld, iso, SECRETS } from "./fixtures/generate.js";

const world = buildWorld();
const pricing = loadPricing();
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const base = { cwd: world.repo, branch: world.branch, projectsDir: world.projectsDir };

test("pricing: model id normalization", () => {
  assert.equal(normalizeModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("anthropic.claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(normalizeModel("claude-opus-4-5@20251101"), "claude-opus-4-5");
  // Bedrock: regional prefix, and the version suffix sits after the date.
  assert.equal(normalizeModel("eu.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5");
  assert.equal(normalizeModel("global.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
});

test("pricing: a malformed table fails loudly instead of pricing at NaN", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-receipts-pricing-"));
  const bad = join(dir, "pricing.json");
  const table = JSON.parse(JSON.stringify(pricing));
  table.models["claude-opus-5-5"].cacheRead = "0.2";
  writeFileSync(bad, JSON.stringify(table));
  assert.throws(() => loadPricing(bad), /claude-opus-5-5"\]\.cacheRead must be a non-negative number/);
  writeFileSync(bad, "{ not json");
  assert.throws(() => loadPricing(bad), /Cannot read pricing table/);
});

test("generator version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"));
  assert.equal(GENERATOR, `pr-receipts@${pkg.version}`);
});

test("pricing: cache tiers, fast mode, US geo, unknown model", () => {
  const t = {
    inputTokens: 1e6,
    outputTokens: 1e6,
    cacheReadTokens: 1e6,
    cacheWrite5mTokens: 1e6,
    cacheWrite1hTokens: 1e6,
  };
  close(costOf(pricing, "claude-opus-5-5", t)!, 4 + 20 + 0.2 + 5 + 8);
  close(costOf(pricing, "claude-opus-5-5", t, { speed: "fast" })!, 8 + 40 + 0.4 + 10 + 16);
  close(costOf(pricing, "claude-sonnet-5", t, { inferenceGeo: "us" })!, (2 + 10 + 0.2 + 2.5 + 4) * 1.1);
  close(
    costOf(pricing, "claude-fable-5-1", {
      ...t,
      inputTokens: 0,
      outputTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    })!,
    0.25,
  );
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
  assert.deepEqual(
    r.sessions.map((s) => s.id),
    ["aaaaaaaa", "bbbbbbbb"],
  );
  assert.equal(r.tools, undefined); // opt-in only
  assert.equal(r.headline, "This PR cost $0.31 and 20 minutes of agent time.");
  assert.deepEqual(
    r.models.map((m) => m.model),
    ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
  );
});

test("collect --loose pulls in sessions that edited repo files from elsewhere; unpriced models flagged", async () => {
  const r = await collect({ ...base, loose: true });
  assert.equal(r.mapping.byFiles, 2);
  assert.equal(r.totals.apiRequests, 7);
  assert.deepEqual(r.pricing.unpricedModels, ["claude-mystery-9"]);
  close(r.totals.costUSD, 0.31436 + 0.061, 1e-4);
  assert.equal(r.totals.turns, 3);
  assert.ok(r.mapping.notes.some((n) => n.includes("No price configured")));
  assert.ok(r.headline.startsWith("This PR cost at least $"), r.headline);
});

test("--loose ignores file edits outside the target branch's checkout", async () => {
  // Session D edits src/b.ts in the MAIN checkout. For the branch that lives in
  // its own worktree, that is not evidence, so nothing is pulled in.
  const r = await collect({ ...base, branch: world.wtBranch, loose: true });
  assert.equal(r.mapping.byFiles, 0);
  assert.deepEqual(r.files.paths, ["src/e.ts"]);
});

test("rebased branch: window starts from author time, not the rewritten committer time", async () => {
  const w = buildWorld();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "F",
    GIT_AUTHOR_EMAIL: "f@example.com",
    GIT_COMMITTER_NAME: "F",
    GIT_COMMITTER_EMAIL: "f@example.com",
    GIT_AUTHOR_DATE: iso(30),
    GIT_COMMITTER_DATE: iso(3000), // as if rebased two days later
  };
  execFileSync("git", ["checkout", "-q", "-b", "rebased", "main"], { cwd: w.repo });
  writeFileSync(join(w.repo, "r.txt"), "r\n");
  execFileSync("git", ["add", "r.txt"], { cwd: w.repo });
  execFileSync("git", ["commit", "-q", "-m", "rebased"], { cwd: w.repo, env });
  const r = await collect({ cwd: w.repo, branch: "rebased", projectsDir: w.projectsDir });
  assert.equal(r.repo.window.start, iso(30 - 120));
  assert.equal(r.repo.window.end, iso(3000 + 15));
});

test("gitignored files the agent touched are counted but not listed", async () => {
  const w = buildWorld();
  writeFileSync(join(w.repo, ".gitignore"), ".env.local\n");
  const ctx = { sessionId: "ffffffff-6666-4000-8000-000000000006", cwd: w.repo, gitBranch: w.branch };
  const records = assistant(ctx, 42, "msg_F1", "claude-opus-5-5", { input: 1, output: 1 }, [
    {
      type: "tool_use",
      id: "toolu_F1",
      name: "Write",
      input: { file_path: join(w.repo, ".env.local"), content: SECRETS[1] },
    },
  ]);
  const dir = join(w.projectsDir, "f");
  execFileSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, `${ctx.sessionId}.jsonl`), records.map((x) => JSON.stringify(x)).join("\n"));
  const r = await collect({ cwd: w.repo, branch: w.branch, projectsDir: w.projectsDir });
  assert.equal(r.files.count, 3);
  assert.deepEqual(r.files.paths, ["src/a.ts", "src/b.ts"]);
  assert.ok(r.mapping.notes.some((n) => n.includes("1 gitignored path")));
});

test("collect rejects bad flags with actionable messages", async () => {
  await assert.rejects(collect({ ...base, from: "yesterday-ish" }), /--from "yesterday-ish" is not a valid date/);
  await assert.rejects(collect({ ...base, branch: "no/such/branch" }), /does not exist/);
  await assert.rejects(collect({ ...base, base: "no-such-base" }), /Cannot list commits in no-such-base\.\./);
  await assert.rejects(collect({ ...base, lookbackMinutes: -5 }), /--lookback must be a non-negative/);
});

test("parser: with a window, records without a timestamp are excluded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-receipts-ts-"));
  const f = join(dir, "s.jsonl");
  const ctx = { sessionId: "s", cwd: dir, gitBranch: "x" };
  const [rec] = assistant(ctx, 1, "msg_NOTS", "claude-opus-5-5", { input: 1, output: 1 }, [
    { type: "text", text: "t" },
  ]) as Record<string, unknown>[];
  delete rec.timestamp;
  writeFileSync(f, `${JSON.stringify(rec)}\n`);
  assert.equal((await parseTranscripts([f])).usage.size, 1);
  assert.equal((await parseTranscripts([f], { start: new Date(0), end: new Date() })).usage.size, 0);
});

test("collect --since uses the commit time as window start", async () => {
  const first = execFileSync("git", ["rev-list", "--reverse", `main..${world.branch}`], {
    cwd: world.repo,
    encoding: "utf8",
  }).split("\n")[0];
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
  assert.equal(on.tools?.Write, 2);
  assert.equal(on.tools?.mcp__gmail__send_email, 1);
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

test("sanitizeReceipt rebuilds nested fields: traversal paths, junk types, newlines, nested extras", async () => {
  const r: any = JSON.parse(JSON.stringify(await collect(base)));
  r.files.paths.push("src/../../etc/passwd", "C:\\Users\\x", "~/.ssh/id_rsa", "\\\\host\\share");
  r.repo.secret = SECRETS[0];
  r.models[0].prompt = SECRETS[2];
  r.totals.costUSD = "1e9";
  r.headline = "line one\nheadline=pwned";
  r.mapping.confidence = "<script>";
  const s = sanitizeReceipt(r);
  assert.deepEqual(s.files.paths, ["src/a.ts", "src/b.ts"]);
  assert.ok(!JSON.stringify(s).includes(SECRETS[0]) && !JSON.stringify(s).includes(SECRETS[2]));
  assert.equal(s.totals.costUSD, 0);
  assert.ok(!s.headline.includes("\n"));
  assert.equal(s.mapping.confidence, "none");
  assert.ok(isSafeRelativePath("app/@modal/page.tsx"));
  assert.ok(!isSafeRelativePath("a/../../b"));
});

test("render escapes markdown and mentions in receipt strings", async () => {
  const r = await collect(base);
  r.mapping.notes.push("ping @everyone | <img src=x>");
  const md = renderMarkdown(r);
  assert.ok(!md.includes("@everyone"));
  assert.ok(md.includes("\\| \\<img src=x\\>"));
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
  assert.equal(duration(1_000), "1 second");
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

test("notes: a corrupt note is an error, not 'no receipt'; a missing head commit points at fetch-depth", () => {
  const head = git(world.repo, "rev-parse", world.branch);
  git(world.repo, "notes", "--ref=refs/notes/corrupt", "add", "-f", "-m", "{not json", head);
  assert.throws(() => readNote(world.repo, head, "corrupt"), /not a valid receipt/);
  assert.throws(() => findReceipt(world.repo, "0".repeat(40), null), /fetch-depth: 0/);
});

test("notes: push merges with a diverged remote notes ref (ours wins on the same commit)", async () => {
  const w = buildWorld();
  const r = await collect({ cwd: w.repo, branch: w.branch, projectsDir: w.projectsDir });
  const remote = mkdtempSync(join(tmpdir(), "pr-receipts-remote2-"));
  git(remote, "init", "-q", "--bare");
  git(w.repo, "remote", "add", "origin", remote);
  git(w.repo, "push", "-q", "origin", "main", w.branch);
  // Another machine attaches a receipt to main's commit and pushes first.
  const other = mkdtempSync(join(tmpdir(), "pr-receipts-other-"));
  git(other, "clone", "-q", remote, ".");
  writeNote(other, git(other, "rev-parse", "origin/main"), { ...r, headline: "other machine" });
  pushNotes(other, "origin");
  // Ours is on the branch head: the plain push is rejected, then merged and retried.
  writeNote(w.repo, git(w.repo, "rev-parse", w.branch), r);
  pushNotes(w.repo, "origin");
  const check = mkdtempSync(join(tmpdir(), "pr-receipts-check-"));
  git(check, "clone", "-q", remote, ".");
  git(check, "fetch", "-q", "origin", "refs/notes/pr-receipts:refs/notes/pr-receipts");
  assert.equal(readNote(check, git(check, "rev-parse", "origin/main"))?.headline, "other machine");
  assert.equal(readNote(check, git(check, "rev-parse", `origin/${w.branch}`))?.headline, r.headline);
  assert.equal(git(w.repo, "for-each-ref", "refs/notes/pr-receipts-remote"), ""); // temp ref cleaned up
  assert.throws(() => pushNotes(w.repo, "no-such-remote"), /no-such-remote/);
});

function eventFile(over: { fork?: boolean } = {}): string {
  const p = join(mkdtempSync(join(tmpdir(), "pr-receipts-event-")), "event.json");
  writeFileSync(
    p,
    JSON.stringify({
      action: "synchronize",
      pull_request: {
        number: 7,
        head: {
          sha: git(world.repo, "rev-parse", world.branch),
          repo: { full_name: over.fork ? "someone/example" : "agnij-dutta/example" },
        },
        base: { sha: git(world.repo, "rev-parse", "main"), repo: { full_name: "agnij-dutta/example" } },
      },
    }),
  );
  return p;
}

function mockFetch(existing: { id: number; body: string }[], status?: number) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined });
    const json = method === "GET" ? existing : method === "POST" ? { id: 999 } : {};
    return new Response(JSON.stringify(json), { status: status ?? (method === "POST" ? 201 : 200) });
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
  assert.deepEqual(
    first.calls.map((c) => c.method),
    ["GET", "POST"],
  );
  assert.ok(first.calls[1].url.endsWith("/repos/agnij-dutta/example/issues/7/comments"));

  const second = mockFetch([
    { id: 1, body: "unrelated" },
    { id: 42, body: `${STICKY_MARKER}\nold` },
  ]);
  const updated = await run(actionEnv(), second.f, () => {});
  assert.equal(updated.action, "update");
  assert.equal(updated.commentId, 42);
  assert.deepEqual(
    second.calls.map((c) => c.method),
    ["GET", "PATCH"],
  );
  assert.ok(second.calls[1].url.endsWith("/issues/comments/42"));
  for (const s of SECRETS) assert.ok(!second.calls[1].body!.includes(s));
});

test("action: an up-to-date comment is left alone; a quoted marker is never treated as ours", async () => {
  const body = (await run(actionEnv({ dryRun: true }), mockFetch([]).f, () => {})).body!;
  const same = mockFetch([{ id: 5, body }]);
  const plan = await run(actionEnv(), same.f, () => {});
  assert.equal(plan.action, "unchanged");
  assert.deepEqual(
    same.calls.map((c) => c.method),
    ["GET"],
  );

  const quoted = mockFetch([{ id: 6, body: `> ${STICKY_MARKER}\nquoting the bot` }]);
  assert.equal((await run(actionEnv(), quoted.f, () => {})).action, "create");
});

test("action: fork PRs are skipped with zero API calls; a 403 explains the permission", async () => {
  const { f, calls } = mockFetch([]);
  const plan = await run(actionEnv({ eventPath: eventFile({ fork: true }), missing: "comment" }), f, () => {});
  assert.equal(plan.reason, "fork");
  assert.equal(calls.length, 0);
  await assert.rejects(
    run(actionEnv(), mockFetch([], 403).f, () => {}),
    /pull-requests: write/,
  );
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
