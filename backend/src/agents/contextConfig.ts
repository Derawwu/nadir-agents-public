/**
 * Context-management settings for chat requests, read from the environment.
 *
 * CONTEXT_STRATEGY      windowed (default) | full
 *   windowed: recent turns verbatim + a running summary of older ones
 *   full:     every message verbatim (the original behaviour, kept for A/B)
 * HISTORY_TOKEN_BUDGET  verbatim history kept after a summary update (default 20000)
 * SUMMARY_BATCH_TOKENS  extra history allowed to pile up before the summary is
 *                       updated (default 10000). Batching keeps the cached
 *                       prefix stable for many turns between updates.
 * CACHE_TTL             5m (default) | 1h
 * ANTHROPIC_MODEL_SUMMARY  model that writes chat summaries (default claude-haiku-4-5)
 */

export type ContextStrategy = 'windowed' | 'full';

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getContextStrategy(): ContextStrategy {
  return process.env.CONTEXT_STRATEGY === 'full' ? 'full' : 'windowed';
}

export function getHistoryTokenBudget(): number {
  return intEnv('HISTORY_TOKEN_BUDGET', 20_000);
}

export function getSummaryBatchTokens(): number {
  return intEnv('SUMMARY_BATCH_TOKENS', 10_000);
}

export function getCacheTtl(): '5m' | '1h' {
  return process.env.CACHE_TTL === '1h' ? '1h' : '5m';
}

export function getSummaryModel(): string {
  return process.env.ANTHROPIC_MODEL_SUMMARY ?? 'claude-haiku-4-5';
}

/** Rough token estimate (~4 characters per token). Only used for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Flat per-image estimate; Claude bills ~1.6k tokens for a typical screenshot. */
export const IMAGE_TOKEN_ESTIMATE = 1600;
