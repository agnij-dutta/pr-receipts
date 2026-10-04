// Receipt storage: git notes under refs/notes/pr-receipts, attached to the
// branch head commit. See README "Why git notes" for the trade-offs.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, tryGit } from "./git.js";
import { sanitizeReceipt } from "./render.js";
import type { Receipt } from "./types.js";

export const DEFAULT_NOTES_REF = "pr-receipts";

const fullRef = (ref: string) => (ref.startsWith("refs/") ? ref : `refs/notes/${ref}`);

export function writeNote(cwd: string, commit: string, receipt: Receipt, ref = DEFAULT_NOTES_REF): void {
  const body = JSON.stringify(receipt, null, 2) + "\n";
  git(["notes", `--ref=${fullRef(ref)}`, "add", "-f", "-F", "-", commit], cwd, body);
}

export function readNote(cwd: string, commit: string, ref = DEFAULT_NOTES_REF): Receipt | null {
  const raw = tryGit(["notes", `--ref=${fullRef(ref)}`, "show", commit], cwd);
  if (!raw) return null;
  try {
    return sanitizeReceipt(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Newest receipt among commits in `base..head` (head first). Receipts are
 * cumulative for the branch, so the newest one is the whole PR. Commits pushed
 * after the last attach simply aren't counted yet.
 */
export function findReceipt(
  cwd: string,
  head: string,
  base: string | null,
  ref = DEFAULT_NOTES_REF,
): { commit: string; receipt: Receipt } | null {
  const range = base ? `${base}..${head}` : head;
  const list = tryGit(["rev-list", "--max-count=200", range], cwd);
  if (!list) return null;
  for (const sha of list.split("\n").filter(Boolean)) {
    const r = readNote(cwd, sha, ref);
    if (r) return { commit: sha, receipt: r };
  }
  return null;
}

/** Push the notes ref. If the remote has diverged, merge theirs into ours (ours wins per commit) and retry. */
export function pushNotes(cwd: string, remote = "origin", ref = DEFAULT_NOTES_REF): void {
  const r = fullRef(ref);
  try {
    git(["push", remote, `${r}:${r}`], cwd);
    return;
  } catch {
    const tmp = `refs/notes/${ref.replace(/^refs\/notes\//, "")}-remote`;
    git(["fetch", remote, `+${r}:${tmp}`], cwd);
    git(["notes", `--ref=${r}`, "merge", "-s", "ours", tmp], cwd);
    git(["push", remote, `${r}:${r}`], cwd);
  }
}

const HOOK_MARK = "# pr-receipts hook";

/**
 * Install a pre-push hook that attaches a receipt to the head being pushed and
 * pushes the notes ref alongside. Git has no post-push hook; pre-push runs right
 * before the branch goes up, which is the moment we want. The env guard stops
 * the inner `git push` of the notes ref from re-triggering the hook.
 */
export function installHook(cwd: string, bin = "pr-receipts"): string {
  const hooksDir = git(["rev-parse", "--git-path", "hooks"], cwd);
  const abs = hooksDir.startsWith("/") ? hooksDir : join(git(["rev-parse", "--show-toplevel"], cwd), hooksDir);
  const path = join(abs, "pre-push");
  const snippet = `${HOOK_MARK}
if [ -z "$PR_RECEIPTS_IN_HOOK" ]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "HEAD" ] && [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
    PR_RECEIPTS_IN_HOOK=1 ${bin} attach --branch "$branch" --push --remote "$1" >&2 || echo "pr-receipts: attach failed (push continues)" >&2
  fi
fi
`;
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (cur.includes(HOOK_MARK)) return path;
    writeFileSync(path, cur.trimEnd() + "\n\n" + snippet);
  } else {
    writeFileSync(path, "#!/bin/sh\n" + snippet);
  }
  chmodSync(path, 0o755);
  return path;
}
