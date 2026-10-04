# Security and privacy policy

pr-receipts reads Claude Code transcripts, which can contain prompts, source code, command output and credentials. Its core promise is that none of that content leaves your machine: only usage metadata reaches a receipt, a git note or a PR comment. A break in that promise is the most important kind of bug here.

## Reporting

Please report privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/agnij-dutta/pr-receipts/security/advisories/new). Do not open a public issue for these.

Include the version (`pr-receipts --version`), what you ran, and what leaked or broke. Do not attach real transcripts. A synthetic record that reproduces the problem is ideal; `test/fixtures/generate.ts` shows the record shapes.

You should get a reply within 7 days. Fixes for confirmed leaks are released as soon as they are ready, with credit if you want it.

## In scope

- Any transcript content (prompt text, assistant text, thinking, tool inputs, tool results, session titles) reaching `receipt.json`, a git note, the rendered Markdown, the Action's log, step summary or outputs, or a PR comment.
- Absolute paths, paths outside the repo, or paths outside the target branch's checkout reaching a receipt.
- Tool names reaching a receipt without `--include-tools`.
- A crafted git note or receipt file that gets past `sanitizeReceipt` and renders unescaped Markdown or HTML, pings users, or injects extra Action outputs.
- The Action using more than `pull-requests: write`, calling the GitHub API in dry-run, or overwriting a comment it doesn't own.
- Command injection through branch names, refs, paths or Action inputs.

## Not in scope (known non-goals)

- **The numbers are not authenticated.** Anyone who can push to `refs/notes/pr-receipts` can attach a receipt with any totals. Receipts are a reporting aid, not an audit trail.
- **Metadata is visible by design**: repo-relative paths of files the agent touched (unless `--no-file-paths`), model names, token counts, 8-character session id prefixes, branch names and timestamps.
- **Cost accuracy.** The cost is a lower bound at list prices (see the README). Under-reporting is a limitation, not a vulnerability.
- Anything that requires an attacker who can already read your `~/.claude` directory.
