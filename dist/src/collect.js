// collect: resolve the git context and time window for a branch, scan the
// transcripts in that window, and hand them to attribution.ts.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { buildReceipt, judge } from "./attribution.js";
import { commitsIn, commitTime, currentBranch, detectBase, repoRoot, tryGit, worktrees, } from "./git.js";
import { loadPricing } from "./pricing.js";
import { defaultProjectsDir, listTranscriptFiles, parseTranscripts } from "./transcripts.js";
export { activeTime, buildReceipt, canon, GENERATOR, judge, worktreeFor } from "./attribution.js";
/** Parse a user-supplied date flag, failing loudly instead of producing an Invalid Date. */
function parseDate(value, flag) {
    const d = value === "now" ? new Date() : new Date(value);
    if (Number.isNaN(d.getTime()))
        throw new Error(`${flag} "${value}" is not a valid date. Use ISO 8601, e.g. 2026-10-04T09:30:00Z.`);
    return d;
}
function minutes(value, fallback, flag) {
    if (value === undefined)
        return fallback * 60_000;
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`${flag} must be a non-negative number of minutes.`);
    return value * 60_000;
}
function listCommits(range, root) {
    try {
        return commitsIn(range, root);
    }
    catch (err) {
        const why = err instanceof Error ? err.message.split("\n").find((l) => l.startsWith("fatal:")) : undefined;
        throw new Error(`Cannot list commits in ${range}${why ? ` (${why})` : ""}. Check --base / --since / --branch.`);
    }
}
/**
 * Drop listed paths that git ignores (.env.local, build output, scratch files).
 * They were not part of the PR, and their names alone can say more than the
 * author intended. The count still includes them.
 */
function dropIgnored(receipt, root) {
    const paths = receipt.files.paths;
    if (!paths?.length)
        return;
    // Exit 0: some paths ignored, 1: none ignored, anything else: a real failure.
    const res = spawnSync("git", ["check-ignore", "--stdin"], { cwd: root, input: paths.join("\n"), encoding: "utf8" });
    if (res.status !== 0 && res.status !== 1) {
        throw new Error(`git check-ignore failed (${res.stderr?.trim() || res.error?.message || `exit ${res.status}`}).`);
    }
    const ignored = new Set(res.stdout.split("\n").filter(Boolean));
    if (!ignored.size)
        return;
    receipt.files.paths = paths.filter((p) => !ignored.has(p));
    receipt.mapping.notes.push(`${ignored.size} gitignored path(s) touched by the agent are counted but not listed.`);
}
/**
 * Resolve git context + time window, scan transcripts, and build the receipt.
 *
 * Window, in order of precedence:
 *  1. --from / --to override either end.
 *  2. --since <commit>: from that commit's committer time.
 *  3. Commits in base..branch: earliest author-or-committer time minus the
 *     lookback, to the latest committer time plus the tail.
 *  4. No commits ahead of base: the span of transcript records that are
 *     positively on this branch (judge() === "branch").
 */
export async function collect(opts) {
    const root = repoRoot(opts.cwd);
    const branch = opts.branch ?? currentBranch(root);
    const wts = worktrees(root);
    let base = null;
    let range = null;
    let commits = [];
    let start = null;
    const lookback = minutes(opts.lookbackMinutes, 120, "--lookback");
    const tail = minutes(opts.tailMinutes, 15, "--tail");
    const to = opts.to ? parseDate(opts.to, "--to") : null;
    const from = opts.from ? parseDate(opts.from, "--from") : null;
    if (tryGit(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], root) === null) {
        throw new Error(`Branch "${branch}" does not exist in ${root}.`);
    }
    if (opts.since) {
        range = `${opts.since}..${branch}`;
        commits = listCommits(range, root);
        start = commitTime(opts.since, root);
    }
    else {
        base = opts.base ?? detectBase(root);
        if (base && tryGit(["rev-parse", base], root) !== tryGit(["rev-parse", branch], root)) {
            range = `${base}..${branch}`;
            commits = listCommits(range, root);
            if (commits.length) {
                const earliest = Math.min(...commits.map((c) => Math.min(c.time.getTime(), c.authorTime.getTime())));
                start = new Date(earliest - lookback);
            }
        }
    }
    if (from)
        start = from;
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
    let derivedNote = null;
    let derivedEnd = null;
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
            throw new Error(`Cannot infer a time window for "${branch}": no commits ahead of ${base ?? "a base branch"} and no transcript records on that branch. Pass --since <commit>, --base <ref>, or --from <iso>.`);
        }
        start = new Date(Math.min(...ts));
        derivedEnd = new Date(Math.max(...ts) + 1000);
        derivedNote = "Time window derived from transcript records on this branch (no commits ahead of base).";
    }
    let end;
    if (to)
        end = to;
    else if (derivedEnd)
        end = derivedEnd;
    else if (commits.length)
        end = new Date(Math.max(...commits.map((c) => c.time.getTime())) + tail);
    else
        end = new Date();
    if (end.getTime() < start.getTime()) {
        throw new Error(`Time window is empty: ${start.toISOString()} is after ${end.toISOString()}. Check --from / --to.`);
    }
    const pricing = loadPricing(opts.pricingPath);
    const files = listTranscriptFiles(projectsDir, start);
    const parsed = await parseTranscripts(files, { start, end });
    const receipt = buildReceipt(parsed, { ...ctxBase, window: { start, end } }, pricing);
    if (derivedNote)
        receipt.mapping.notes.unshift(derivedNote);
    dropIgnored(receipt, root);
    return receipt;
}
