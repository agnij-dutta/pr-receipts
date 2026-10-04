// Receipt storage: git notes under refs/notes/pr-receipts, attached to the
// branch head commit. See README "Why git notes" for the trade-offs.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, tryGit } from "./git.js";
import { sanitizeReceipt } from "./render.js";
/** Notes ref receipts live under: refs/notes/pr-receipts. */
export const DEFAULT_NOTES_REF = "pr-receipts";
const fullRef = (ref) => (ref.startsWith("refs/") ? ref : `refs/notes/${ref}`);
/** Store `receipt` as the note on `commit`, replacing any previous receipt there. */
export function writeNote(cwd, commit, receipt, ref = DEFAULT_NOTES_REF) {
    const body = `${JSON.stringify(receipt, null, 2)}\n`;
    git(["notes", `--ref=${fullRef(ref)}`, "add", "-f", "-F", "-", commit], cwd, body);
}
/**
 * Read and sanitize the receipt on `commit`, or null if that commit has no note.
 * A note that exists but is not a valid receipt throws: reporting "no receipt"
 * there would hide a corrupted or tampered note.
 */
export function readNote(cwd, commit, ref = DEFAULT_NOTES_REF) {
    const raw = tryGit(["notes", `--ref=${fullRef(ref)}`, "show", commit], cwd);
    if (!raw)
        return null;
    try {
        return sanitizeReceipt(JSON.parse(raw));
    }
    catch (err) {
        throw new Error(`The ${fullRef(ref)} note on ${commit.slice(0, 12)} is not a valid receipt (${err instanceof Error ? err.message : String(err)}). Re-run \`pr-receipts attach\` or remove it with \`git notes --ref=${fullRef(ref)} remove ${commit.slice(0, 12)}\`.`);
    }
}
/**
 * Newest receipt among commits in `base..head` (head first). Receipts are
 * cumulative for the branch, so the newest one is the whole PR. Commits pushed
 * after the last attach simply aren't counted yet.
 */
export function findReceipt(cwd, head, base, ref = DEFAULT_NOTES_REF) {
    for (const [label, rev] of [
        ["head", head],
        ["base", base],
    ]) {
        if (rev && tryGit(["cat-file", "-e", `${rev}^{commit}`], cwd) === null) {
            // In CI this is almost always a shallow checkout; treating it as "no receipt" would hide the cause.
            throw new Error(`PR ${label} commit ${rev.slice(0, 12)} is not in this clone. Check out with \`fetch-depth: 0\` so the PR's commits (and their notes) are available.`);
        }
    }
    const range = base ? `${base}..${head}` : head;
    const list = git(["rev-list", "--max-count=200", range], cwd);
    for (const sha of list.split("\n").filter(Boolean)) {
        const r = readNote(cwd, sha, ref);
        if (r)
            return { commit: sha, receipt: r };
    }
    return null;
}
/**
 * Push the notes ref. If the push is rejected because the remote ref moved
 * (another machine attached a receipt), fetch theirs, merge it into ours with
 * the "ours" strategy (on the same commit, our receipt wins), and push again.
 * Other failures (auth, network) are rethrown as-is.
 */
export function pushNotes(cwd, remote = "origin", ref = DEFAULT_NOTES_REF) {
    const r = fullRef(ref);
    try {
        git(["push", remote, `${r}:${r}`], cwd);
        return;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/rejected|non-fast-forward|fetch first/i.test(msg))
            throw err;
    }
    const tmp = `${r}-remote`;
    try {
        git(["fetch", remote, `+${r}:${tmp}`], cwd);
        git(["notes", `--ref=${r}`, "merge", "-s", "ours", tmp], cwd);
        git(["push", remote, `${r}:${r}`], cwd);
    }
    finally {
        tryGit(["update-ref", "-d", tmp], cwd);
    }
}
const HOOK_MARK = "# pr-receipts hook";
/**
 * Install a pre-push hook that attaches a receipt to the head being pushed and
 * pushes the notes ref alongside. Git has no post-push hook; pre-push runs right
 * before the branch goes up, which is the moment we want. The env guard stops
 * the inner `git push` of the notes ref from re-triggering the hook.
 *
 * The hook attaches to the CURRENT branch, which is what `git push` pushes in
 * the common case. It never blocks the push: a failed attach is logged only.
 * If an existing hook ends with `exit`, the appended snippet will not run.
 */
export function installHook(cwd, bin = "pr-receipts") {
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
        if (cur.includes(HOOK_MARK))
            return path;
        writeFileSync(path, `${cur.trimEnd()}\n\n${snippet}`);
    }
    else {
        writeFileSync(path, `#!/bin/sh\n${snippet}`);
    }
    chmodSync(path, 0o755);
    return path;
}
