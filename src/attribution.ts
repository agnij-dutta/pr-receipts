// Attribution: decide which deduplicated API requests belong to a branch, then
// aggregate them into a Receipt. Pure apart from realpath lookups, so the
// rules can be tested without git. Window resolution lives in collect.ts.

import { realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { headlineFor } from "./format.js";
import type { Worktree } from "./git.js";
import { costOf, normalizeModel, type PricingTable } from "./pricing.js";
import type { ParsedTranscripts } from "./transcripts.js";
import type { MatchReason, MetaEvent, ModelLine, Receipt, SessionLine, UsageEvent } from "./types.js";

/** Version string stamped into every receipt. Kept in sync with package.json by a test. */
export const GENERATOR = "pr-receipts@0.1.0";

/** Gaps longer than this between consecutive records count as idle, not agent time. */
const IDLE_CAP_MS = 5 * 60 * 1000;

/** Everything attribution needs to know about the repo and the PR. */
export interface MatchContext {
  repoName: string;
  /** Primary checkout first, then other worktrees (plus realpath aliases). */
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

/** Claude Code writes "HEAD" when the launch directory was detached or not a git repo. */
const isRealBranch = (b: string) => b !== "" && b !== "HEAD";

/** Longest worktree path containing `p`, so nested `.claude/worktrees/*` win over the main checkout. */
export function worktreeFor(p: string, wts: Worktree[]): Worktree | null {
  let best: Worktree | null = null;
  for (const w of wts) {
    if (p === w.path || p.startsWith(w.path.endsWith("/") ? w.path : `${w.path}/`)) {
      if (!best || w.path.length > best.path.length) best = w;
    }
  }
  return best;
}

const canonCache = new Map<string, string>();

/**
 * realpath with a cache. Transcripts record logical paths (/var/...) while git
 * reports real ones (/private/var/... on macOS), so both forms are tried.
 */
export function canon(p: string): string {
  let c = canonCache.get(p);
  if (c === undefined) {
    try {
      c = realpathSync(p);
    } catch {
      // The file may be gone: canonicalize the parent instead.
      const parent = dirname(p);
      c = parent !== p ? join(canon(parent), basename(p)) : p;
    }
    canonCache.set(p, c);
  }
  return c;
}

/** Worktree containing `p` under either its logical or its real path. */
function locate(p: string, wts: Worktree[]): { wt: Worktree; path: string } | null {
  const direct = worktreeFor(p, wts);
  if (direct) return { wt: direct, path: p };
  const real = canon(p);
  const viaReal = worktreeFor(real, wts);
  return viaReal ? { wt: viaReal, path: real } : null;
}

/** Outcome of judging one record: a match reason, a positive exclusion, or "not this repo". */
export type Verdict = MatchReason | "other-branch" | null;

/**
 * Decide whether one record belongs to the PR.
 *  branch: cwd is inside a dedicated worktree checked out on the target branch,
 *          or cwd is in the main checkout and transcript gitBranch == target.  (high confidence)
 *  cwd:    cwd is in the main checkout, gitBranch unknown ("HEAD": session was
 *          launched outside a git repo, or detached), record inside the window. (medium)
 *  other-branch: excluded; the record demonstrably ran on a different branch.
 *  null:   cwd is not in this repo at all.
 *
 * Why worktree first: Claude Code stamps gitBranch from the directory the
 * session was LAUNCHED in. A session started in the main checkout that cd's
 * into .claude/worktrees/foo keeps the main checkout's branch name on every
 * record, so for dedicated worktrees the worktree's own branch is the truth.
 */
export function judge(rec: { cwd: string; gitBranch: string }, ctx: MatchContext): Verdict {
  if (!rec.cwd) return null;
  const hit = locate(rec.cwd, ctx.worktrees);
  if (!hit) return null;
  const { wt } = hit;
  if (!wt.primary && wt.branch) return wt.branch === ctx.branch ? "branch" : "other-branch";
  if (isRealBranch(rec.gitBranch)) return rec.gitBranch === ctx.branch ? "branch" : "other-branch";
  return "cwd";
}

/**
 * The checkouts where the target branch's files live: its dedicated worktree(s)
 * if it has one, otherwise the main checkout. Files edited anywhere else (for
 * example a sibling worktree on another branch) are not evidence for this PR
 * and are never listed on its receipt.
 */
function fileScope(ctx: MatchContext): Worktree[] {
  const dedicated = ctx.worktrees.filter((w) => !w.primary && w.branch === ctx.branch);
  return dedicated.length ? dedicated : ctx.worktrees.filter((w) => w.primary);
}

/** Repo-relative path of `p` if it is inside the target branch's checkout, else null. */
function makeRepoPathOf(ctx: MatchContext): (p: string) => string | null {
  const scope = new Set(fileScope(ctx).map((w) => w.path));
  return (p) => {
    const hit = locate(p, ctx.worktrees);
    // The innermost worktree must be in scope: a file under .claude/worktrees/other
    // also sits inside the main checkout's directory, but belongs to "other".
    if (!hit || !scope.has(hit.wt.path)) return null;
    const rel = relative(hit.wt.path, hit.path);
    return rel && !rel.startsWith("..") ? rel : null;
  };
}

/**
 * Build a receipt from parsed transcripts. `parsed` must already be restricted
 * to the time window; this function only applies the location/branch rules.
 */
export function buildReceipt(parsed: ParsedTranscripts, ctx: MatchContext, pricing: PricingTable): Receipt {
  const notes: string[] = [];
  const matched: { ev: UsageEvent; why: MatchReason }[] = [];
  const counts = { branch: 0, cwd: 0, files: 0, other: 0 };
  const repoPathOf = makeRepoPathOf(ctx);

  const unmatched: UsageEvent[] = [];
  for (const ev of parsed.usage.values()) {
    const verdict = judge(ev, ctx);
    if (verdict === "other-branch") {
      counts.other++;
    } else if (verdict) {
      matched.push({ ev, why: verdict });
      counts[verdict]++;
    } else {
      unmatched.push(ev);
    }
  }

  // Loose mode: a session whose cwd is outside the repo (launched from a parent
  // folder, say) but that edited files in the target branch's checkout during
  // the window contributes its in-window requests. Records whose gitBranch names
  // a different branch are still left out; a matching or unknown label is kept.
  const looseOk = (gitBranch: string) => !isRealBranch(gitBranch) || gitBranch === ctx.branch;
  const looseSessions = new Set<string>();
  if (ctx.loose) {
    for (const ev of unmatched) {
      if ([...ev.filePaths].some((p) => repoPathOf(p) !== null)) looseSessions.add(ev.sessionId);
    }
    for (const ev of unmatched) {
      if (!looseSessions.has(ev.sessionId) || !looseOk(ev.gitBranch)) continue;
      matched.push({ ev, why: "files" });
      counts.files++;
    }
  }

  const metaMatched = parsed.meta.filter((m) => {
    const verdict = judge(m, ctx);
    if (verdict === "branch" || verdict === "cwd") return true;
    return verdict === null && looseSessions.has(m.sessionId) && looseOk(m.gitBranch);
  });

  // Aggregate.
  const models = new Map<string, ModelLine>();
  const sessions = new Map<string, SessionLine>();
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  const unpriced = new Set<string>();
  const totals: Receipt["totals"] = {
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
    const line: ModelLine = models.get(key) ?? {
      model: key,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      costUSD: 0,
    };
    line.requests++;
    line.inputTokens += ev.inputTokens;
    line.outputTokens += ev.outputTokens;
    line.cacheReadTokens += ev.cacheReadTokens;
    line.cacheWrite5mTokens += ev.cacheWrite5mTokens;
    line.cacheWrite1hTokens += ev.cacheWrite1hTokens;
    // A model is either priced or not, so a line never mixes the two.
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
      if (rel) files.add(rel); // paths outside the branch's checkout are dropped entirely
    }

    const s = sessions.get(ev.sessionId) ?? {
      id: ev.sessionId.slice(0, 8),
      requests: 0,
      costUSD: 0,
      firstSeen: ev.timestamp,
      lastSeen: ev.timestamp,
    };
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
  if (counts.files > 0)
    notes.push(`${counts.files} request(s) matched only because the session edited files in this repo (--loose).`);
  if (counts.other > 0)
    notes.push(`${counts.other} request(s) in this repo were excluded because they ran on another branch.`);
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

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Wall-clock time covered by activity, ignoring idle gaps over 5 minutes.
 * Timestamps from parallel sessions are merged into one timeline, so two
 * agents working at once count once (unlike summed turn durations).
 */
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
