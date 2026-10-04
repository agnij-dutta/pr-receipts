// Thin wrappers over the git CLI. Everything shells out with execFileSync and an
// argument array (never a shell string), so refs and paths are not interpreted.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Run git and return trimmed stdout. Throws with git's stderr in the message on failure. */
export function git(args: string[], cwd: string, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

/** Run git, returning null on any failure. Only for lookups where "not there" is a normal answer. */
export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Top-level directory of the worktree containing `cwd`. */
export function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/** Short name of the checked-out branch, or "HEAD" when detached. */
export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/** One checkout of the repository, as reported by `git worktree list`. */
export interface Worktree {
  path: string;
  branch: string | null; // short name, null when detached
  primary: boolean; // the main checkout (listed first by git)
}

/** Every worktree of the repo (main checkout, `git worktree add`, Claude Code `.claude/worktrees/*`). */
export function worktrees(cwd: string): Worktree[] {
  const out = tryGit(["worktree", "list", "--porcelain"], cwd);
  if (!out) return [{ path: repoRoot(cwd), branch: tryGit(["symbolic-ref", "--short", "HEAD"], cwd), primary: true }];
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, primary: list.length === 0 };
      list.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
  }
  // Also include realpaths (macOS /private/var vs /var etc.).
  for (const w of [...list]) {
    try {
      const rp = realpathSync(w.path);
      if (rp !== w.path) list.push({ ...w, path: rp });
    } catch {
      /* worktree dir may be gone */
    }
  }
  return list;
}

/** Best-effort base branch: origin/HEAD, then main, then master. */
export function detectBase(cwd: string): string | null {
  const originHead = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (originHead) return originHead;
  for (const c of ["origin/main", "main", "origin/master", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", c], cwd)) return c;
  }
  return null;
}

/** A commit with both timestamps; see `commitsIn` for why both are kept. */
export interface CommitInfo {
  sha: string;
  /** Committer time: when the commit object was (re)written. */
  time: Date;
  /** Author time: survives rebase, amend and cherry-pick. */
  authorTime: Date;
}

/**
 * Commits in `range` (e.g. "main..feature"), oldest first. Throws if the range
 * is invalid, because an empty list here would silently shrink the window.
 *
 * Both dates are kept because a rebase rewrites every committer date to "now":
 * using committer time alone would start the window at the rebase and drop
 * the work that produced the commits.
 */
export function commitsIn(range: string, cwd: string): CommitInfo[] {
  const out = git(["log", "--reverse", "--format=%H %cI %aI", range], cwd);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, committed, authored] = l.split(" ");
      return { sha, time: new Date(committed), authorTime: new Date(authored) };
    });
}

/** Committer time of `ref`. */
export function commitTime(ref: string, cwd: string): Date {
  return new Date(git(["show", "-s", "--format=%cI", ref], cwd));
}

/** Full SHA of `ref`. Throws if it does not resolve. */
export function revParse(ref: string, cwd: string): string {
  return git(["rev-parse", ref], cwd);
}
