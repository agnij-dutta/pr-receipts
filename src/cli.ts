#!/usr/bin/env node
// pr-receipts CLI. Thin: parses flags and calls collect / notes / render / action.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { envFromProcess, run } from "./action/main.js";
import { type CollectOptions, collect, GENERATOR } from "./collect.js";
import { currentBranch, detectBase, repoRoot, revParse, tryGit } from "./git.js";
import { DEFAULT_NOTES_REF, findReceipt, installHook, pushNotes, readNote, writeNote } from "./notes.js";
import { renderMarkdown, sanitizeReceipt } from "./render.js";
import type { Receipt } from "./types.js";

const HELP = `pr-receipts: what did this PR cost in agent time and tokens?

Usage:
  pr-receipts collect [--branch <b>] [--since <commit>] [--base <ref>] [--from <iso>] [--to <iso|now>]
                      [--lookback <min>] [--tail <min>] [--include-tools] [--no-file-paths] [--loose]
                      [--out receipt.json]
  pr-receipts render  [--in receipt.json] [--sticky]          Markdown receipt to stdout
  pr-receipts attach  [--branch <b>] [collect flags] [--in receipt.json] [--push] [--remote origin]
  pr-receipts show    [--commit <sha>] [--branch <b>] [--base <ref>] [--json]
                                                                Render the receipt stored in git notes
  pr-receipts install-hook                                      Add a pre-push hook that attaches + pushes receipts
  pr-receipts comment --event <event.json> [--dry-run]          Run the GitHub Action logic locally
  pr-receipts --version

Common flags:
  --repo <path>        Repository (default: cwd)
  --projects-dir <p>   Claude Code transcripts dir (default: ~/.claude/projects)
  --pricing <file>     Pricing table JSON (default: bundled config/pricing.json)
  --notes-ref <ref>    Notes ref (default: ${DEFAULT_NOTES_REF})

Privacy: only usage metadata is read out of transcripts. Prompts, code, and tool output
are never stored. Per-tool counts are opt-in (--include-tools).`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(GENERATOR.replace("pr-receipts@", ""));
    return 0;
  }
  const { values: v } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      repo: { type: "string" },
      branch: { type: "string" },
      since: { type: "string" },
      base: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      lookback: { type: "string" },
      tail: { type: "string" },
      "projects-dir": { type: "string" },
      pricing: { type: "string" },
      "include-tools": { type: "boolean" },
      "no-file-paths": { type: "boolean" },
      loose: { type: "boolean" },
      out: { type: "string" },
      in: { type: "string" },
      sticky: { type: "boolean" },
      push: { type: "boolean" },
      remote: { type: "string" },
      commit: { type: "string" },
      "notes-ref": { type: "string" },
      event: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const cwd = v.repo ?? process.cwd();
  const notesRef = v["notes-ref"] ?? DEFAULT_NOTES_REF;
  const minutesFlag = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0)
      throw new Error(`--${name} must be a non-negative number of minutes, got "${raw}".`);
    return n;
  };
  const collectOpts = (): CollectOptions => ({
    cwd,
    branch: v.branch,
    since: v.since,
    base: v.base,
    from: v.from,
    to: v.to,
    lookbackMinutes: minutesFlag("lookback", v.lookback),
    tailMinutes: minutesFlag("tail", v.tail),
    projectsDir: v["projects-dir"],
    pricingPath: v.pricing,
    includeTools: v["include-tools"],
    includeFilePaths: !v["no-file-paths"],
    loose: v.loose,
  });
  const readReceipt = (p: string): Receipt => sanitizeReceipt(JSON.parse(readFileSync(p, "utf8")));

  switch (cmd) {
    case "collect": {
      const r = await collect(collectOpts());
      const out = v.out ?? "receipt.json";
      writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
      console.error(`${r.headline}  (${r.totals.apiRequests} requests, confidence ${r.mapping.confidence}) -> ${out}`);
      return 0;
    }
    case "render": {
      const r = readReceipt(v.in ?? "receipt.json");
      process.stdout.write(renderMarkdown(r, { sticky: v.sticky }));
      return 0;
    }
    case "attach": {
      const root = repoRoot(cwd);
      const branch = v.branch ?? currentBranch(root);
      const r = v.in ? readReceipt(v.in) : await collect({ ...collectOpts(), branch });
      const sha = revParse(branch, root);
      writeNote(root, sha, r, notesRef);
      console.error(`pr-receipts: ${r.headline} Attached to ${sha.slice(0, 7)} in refs/notes/${notesRef}.`);
      if (v.push) {
        pushNotes(root, v.remote ?? "origin", notesRef);
        console.error(`pr-receipts: pushed refs/notes/${notesRef} to ${v.remote ?? "origin"}.`);
      }
      return 0;
    }
    case "show": {
      const root = repoRoot(cwd);
      const commit = v.commit;
      const found = commit
        ? (() => {
            const r = readNote(root, commit, notesRef);
            return r ? { commit, receipt: r } : null;
          })()
        : (() => {
            // Scope the search to the branch's own commits; without a base, any
            // ancestor's receipt (from an older, merged branch) would be shown.
            const head = v.branch ?? "HEAD";
            const base = v.base ?? detectBase(root);
            const sameAsHead = base !== null && tryGit(["rev-parse", base], root) === tryGit(["rev-parse", head], root);
            return findReceipt(root, head, sameAsHead ? null : base, notesRef);
          })();
      if (!found) {
        console.error("pr-receipts: no receipt found.");
        return 1;
      }
      process.stdout.write(v.json ? `${JSON.stringify(found.receipt, null, 2)}\n` : renderMarkdown(found.receipt));
      return 0;
    }
    case "install-hook": {
      const p = installHook(cwd);
      console.error(`pr-receipts: pre-push hook installed at ${p}`);
      return 0;
    }
    case "comment": {
      const env = envFromProcess();
      env.eventPath = v.event ?? env.eventPath;
      env.workspace = repoRoot(cwd);
      env.notesRef = notesRef;
      env.dryRun = v["dry-run"] ?? env.dryRun;
      await run(env);
      return 0;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`pr-receipts: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
