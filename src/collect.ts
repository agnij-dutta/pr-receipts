import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { costOf, loadPricing, normalizeModel, type PricingTable } from "./pricing.js";
import {
  commitTime,
  commitsIn,
  currentBranch,
  detectBase,
  repoRoot,
  tryGit,
  worktrees,
  type CommitInfo,
  type Worktree,
} from "./git.js";
import { defaultProjectsDir, listTranscriptFiles, parseTranscripts, type ParsedTranscripts } from "./transcripts.js";
import type { MatchReason, MetaEvent, ModelLine, Receipt, UsageEvent } from "./types.js";
import { headlineFor } from "./format.js";

export const GENERATOR = "pr-receipts@0.1.0";
const IDLE_CAP_MS = 5 * 60 * 1000;

export interface MatchContext {
  repoName: string;
  /** Primary checkout path first, then other worktrees. */
  worktrees: Worktree[];
  branch: string;
  base: string | null;
  headSha: string | null;
  commitRange: string | null;
  commits: number;
  window: { start: Date; end: Date };
  includeTools: boolean;
  includeFilePaths: boolean;
  loose: boolean;
}

const isRealBranch = (b: string) => b !== "" && b !== "HEAD";

/** Longest worktree path containing `p`, so nested `.claude/worktrees/*` win over the main checkout. */
export function worktreeFor(p: string, wts: Worktree[]): Worktree | null {
  let best: Worktree | null = null;
  for (const w of wts) {
    if (p === w.path || p.startsWith(w.path.endsWith("/") ? w.path : w.path + "/")) {
      if (!best || w.path.length > best.path.length) best = w;
    }
  }
  return best;
}

const canonCache = new Map<string, string>();
/** realpath with a cache; transcripts record logical paths (/var/...) while git reports real ones (/private/var/...). */
export function canon(p: string): string {
  let c = canonCache.get(p);
  if (c === undefined) {
    try {
      c = realpathSync(p);
    } catch {
      // file may be gone: canonicalize the parent instead
      const parent = dirname(p);
      c = parent !== p ? join(canon(parent), basename(p)) : p;
    }
    canonCache.set(p, c);
  }
  return c;
}

type Verdict = MatchReason | "other-branch" | null;

/**
 * Decide whether one record belongs to the PR.
 *  branch: cwd is inside a dedicated worktree checked out on the target branch,
 *          or cwd is in the main checkout and transcript gitBranch == target.  (high confidence)
 *  cwd:    cwd is in the main checkout, gitBranch unknown ("HEAD": session was
 *          launched outside a git repo, or detached), record inside the window. (medium)
 *  other-branch: excluded; the record demonstrably ran on a different branch.
 *
 * Why worktree first: Claude Code stamps gitBranch from the directory the
 * session was LAUNCHED in. A session started in the main checkout that cd's
 * into .claude/worktrees/foo keeps the main checkout's branch name on every
 * record, so for dedicated worktrees the worktree's own branch is the truth.
 */
export function judge(rec: { cwd: string; gitBranch: string }, ctx: MatchContext): Verdict {
  if (!rec.cwd) return null;
  const wt = worktreeFor(rec.cwd, ctx.worktrees) ?? worktreeFor(canon(rec.cwd), ctx.worktrees);
  if (!wt) return null;
  if (!wt.primary && wt.branch) return wt.branch === ctx.branch ? "branch" : "other-branch";
  if (isRealBranch(rec.gitBranch)) return rec.gitBranch === ctx.branch ? "branch" : "other-branch";
  return "cwd";
}

export function buildReceipt(parsed: ParsedTranscripts, ctx: MatchContext, pricing: PricingTable): Receipt {
  const notes: string[] = [];
  const matched: { ev: UsageEvent; why: MatchReason }[] = [];
  const counts = { branch: 0, cwd: 0, files: 0, other: 0 };
  const sessionsMatched = new Set<string>();
  const repoPathOf = (p: string): string | null => {
    const wt = worktreeFor(p, ctx.worktrees) ? p : worktreeFor(canon(p), ctx.worktrees) ? canon(p) : null;
    if (!wt) return null;
    const w = worktreeFor(wt, ctx.worktrees)!;
    return relative(w.path, wt);
  };
  const inRepoFile = (p: string) => repoPathOf(p) !== null;

  const events = [...parsed.usage.values()];
  const unmatched: UsageEvent[] = [];
  for (const ev of events) {
    const v = judge(ev, ctx);
    if (v === "other-branch") {
      counts.other++;
      continue;
    }
    if (v) {
      matched.push({ ev, why: v });
      counts[v]++;
      sessionsMatched.add(ev.sessionId);
    } else {
      unmatched.push(ev);
    }
  }

  // Loose mode: a session launched outside the repo (cwd elsewhere) that edited
  // files inside the repo during the window contributes all its in-window
  // requests that are not attributable to another branch.
  if (ctx.loose) {
    const fileSessions = new Set(
      unmatched.filter((e) => [...e.filePaths].some(inRepoFile)).map((e) => e.sessionId),
    );
    for (const ev of unmatched) {
      if (!fileSessions.has(ev.sessionId)) continue;
      if (isRealBranch(ev.gitBranch) && ev.gitBranch !== ctx.branch) continue;
      matched.push({ ev, why: "files" });
      counts.files++;
      sessionsMatched.add(ev.sessionId);
    }
  }

  const metaMatched = parsed.meta.filter((m) => {
    const v = judge(m, ctx);
    if (v === "branch" || v === "cwd") return true;
    if (v === null && ctx.loose && sessionsMatched.has(m.sessionId) && !isRealBranch(m.gitBranch)) {
      // only sessions pulled in by file evidence reach here with cwd outside the repo
      return matched.some((x) => x.why === "files" && x.ev.sessionId === m.sessionId);
    }
    return false;
  });

  // Aggregate.
  const models = new Map<string, ModelLine>();
  const sessions = new Map<string, { id: string; requests: number; costUSD: number; firstSeen: string; lastSeen: string }>();
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  const unpriced = new Set<string>();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    costUSD: 0,
    apiRequests: 0,
    subagentRequests: 0,
    turns: 0,
    agentTimeMs: 0,
    activeTimeMs: 0,
    toolCalls: 0,
    apiErrors: 0,
    refusalFallbacks: 0,
    webSearches: 0,
  };

  for (const { ev } of matched) {
    const key = normalizeModel(ev.model);
    const cost = costOf(pricing, ev.model, ev, {
      speed: ev.speed,
      inferenceGeo: ev.inferenceGeo,
      webSearches: ev.webSearches,
    });
    if (cost === null) unpriced.add(key);
    const line =
      models.get(key) ??
      ({ model: key, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, costUSD: 0 } as ModelLine);
    line.requests++;
    line.inputTokens += ev.inputTokens;
    line.outputTokens += ev.outputTokens;
    line.cacheReadTokens += ev.cacheReadTokens;
    line.cacheWrite5mTokens += ev.cacheWrite5mTokens;
    line.cacheWrite1hTokens += ev.cacheWrite1hTokens;
    line.costUSD = cost === null ? null : (line.costUSD ?? 0) + cost;
    models.set(key, line);

    totals.inputTokens += ev.inputTokens;
    totals.outputTokens += ev.outputTokens;
    totals.cacheReadTokens += ev.cacheReadTokens;
    totals.cacheWrite5mTokens += ev.cacheWrite5mTokens;
    totals.cacheWrite1hTokens += ev.cacheWrite1hTokens;
    totals.costUSD += cost ?? 0;
    totals.apiRequests++;
    if (ev.isSidechain) totals.subagentRequests++;
    totals.refusalFallbacks += ev.refusalFallbacks;
    totals.webSearches += ev.webSearches;
    totals.toolCalls += ev.tools.size;
    for (const name of ev.tools.values()) toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    for (const p of ev.filePaths) {
      const rel = repoPathOf(p);
      if (rel) files.add(rel); // paths outside the repo are dropped entirely
    }

    const s =
      sessions.get(ev.sessionId) ??
      { id: ev.sessionId.slice(0, 8), requests: 0, costUSD: 0, firstSeen: ev.timestamp, lastSeen: ev.timestamp };
    s.requests++;
    s.costUSD += cost ?? 0;
    if (ev.timestamp && ev.timestamp < s.firstSeen) s.firstSeen = ev.timestamp;
    if (ev.timestamp > s.lastSeen) s.lastSeen = ev.timestamp;
    sessions.set(ev.sessionId, s);
  }

  for (const m of metaMatched) {
    if (m.kind === "prompt") totals.turns++;
    else if (m.kind === "turn") totals.agentTimeMs += m.durationMs ?? 0;
    else if (m.kind === "apiError") totals.apiErrors++;
  }
  totals.activeTimeMs = activeTime([
    ...matched.map((x) => x.ev.timestamp),
    ...metaMatched.map((m: MetaEvent) => m.timestamp),
  ]);

  // Confidence + caveats.
  const n = matched.length;
  let confidence: Receipt["mapping"]["confidence"] = "none";
  if (n > 0) {
    if (counts.branch / n >= 0.8) confidence = "high";
    else if (counts.files / n > 0.2) confidence = "low";
    else confidence = "medium";
  }
  if (counts.cwd > 0)
    notes.push(
      `${counts.cwd} request(s) matched by working directory + time window only (transcript gitBranch was "HEAD", usually because the session was launched outside the repo).`,
    );
  if (counts.files > 0) notes.push(`${counts.files} request(s) matched only because the session edited files in this repo (--loose).`);
  if (counts.other > 0) notes.push(`${counts.other} request(s) in this repo were excluded because they ran on another branch.`);
  if (unpriced.size) notes.push(`No price configured for: ${[...unpriced].join(", ")}. Their cost is counted as $0.`);
  if (totals.agentTimeMs === 0 && totals.activeTimeMs > 0)
    notes.push("No turn timings recorded; agent time is estimated from message timestamps (gaps over 5 min ignored).");

  const modelLines = [...models.values()].sort((a, b) => (b.costUSD ?? 0) - (a.costUSD ?? 0));
  const receipt: Receipt = {
    schema: "pr-receipts/v1",
    generatedAt: new Date().toISOString(),
    generator: GENERATOR,
    headline: "",
    repo: {
      name: ctx.repoName,
      branch: ctx.branch,
      base: ctx.base,
      headSha: ctx.headSha,
      commitRange: ctx.commitRange,
      commits: ctx.commits,
      window: { start: ctx.window.start.toISOString(), end: ctx.window.end.toISOString() },
    },
    totals: { ...totals, costUSD: round(totals.costUSD, 4) },
    models: modelLines.map((m) => ({ ...m, costUSD: m.costUSD === null ? null : round(m.costUSD, 4) })),
    files: { count: files.size, ...(ctx.includeFilePaths ? { paths: [...files].sort() } : {}) },
    sessions: [...sessions.values()]
      .map((s) => ({ ...s, costUSD: round(s.costUSD, 4) }))
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)),
    mapping: {
      byBranch: counts.branch,
      byCwd: counts.cwd,
      byFiles: counts.files,
      excludedOtherBranch: counts.other,
      confidence,
      notes,
    },
    pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, unpricedModels: [...unpriced] },
    privacy: { contentIncluded: false, toolCounts: ctx.includeTools, filePaths: ctx.includeFilePaths },
  };
  if (ctx.includeTools) {
    receipt.tools = Object.fromEntries(Object.entries(toolCounts).sort((a, b) => b[1] - a[1]));
  }
  receipt.headline = headlineFor(receipt);
  return receipt;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Wall-clock time covered by activity, merging parallel sessions, ignoring idle gaps > 5 min. */
export function activeTime(timestamps: string[]): number {
  const ts = timestamps
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= IDLE_CAP_MS) total += gap;
  }
  return total;
}

export interface CollectOptions {
  cwd: string;
  branch?: string;
  since?: string;
  base?: string;
  from?: string;
  to?: string;
  lookbackMinutes?: number;
  tailMinutes?: number;
  projectsDir?: string;
  pricingPath?: string;
  includeTools?: boolean;
  includeFilePaths?: boolean;
  loose?: boolean;
}

/** Resolve git context + time window, scan transcripts, and build the receipt. */
export async function collect(opts: CollectOptions): Promise<Receipt> {
  const root = repoRoot(opts.cwd);
  const branch = opts.branch ?? currentBranch(root);
  const wts = worktrees(root);

  let base: string | null = null;
  let range: string | null = null;
  let commits: CommitInfo[] = [];
  let start: Date | null = null;
  const lookback = (opts.lookbackMinutes ?? 120) * 60_000;
  const tail = (opts.tailMinutes ?? 15) * 60_000;

  if (opts.since) {
    range = `${opts.since}..${branch}`;
    commits = commitsIn(range, root);
    start = commitTime(opts.since, root);
  } else {
    base = opts.base ?? detectBase(root);
    if (base && tryGit(["rev-parse", base], root) !== tryGit(["rev-parse", branch], root)) {
      range = `${base}..${branch}`;
      commits = commitsIn(range, root);
      if (commits.length) start = new Date(commits[0].time.getTime() - lookback);
    }
  }
  if (opts.from) start = new Date(opts.from);
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const ctxBase = {
    repoName: basename(root),
    worktrees: wts,
    branch,
    base,
    headSha: tryGit(["rev-parse", branch], root),
    commitRange: range,
    commits: commits.length,
    includeTools: Boolean(opts.includeTools),
    includeFilePaths: opts.includeFilePaths !== false,
    loose: Boolean(opts.loose),
  };
  let derivedNote: string | null = null;
  if (!start) {
    // No commits ahead of base (already merged, or nothing committed yet): fall
    // back to the span of transcript records that are positively on this branch.
    const all = await parseTranscripts(listTranscriptFiles(projectsDir));
    const probe = { ...ctxBase, window: { start: new Date(0), end: new Date() } };
    const ts = [...all.usage.values()]
      .filter((e) => judge(e, probe) === "branch")
      .map((e) => Date.parse(e.timestamp))
      .filter((t) => !Number.isNaN(t));
    if (!ts.length) {
      throw new Error(
        `Cannot infer a time window for "${branch}": no commits ahead of ${base ?? "a base branch"} and no transcript records on that branch. Pass --since <commit>, --base <ref>, or --from <iso>.`,
      );
    }
    start = new Date(Math.min(...ts));
    if (!opts.to) opts = { ...opts, to: new Date(Math.max(...ts) + 1000).toISOString() };
    derivedNote = "Time window derived from transcript records on this branch (no commits ahead of base).";
  }
  let end: Date;
  if (opts.to) end = opts.to === "now" ? new Date() : new Date(opts.to);
  else if (commits.length) end = new Date(commits[commits.length - 1].time.getTime() + tail);
  else end = new Date();

  const pricing = loadPricing(opts.pricingPath);
  const files = listTranscriptFiles(projectsDir, start);
  const parsed = await parseTranscripts(files, { start, end });
  const receipt = buildReceipt(parsed, { ...ctxBase, window: { start, end } }, pricing);
  if (derivedNote) receipt.mapping.notes.unshift(derivedNote);
  return receipt;
}

