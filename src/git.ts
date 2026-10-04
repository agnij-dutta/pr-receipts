import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function git(args: string[], cwd: string, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

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

export interface CommitInfo {
  sha: string;
  time: Date; // committer time
}

/** Commits in `range` (e.g. "main..feature"), oldest first. */
export function commitsIn(range: string, cwd: string): CommitInfo[] {
  const out = tryGit(["log", "--reverse", "--format=%H %cI", range], cwd);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, iso] = l.split(" ");
      return { sha, time: new Date(iso) };
    });
}

export function commitTime(ref: string, cwd: string): Date {
  return new Date(git(["show", "-s", "--format=%cI", ref], cwd));
}

export function revParse(ref: string, cwd: string): string {
  return git(["rev-parse", ref], cwd);
}
