/**
 * Hybrid search over the retrieval index.
 *
 * Two retrievers, fused by rank:
 *   - BM25 keyword search (SQLite FTS5) catches exact names and terms,
 *     such as a character, a mechanic or a number.
 *   - Embedding search (cosine similarity) catches the same idea in other words.
 * Reciprocal rank fusion (RRF) merges the two lists by position, so the two
 * score scales never have to be calibrated against each other.
 *
 * The corpus is a few thousand chunks at most, so vectors are compared by
 * brute force in memory; a vector database would add nothing at this size.
 */

import db from '../db/connection';
import { estimateTokens } from '../agents/contextConfig';
import { getEmbeddingModel, getMinSimilarity, getRetrievalMaxChunks, getRetrievalTokenBudget } from './config';
import { dot, embed, fromBlob } from './embeddings';

export type SourceType = 'message' | 'wiki' | 'diagram';

const CANDIDATES = 30;
const RRF_K = 60;

/** Which chunks a chat request may use. */
export interface ChunkFilter {
  agentId: number;
  /** The chat being answered. */
  conversationId: number;
  /** Its messages with a larger id are already sent verbatim, so they are skipped. */
  verbatimAfterMessageId: number;
}

export type SearchMode = 'bm25' | 'vector' | 'hybrid';

export interface SearchHit {
  chunkId: number;
  sourceType: SourceType;
  sourceId: string;
  title: string | null;
  url: string | null;
  role: string | null;
  conversationId: number | null;
  messageId: number | null;
  text: string;
  createdAt: string;
  /** 0-based rank in each retriever's list, null if it didn't return the chunk. */
  bm25Rank: number | null;
  vectorRank: number | null;
  similarity: number | null;
  score: number;
}

interface ChunkRow {
  id: number;
  source_type: SourceType;
  source_id: string;
  title: string | null;
  url: string | null;
  role: string | null;
  conversation_id: number | null;
  message_id: number | null;
  text: string;
  created_at: string;
}

const STOPWORDS = new Set(
  'the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what about would there their which could other into then also should these think does need yeah okay'.split(' ')
);

function eligibilitySql(filter: ChunkFilter | null): { sql: string; params: (number | string)[] } {
  if (!filter) return { sql: `c.text != ''`, params: [] };
  return {
    sql: `c.text != '' AND (
      c.source_type IN ('wiki', 'diagram')
      OR (c.source_type = 'message' AND c.agent_id = ?
          AND NOT (c.conversation_id = ? AND c.message_id > ?)
          AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = c.conversation_id AND cv.deleted_at IS NULL))
    )`,
    params: [filter.agentId, filter.conversationId, filter.verbatimAfterMessageId],
  };
}

/** FTS5 query: distinctive words of the message, OR'ed. Quoted, so user text can't inject FTS syntax. */
export function toFtsQuery(text: string): string | null {
  const words = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w)))];
  if (words.length === 0) return null;
  return words.slice(0, 32).map((w) => `"${w}"`).join(' OR ');
}

function bm25Search(query: string, filter: ChunkFilter | null, limit: number): number[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const e = eligibilitySql(filter);
  const rows = db
    .prepare(
      `SELECT c.id FROM retrieval_fts f
       JOIN retrieval_chunks c ON c.id = f.rowid
       WHERE retrieval_fts MATCH ? AND ${e.sql}
       ORDER BY bm25(retrieval_fts) LIMIT ?`
    )
    .all(fts, ...e.params, limit) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Similarity of every eligible chunk, best first. */
function vectorSearch(queryVec: Float32Array, filter: ChunkFilter | null): { id: number; sim: number }[] {
  const e = eligibilitySql(filter);
  const rows = db
    .prepare(`SELECT c.id, c.embedding FROM retrieval_chunks c WHERE c.embedding_model = ? AND ${e.sql}`)
    .all(getEmbeddingModel(), ...e.params) as { id: number; embedding: Uint8Array }[];
  return rows
    .map((r) => ({ id: r.id, sim: dot(queryVec, fromBlob(r.embedding)) }))
    .sort((a, b) => b.sim - a.sim);
}

function loadChunks(ids: number[]): Map<number, ChunkRow> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, source_type, source_id, title, url, role, conversation_id, message_id, text, created_at
       FROM retrieval_chunks WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as unknown as ChunkRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

export async function embedQuery(query: string, timeoutMs = 12_000): Promise<Float32Array | null> {
  try {
    return (await embed([query], 'query', { timeoutMs }))[0];
  } catch (err) {
    console.warn('[Retrieval] Query embedding failed, using keyword search only:', (err as Error).message);
    return null;
  }
}

export async function searchChunks(
  query: string,
  opts: { mode?: SearchMode; filter?: ChunkFilter | null; limit?: number; queryVector?: Float32Array | null } = {}
): Promise<SearchHit[]> {
  const mode = opts.mode ?? 'hybrid';
  const filter = opts.filter ?? null;
  const limit = opts.limit ?? 10;

  const bm25 = mode === 'vector' ? [] : bm25Search(query, filter, CANDIDATES);
  const queryVec = mode === 'bm25' ? null : opts.queryVector !== undefined ? opts.queryVector : await embedQuery(query);
  const allSims = queryVec ? vectorSearch(queryVec, filter) : [];
  const vec = mode === 'bm25' ? [] : allSims.slice(0, CANDIDATES);

  const bm25Rank = new Map(bm25.map((id, i) => [id, i]));
  const vecRank = new Map(vec.map((v, i) => [v.id, i]));
  // Similarity for keyword hits too, so selectForContext can judge them.
  const sims = new Map(allSims.map((v) => [v.id, v.sim]));

  const ids = [...new Set([...bm25, ...vec.map((v) => v.id)])];
  const score = (id: number) => {
    const b = bm25Rank.get(id);
    const v = vecRank.get(id);
    if (mode === 'bm25') return b === undefined ? 0 : 1 / (RRF_K + b + 1);
    if (mode === 'vector') return v === undefined ? 0 : 1 / (RRF_K + v + 1);
    return (b === undefined ? 0 : 1 / (RRF_K + b + 1)) + (v === undefined ? 0 : 1 / (RRF_K + v + 1));
  };

  const ranked = ids
    .map((id) => ({ id, s: score(id) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  const chunks = loadChunks(ranked.map((r) => r.id));

  return ranked.flatMap(({ id, s }) => {
    const c = chunks.get(id);
    if (!c) return [];
    return [{
      chunkId: c.id,
      sourceType: c.source_type,
      sourceId: c.source_id,
      title: c.title,
      url: c.url,
      role: c.role,
      conversationId: c.conversation_id,
      messageId: c.message_id,
      text: c.text,
      createdAt: c.created_at,
      bm25Rank: bm25Rank.get(id) ?? null,
      vectorRank: vecRank.get(id) ?? null,
      similarity: sims.get(id) ?? null,
      score: s,
    }];
  });
}

/**
 * Picks hits for the prompt. Fusion only ranks; this decides what is relevant
 * enough to spend tokens on. A chunk qualifies if it is semantically close
 * (similarity >= RETRIEVAL_MIN_SIMILARITY), or is a top-3 keyword match that
 * is at least loosely related (similarity >= the threshold - 0.1): keyword
 * search alone happily matches one shared word. Without embeddings (Ollama
 * down) only the top-3 keyword matches are used.
 */
export function selectForContext(hits: SearchHit[], minSim = getMinSimilarity()): SearchHit[] {
  const maxChunks = getRetrievalMaxChunks();
  let budget = getRetrievalTokenBudget();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const topKeyword = h.bm25Rank !== null && h.bm25Rank < 3;
    const relevant =
      h.similarity === null ? topKeyword : h.similarity >= minSim || (topKeyword && h.similarity >= minSim - 0.1);
    if (!relevant) continue;
    const tokens = estimateTokens(h.text) + 30;
    if (tokens > budget) continue;
    budget -= tokens;
    out.push(h);
    if (out.length >= maxChunks) break;
  }
  return out;
}
