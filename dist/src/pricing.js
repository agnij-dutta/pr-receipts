import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
export function defaultPricingPath() {
    // dist/src/pricing.js -> dist/config/pricing.json (copied at build time)
    return join(here, "..", "config", "pricing.json");
}
export function loadPricing(path = defaultPricingPath()) {
    return JSON.parse(readFileSync(path, "utf8"));
}
/**
 * Normalize a transcript model id to a pricing key:
 * "claude-opus-5-5[1m]" -> "claude-opus-5-5", "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
 */
export function normalizeModel(model) {
    return model
        .trim()
        .toLowerCase()
        .replace(/\[[^\]]*\]$/, "")
        .replace(/^(anthropic\.|us\.anthropic\.)/, "")
        .replace(/@.*$/, "")
        .replace(/-\d{8}$/, "")
        .replace(/-v\d+(:\d+)?$/, "");
}
export function priceFor(table, model) {
    return table.models[normalizeModel(model)] ?? null;
}
/** Cost in USD for one request's tokens, or null if the model is unpriced. */
export function costOf(table, model, t, opts = {}) {
    const p = priceFor(table, model);
    if (!p)
        return null;
    let input = p.input;
    let output = p.output;
    let w5 = p.cacheWrite5m;
    let w1 = p.cacheWrite1h;
    let r = p.cacheRead;
    if (opts.speed === "fast" && p.fast) {
        // Cache multipliers stack on top of the fast-mode base price.
        const scale = p.fast.input / p.input;
        input = p.fast.input;
        output = p.fast.output;
        w5 *= scale;
        w1 *= scale;
        r *= scale;
    }
    let usd = (t.inputTokens * input +
        t.outputTokens * output +
        t.cacheWrite5mTokens * w5 +
        t.cacheWrite1hTokens * w1 +
        t.cacheReadTokens * r) /
        1_000_000;
    if (opts.inferenceGeo === "us")
        usd *= table.usInferenceMultiplier;
    usd += (opts.webSearches ?? 0) * table.webSearchPerRequest;
    return usd;
}
