# pr-receipts

**Every agent-written pull request gets a receipt.**

> This PR cost $6.92 and 35 minutes of agent time.

`pr-receipts` reads the usage metadata Claude Code already writes to `~/.claude/projects`, works out which API calls belong to a branch, prices them, and stores the result next to the commits as a git note. A GitHub Action then posts it on the PR as one sticky comment: models, input/output/cache tokens, dollars, agent time, turns, retries, tool calls, files touched.

It never reads out prompts, code, or tool output. Only numbers, ids, timestamps, model names, and (opt-in) tool names.

See [`examples/agnij-me.receipt.md`](examples/agnij-me.receipt.md) for a real receipt generated on this machine.

## Quickstart

```bash
npm install && npm run build
npm link                      # puts `pr-receipts` on PATH

cd ~/code/some-repo
git checkout feature/thing    # a branch an agent worked on
pr-receipts collect           # -> receipt.json
pr-receipts render            # -> markdown on stdout
pr-receipts attach --push     # store as a git note on HEAD and push refs/notes/pr-receipts
pr-receipts install-hook      # or: do the attach + push automatically on every `git push`
```

Then add [`examples/workflow.yml`](examples/workflow.yml) to the repo as `.github/workflows/pr-receipts.yml`.

### Commands

| Command | What it does |
|---|---|
| `collect [--branch b] [--since <commit>] [--base ref] [--from iso] [--to iso\|now]` | Find matching sessions, aggregate, write `receipt.json` |
| `render [--in receipt.json] [--sticky]` | Markdown receipt (headline + table) |
| `attach [--in receipt.json] [--push] [--remote origin]` | Write the receipt as a git note on the branch head, optionally push the notes ref |
| `show [--commit sha] [--json]` | Read back the receipt stored in notes |
| `install-hook` | Add a `pre-push` hook that runs `attach --push` for non-main branches |
| `comment --event event.json --dry-run` | Run the GitHub Action logic locally, print the comment, call nothing |

Flags: `--include-tools` (per-tool counts, opt-in), `--no-file-paths` (count only), `--loose` (see mapping), `--projects-dir`, `--pricing <file>`, `--notes-ref`.

## How a session is mapped to a PR

Claude Code writes one JSONL file per session, plus `<session>/subagents/*.jsonl` for subagents. Every `assistant` record carries `message.usage` (input, output, `cache_read_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens`, `speed`, `server_tool_use`), `message.model`, `timestamp`, `cwd`, `gitBranch`, `sessionId`, `isSidechain`. `system` records carry `turn_duration` (with `durationMs`) and `api_error` (retries).

Attribution is per API request, not per session, because one session often spans several branches.

1. **Repo and worktrees.** `git worktree list` gives the main checkout plus every worktree, including Claude Code's `.claude/worktrees/*`.
2. **Time window.** Commits in `base..branch` (base = `origin/HEAD`, `main`, or `master`). Window = first commit minus 2h lookback, to last commit plus 15 min. `--since <commit>` starts at that commit instead; `--from/--to` override. If the branch has no commits ahead of base (already merged), the window is derived from transcript records that are provably on the branch.
3. **Per request:**
   - cwd inside a **dedicated worktree** on the target branch: match (`branch`). On a different branch: excluded.
   - cwd inside the **main checkout** and `gitBranch` equals the branch: match (`branch`). Another branch name: excluded.
   - cwd inside the main checkout, `gitBranch` is `HEAD` (session launched outside git, or detached): match by `cwd` + window.
   - `--loose`: a session launched elsewhere that **edited files in the repo** during the window contributes its in-window requests (`files`).
4. Streamed records are deduplicated by `message.id` (Claude Code writes one record per content block, all with the same usage). `<synthetic>` placeholders are skipped.
5. The receipt reports how many requests matched by each rule and a confidence label (`high` when 80%+ matched by branch).

### Where it can be wrong

Found by running it against real transcripts on this machine:

- **`gitBranch` is the launch directory's branch, not the cwd's.** A session started in the main checkout that `cd`s into `.claude/worktrees/foo` stamps every record with the main checkout's branch. That is why dedicated worktrees win over `gitBranch`. In the main checkout, if the agent runs `git checkout other-branch` mid-session, records can carry a stale label.
- **Sessions launched from a parent folder** (e.g. `~/Desktop`) record `gitBranch: "HEAD"` and a cwd outside the repo, so they don't match at all unless `--loose` sees file edits. Bash-driven edits (`sed`, `cat >`) are invisible to `--loose`.
- **Parallel work in the main checkout.** Two sessions in the same checkout on `HEAD` during the same window are indistinguishable; both count.
- **Time window edges.** Planning done more than 2h before the first commit, or work after the last commit, falls outside. Tune with `--lookback`, `--from`, `--to now`.
- **Transcripts expire.** Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default). Attach at push time, not weeks later. This is the main reason receipts are written at push time instead of computed on demand.
- **It is a lower bound.** Claude Code makes side calls that never land in the transcript (session titles, away summaries, the auto-mode permission classifier). On one 81-minute session here, the transcript-derived cost was $12.20 while Claude Code's own `cost-state` record said $14.45 (about 16% under). Refusal fallbacks are priced at the final iteration only.
- **List prices.** On a Pro/Max subscription this is the API-equivalent cost, not what you paid.

## Why git notes (and not `.receipts/<branch>.json`)

CI can't read `~/.claude`, so the receipt has to travel with the push. The two options:

| | git notes (`refs/notes/pr-receipts`) | committed `.receipts/<branch>.json` |
|---|---|---|
| PR diff | untouched | an extra JSON file in every PR |
| Merge conflicts | none (one note per commit) | yes, when branches stack |
| Main history | clean | receipts merged into main forever |
| Keyed to | exact commit SHA | branch name (renames break it) |
| CI cost | one `git fetch` of the notes ref | none |
| Forks | notes don't travel with fork PRs | works |
| Squash merge | note stays on the PR's commits, comment already posted | file lands on main |

Notes win for the use case here: agents pushing branches to repos you own. The receipt is cumulative for the branch, and the action uses the newest note among the PR's commits, so commits pushed after the last attach just aren't counted yet. Notes are not pushed or fetched by default: `attach --push` pushes the ref (merging with `-s ours` if the remote diverged), and the action fetches it.

## GitHub Action

Composite action, no dependencies, runs the committed `dist/`:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: agnij-dutta/pr-receipts@v0
  with:
    dry-run: "false"        # "true" renders into the log + step summary and calls nothing
    on-missing: skip        # or "comment"
```

It fetches `refs/notes/pr-receipts`, finds the newest receipt on `base..head`, renders it, and upserts one comment identified by a hidden `<!-- pr-receipts:sticky -->` marker (PATCH if present, POST otherwise). Outputs: `cost-usd`, `headline`. Needs `pull-requests: write`. On `pull_request` from forks the token is read-only, so it will fail to comment there.

Tested locally with unit tests over a mocked `fetch` (create, then update in place; dry run makes zero calls) and an integration test that executes the action entrypoint with the same env a runner sets. `act` was not available on this machine.

## Privacy

- `src/transcripts.ts` is the only code that touches raw lines. It copies out numbers, ids, timestamps, cwd/branch, tool **names**, and `file_path` from Edit/Write/MultiEdit/NotebookEdit. Prompt text, assistant text, thinking, tool inputs, and tool results are never copied.
- File paths outside the repo are dropped; inside paths are made repo-relative. `--no-file-paths` keeps only the count.
- Per-tool counts are opt-in (`--include-tools`) because MCP tool names reveal which services an agent touched (`mcp__gmail__send_email`).
- Receipts read back from notes go through `sanitizeReceipt`: unknown keys, absolute paths, and un-opted fields are stripped before rendering.
- Tests plant fake secrets in prompts, thinking, tool inputs, tool results, titles, and a Write to `~/.aws/credentials`, then assert none reach the receipt or the comment.
- `scripts/leak-check.mjs <receipt.json> <receipt.md>` re-reads the named sessions and checks that no 24-char window of any content string appears in the output (prints counts only). The committed example passes: 2,249 strings checked, 0 found.

## Pricing

[`config/pricing.json`](config/pricing.json) is a table, not truth: per-model input, 5m/1h cache writes, cache reads, output, fast mode, with the source URL (`platform.claude.com/docs/en/about-claude/pricing`) and fetch date (2026-10-04). Modeled: per-model cache-read multipliers (0.1x standard, 0.05x Opus 5.5, 0.025x Fable 5.1), fast mode with cache multipliers stacked, `inference_geo: us` at 1.1x, web search at $10/1000. Unknown models are reported as unpriced, never guessed. Override with `--pricing`.

## How this differs from ccusage

[ccusage](https://github.com/ryoppippi/ccusage) is the standard tool for reading these same JSONL files: daily, monthly, per-session, and 5-hour-block reports across many agent CLIs. It answers "what did I spend this week?". `pr-receipts` answers "what did **this PR** cost?":

- **Per-PR attribution**: requests are joined to a branch through worktrees, `gitBranch`, cwd, and the commit window, with exclusions and a confidence label, rather than grouped by day or session.
- **Travels with the code**: the receipt is stored on the commits (git notes) so CI can use it without access to your machine.
- **Lands on the PR**: a sticky, idempotent GitHub comment, plus agent time, turns, retries, tool calls, and files touched.

## Development

```bash
npm test          # tsc build + node:test (21 tests, synthetic fixtures)
npm run fixtures  # write a synthetic transcript world to test/fixtures/generated/
```

Fixtures are generated by `test/fixtures/generate.ts` to match the real record shapes (streamed duplicates, subagent files, `cost-state`, `ai-title`, `turn_duration`, `api_error`, refusal-fallback iterations, fast mode). Nothing is copied from a real transcript.

`dist/src` is committed so the action runs without a build step. Rebuild before tagging.
