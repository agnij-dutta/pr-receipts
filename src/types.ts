// Shared types. Nothing in here ever holds transcript CONTENT (prompts,
// assistant text, tool inputs/outputs). Only usage metadata.

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** One deduplicated API request (assistant message) and its usage. */
export interface UsageEvent extends TokenCounts {
  messageId: string;
  sessionId: string;
  model: string;
  timestamp: string; // ISO
  cwd: string;
  gitBranch: string;
  isSidechain: boolean;
  speed: string; // "standard" | "fast"
  inferenceGeo: string;
  webSearches: number;
  refusalFallbacks: number;
  /** tool_use block id -> tool name */
  tools: Map<string, string>;
  /** absolute file paths written/edited by tool calls in this message */
  filePaths: Set<string>;
}

/** Non-request records we care about (prompts, turn timings, API errors). */
export interface MetaEvent {
  kind: "prompt" | "turn" | "apiError";
  sessionId: string;
  timestamp: string;
  cwd: string;
  gitBranch: string;
  durationMs?: number;
}

export type MatchReason = "branch" | "cwd" | "files";

export interface ModelLine extends TokenCounts {
  model: string;
  requests: number;
  costUSD: number | null; // null = unpriced model
}

export interface Receipt {
  schema: "pr-receipts/v1";
  generatedAt: string;
  generator: string;
  headline: string;
  repo: {
    name: string;
    branch: string;
    base: string | null;
    headSha: string | null;
    commitRange: string | null;
    commits: number;
    window: { start: string; end: string };
  };
  totals: TokenCounts & {
    costUSD: number;
    apiRequests: number;
    subagentRequests: number;
    turns: number;
    agentTimeMs: number;
    activeTimeMs: number;
    toolCalls: number;
    apiErrors: number;
    refusalFallbacks: number;
    webSearches: number;
  };
  models: ModelLine[];
  /** Opt-in only (--include-tools). Tool names can reveal which MCP services were used. */
  tools?: Record<string, number>;
  files: { count: number; paths?: string[] };
  sessions: { id: string; requests: number; costUSD: number; firstSeen: string; lastSeen: string }[];
  mapping: {
    byBranch: number;
    byCwd: number;
    byFiles: number;
    excludedOtherBranch: number;
    confidence: "high" | "medium" | "low" | "none";
    notes: string[];
  };
  pricing: { source: string; fetchedAt: string; unpricedModels: string[] };
  privacy: { contentIncluded: false; toolCounts: boolean; filePaths: boolean };
}
