/** Retrieval settings, all overridable from backend/.env. */

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const n = parseFloat(process.env[name] ?? '');
  return Number.isFinite(n) ? n : fallback;
}

export function isRetrievalEnabled(): boolean {
  return (process.env.RETRIEVAL_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function getOllamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
}

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b';
}

/** Most tokens of retrieved excerpts added to one chat request. */
export function getRetrievalTokenBudget(): number {
  return intEnv('RETRIEVAL_TOKEN_BUDGET', 3000);
}

/** Most excerpts added to one chat request. */
export function getRetrievalMaxChunks(): number {
  return intEnv('RETRIEVAL_MAX_CHUNKS', 8);
}

/**
 * Cosine similarity a chunk needs to be added to the prompt. Top-3 keyword
 * matches need 0.1 less. With 0.55, 90% of answerable eval questions still got
 * their passage, and off-topic questions got almost nothing
 * (scripts/eval-retrieval.ts).
 */
export function getMinSimilarity(): number {
  return floatEnv('RETRIEVAL_MIN_SIMILARITY', 0.55);
}

/** How often the wiki index is refreshed from Outline, in minutes. */
export function getWikiSyncMinutes(): number {
  return intEnv('RETRIEVAL_WIKI_SYNC_MINUTES', 10);
}
