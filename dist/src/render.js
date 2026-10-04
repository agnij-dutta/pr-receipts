// Receipt read-back and rendering. sanitizeReceipt is the gate for anything
// read from git notes or a file; renderMarkdown only ever sees its output.
import { agentTime, duration, money, prettyModel, tokens } from "./format.js";
/** Hidden marker that identifies the one comment this tool owns on a PR. */
export const STICKY_MARKER = "<!-- pr-receipts:sticky -->";
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Single-line, length-capped string. Newlines are removed so a value can't break out of a table row or an Actions output. */
const str = (v, max = 200) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, max) : "");
const strOrNull = (v, max = 200) => (typeof v === "string" ? str(v, max) : null);
/**
 * A repo-relative path we are willing to print: no absolute paths (POSIX,
 * Windows drive or UNC), no home-relative paths, no ".." segments.
 */
export function isSafeRelativePath(p) {
    if (typeof p !== "string" || p.length === 0 || p.length >= 300)
        return false;
    if (p.startsWith("/") || p.startsWith("~") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p))
        return false;
    return !p.split(/[\\/]/).includes("..");
}
const counts = (v) => {
    const o = obj(v);
    return {
        inputTokens: num(o.inputTokens),
        outputTokens: num(o.outputTokens),
        cacheReadTokens: num(o.cacheReadTokens),
        cacheWrite5mTokens: num(o.cacheWrite5mTokens),
        cacheWrite1hTokens: num(o.cacheWrite1hTokens),
    };
};
/**
 * Defensive rebuild of a receipt read from git notes or a file (which a human
 * or another tool could have edited). The output is constructed field by field
 * from the v1 schema: unknown keys anywhere are dropped, numbers that aren't
 * numbers become 0, strings are single-line and capped, file paths and tool
 * counts survive only if the receipt's own privacy flags opted in, and file
 * paths must be repo-relative. Throws on a wrong schema rather than guessing.
 */
export function sanitizeReceipt(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("receipt is not an object");
    const r = input;
    if (r.schema !== "pr-receipts/v1")
        throw new Error(`unsupported receipt schema: ${str(String(r.schema), 60)}`);
    const privacy = obj(r.privacy);
    const toolCounts = privacy.toolCounts === true;
    const filePaths = privacy.filePaths === true;
    const repo = obj(r.repo);
    const window = obj(repo.window);
    const totals = obj(r.totals);
    const files = obj(r.files);
    const mapping = obj(r.mapping);
    const pricing = obj(r.pricing);
    const confidence = ["high", "medium", "low", "none"].includes(mapping.confidence)
        ? mapping.confidence
        : "none";
    const out = {
        schema: "pr-receipts/v1",
        generatedAt: str(r.generatedAt, 40),
        generator: str(r.generator, 60),
        headline: str(r.headline),
        repo: {
            name: str(repo.name, 100),
            branch: str(repo.branch),
            base: strOrNull(repo.base),
            headSha: strOrNull(repo.headSha, 64),
            commitRange: strOrNull(repo.commitRange),
            commits: num(repo.commits),
            window: { start: str(window.start, 40), end: str(window.end, 40) },
        },
        totals: {
            ...counts(totals),
            costUSD: num(totals.costUSD),
            apiRequests: num(totals.apiRequests),
            subagentRequests: num(totals.subagentRequests),
            turns: num(totals.turns),
            agentTimeMs: num(totals.agentTimeMs),
            activeTimeMs: num(totals.activeTimeMs),
            toolCalls: num(totals.toolCalls),
            apiErrors: num(totals.apiErrors),
            refusalFallbacks: num(totals.refusalFallbacks),
            webSearches: num(totals.webSearches),
        },
        models: arr(r.models).map((m) => {
            const o = obj(m);
            return {
                model: str(o.model, 100),
                requests: num(o.requests),
                ...counts(o),
                costUSD: o.costUSD === null ? null : num(o.costUSD),
            };
        }),
        files: {
            count: num(files.count),
            ...(filePaths && Array.isArray(files.paths) ? { paths: files.paths.filter(isSafeRelativePath) } : {}),
        },
        sessions: arr(r.sessions).map((s) => {
            const o = obj(s);
            return {
                id: str(o.id, 36),
                requests: num(o.requests),
                costUSD: num(o.costUSD),
                firstSeen: str(o.firstSeen, 40),
                lastSeen: str(o.lastSeen, 40),
            };
        }),
        mapping: {
            byBranch: num(mapping.byBranch),
            byCwd: num(mapping.byCwd),
            byFiles: num(mapping.byFiles),
            excludedOtherBranch: num(mapping.excludedOtherBranch),
            confidence,
            notes: arr(mapping.notes)
                .filter((n) => typeof n === "string")
                .map((n) => str(n, 300)),
        },
        pricing: {
            source: str(pricing.source),
            fetchedAt: str(pricing.fetchedAt, 40),
            unpricedModels: arr(pricing.unpricedModels)
                .filter((m) => typeof m === "string")
                .map((m) => str(m, 100)),
        },
        privacy: { contentIncluded: false, toolCounts, filePaths },
    };
    if (toolCounts && r.tools && typeof r.tools === "object") {
        out.tools = Object.fromEntries(Object.entries(obj(r.tools)).map(([k, v]) => [str(k, 100), num(v)]));
    }
    return out;
}
/**
 * Escape a value for GitHub Markdown: table pipes, HTML angle brackets,
 * backticks, and a leading "@" (a zero-width space after it, so a crafted
 * value cannot ping users or teams).
 */
const esc = (s) => String(s)
    .replace(/[|<>`]/g, (c) => `\\${c}`)
    .replace(/(^|[\s([])@/g, "$1@\u200b");
/**
 * Render a receipt as the PR comment body. Every string taken from the receipt
 * goes through `esc`; numbers go through the format helpers.
 */
export function renderMarkdown(r, opts = {}) {
    const t = r.totals;
    const lines = [];
    if (opts.sticky)
        lines.push(STICKY_MARKER);
    lines.push("### PR Receipt");
    lines.push("");
    lines.push(`**${esc(r.headline)}**`);
    lines.push("");
    if (t.apiRequests === 0) {
        lines.push(`No local Claude Code usage matched \`${esc(r.repo.branch)}\` between ${esc(r.repo.window.start)} and ${esc(r.repo.window.end)}.`);
        return `${lines.join("\n")}\n`;
    }
    const promptSide = t.inputTokens + t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens;
    const hitRate = promptSide ? Math.round((t.cacheReadTokens / promptSide) * 100) : 0;
    lines.push("| | |");
    lines.push("|---|---|");
    lines.push(`| Cost (API list price) | **${money(t.costUSD)}** |`);
    lines.push(`| Agent time | ${duration(agentTime(r))}${t.agentTimeMs > 0 ? "" : " (estimated)"} |`);
    lines.push(`| Models | ${r.models.map((m) => esc(prettyModel(m.model))).join(", ")} |`);
    lines.push(`| Human turns | ${t.turns} |`);
    lines.push(`| API requests | ${t.apiRequests}${t.subagentRequests ? ` (${t.subagentRequests} by subagents)` : ""} |`);
    lines.push(`| Retries | ${t.apiErrors} API error retries${t.refusalFallbacks ? `, ${t.refusalFallbacks} refusal fallbacks` : ""} |`);
    lines.push(`| Tool calls | ${t.toolCalls} |`);
    lines.push(`| Files touched | ${r.files.count} |`);
    lines.push(`| Sessions | ${r.sessions.length} |`);
    lines.push("");
    lines.push("<details><summary>Token breakdown by model</summary>");
    lines.push("");
    lines.push("| Model | Requests | Input | Output | Cache read | Cache write | Cost |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const m of r.models) {
        lines.push(`| ${esc(prettyModel(m.model))} | ${m.requests} | ${tokens(m.inputTokens)} | ${tokens(m.outputTokens)} | ${tokens(m.cacheReadTokens)} | ${tokens(m.cacheWrite5mTokens + m.cacheWrite1hTokens)} | ${m.costUSD === null ? "unpriced" : money(m.costUSD)} |`);
    }
    lines.push(`| **Total** | **${t.apiRequests}** | **${tokens(t.inputTokens)}** | **${tokens(t.outputTokens)}** | **${tokens(t.cacheReadTokens)}** | **${tokens(t.cacheWrite5mTokens + t.cacheWrite1hTokens)}** | **${money(t.costUSD)}** |`);
    lines.push("");
    lines.push(`Cache hit rate: ${hitRate}% of prompt tokens were served from cache.`);
    lines.push("");
    lines.push("</details>");
    if (r.tools && Object.keys(r.tools).length) {
        lines.push("");
        lines.push("<details><summary>Tools used</summary>");
        lines.push("");
        lines.push("| Tool | Calls |");
        lines.push("|---|---:|");
        for (const [name, n] of Object.entries(r.tools))
            lines.push(`| ${esc(name)} | ${n} |`);
        lines.push("");
        lines.push("</details>");
    }
    if (r.files.paths?.length) {
        const max = opts.maxFiles ?? 25;
        lines.push("");
        lines.push(`<details><summary>Files touched by the agent (${r.files.count})</summary>`);
        lines.push("");
        for (const p of r.files.paths.slice(0, max))
            lines.push(`- ${esc(p)}`);
        if (r.files.paths.length > max)
            lines.push(`- and ${r.files.paths.length - max} more`);
        lines.push("");
        lines.push("</details>");
    }
    lines.push("");
    lines.push("<details><summary>How this was attributed</summary>");
    lines.push("");
    lines.push(`- Branch \`${esc(r.repo.branch)}\`${r.repo.commitRange ? `, commits \`${esc(r.repo.commitRange)}\` (${r.repo.commits})` : ""}`);
    lines.push(`- Window ${esc(r.repo.window.start)} to ${esc(r.repo.window.end)}`);
    lines.push(`- Matched requests: ${r.mapping.byBranch} by git branch, ${r.mapping.byCwd} by working directory + time${r.mapping.byFiles ? `, ${r.mapping.byFiles} by edited files` : ""}. Confidence: **${esc(r.mapping.confidence)}**`);
    for (const n of r.mapping.notes)
        lines.push(`- ${esc(n)}`);
    lines.push(`- Sessions: ${r.sessions.map((s) => `\`${esc(s.id)}\``).join(", ")}`);
    lines.push(`- Prices from ${esc(r.pricing.source)} (fetched ${esc(r.pricing.fetchedAt)}). API list prices, not what a Pro/Max subscription pays.`);
    lines.push("- Lower bound: Claude Code side calls that never reach the transcript (titles, summaries, permission classifier) are not counted.");
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push(`<sub>Usage metadata only. No prompts, code, or tool output leave the machine. Generated by ${esc(r.generator)}.</sub>`);
    return `${lines.join("\n")}\n`;
}
