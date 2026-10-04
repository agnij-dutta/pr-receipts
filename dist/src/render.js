import { agentTime, duration, money, prettyModel, tokens } from "./format.js";
export const STICKY_MARKER = "<!-- pr-receipts:sticky -->";
/** Keys a receipt is allowed to carry. Anything else is dropped before rendering or storing. */
const ALLOWED_TOP = new Set([
    "schema", "generatedAt", "generator", "headline", "repo", "totals", "models",
    "tools", "files", "sessions", "mapping", "pricing", "privacy",
]);
/**
 * Defensive scrub for receipts read from git notes / files (which a human or
 * another tool could have edited): keep only known top-level keys, drop file
 * paths / tool counts unless the privacy flags opted in, and cap strings.
 */
export function sanitizeReceipt(input) {
    if (!input || typeof input !== "object")
        throw new Error("receipt is not an object");
    const r = {};
    for (const [k, v] of Object.entries(input))
        if (ALLOWED_TOP.has(k))
            r[k] = v;
    if (r.schema !== "pr-receipts/v1")
        throw new Error(`unsupported receipt schema: ${String(r.schema)}`);
    if (!r.privacy?.toolCounts)
        delete r.tools;
    if (!r.privacy?.filePaths && r.files)
        delete r.files.paths;
    if (Array.isArray(r.files?.paths)) {
        r.files.paths = r.files.paths.filter((p) => typeof p === "string" && p.length < 300 && !p.startsWith("/") && !p.startsWith(".."));
    }
    if (Array.isArray(r.mapping?.notes)) {
        r.mapping.notes = r.mapping.notes.filter((n) => typeof n === "string").map((n) => n.slice(0, 300));
    }
    if (typeof r.headline === "string")
        r.headline = r.headline.slice(0, 200);
    r.privacy = { ...(r.privacy ?? {}), contentIncluded: false };
    return r;
}
const esc = (s) => String(s).replace(/[|<>`]/g, (c) => `\\${c}`);
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
        lines.push(`No local Claude Code usage matched \`${esc(r.repo.branch)}\` between ${r.repo.window.start} and ${r.repo.window.end}.`);
        return lines.join("\n") + "\n";
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
    if (r.files.paths && r.files.paths.length) {
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
    lines.push(`- Window ${r.repo.window.start} to ${r.repo.window.end}`);
    lines.push(`- Matched requests: ${r.mapping.byBranch} by git branch, ${r.mapping.byCwd} by working directory + time${r.mapping.byFiles ? `, ${r.mapping.byFiles} by edited files` : ""}. Confidence: **${r.mapping.confidence}**`);
    for (const n of r.mapping.notes)
        lines.push(`- ${esc(n)}`);
    lines.push(`- Sessions: ${r.sessions.map((s) => `\`${esc(s.id)}\``).join(", ")}`);
    lines.push(`- Prices from ${r.pricing.source} (fetched ${r.pricing.fetchedAt}). API list prices; subscription plans pay differently.`);
    lines.push("- Lower bound: Claude Code side calls that never reach the transcript (titles, summaries, permission classifier) are not counted.");
    lines.push("");
    lines.push("</details>");
    lines.push("");
    lines.push(`<sub>Usage metadata only. No prompts, code, or tool output leave the machine. Generated by ${esc(r.generator)}.</sub>`);
    return lines.join("\n") + "\n";
}
