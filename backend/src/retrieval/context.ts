/**
 * Turns search hits into the "retrieved" section of a chat request's
 * <context> block, plus a compact list of sources for the UI.
 */

import db from '../db/connection';
import { isRetrievalEnabled } from './config';
import { searchChunks, selectForContext, type ChunkFilter, type SearchHit, type SourceType } from './search';

export interface ContextSource {
  type: SourceType;
  title: string | null;
  /** Outline page URL for wiki excerpts. */
  url: string | null;
  conversationId: number | null;
  chatSlug: string | null;
  messageId: number | null;
  role: string | null;
  createdAt: string;
  snippet: string;
  similarity: number | null;
  keywordMatch: boolean;
}

export interface RetrievedContext {
  /** Markdown for the <context> block; '' when nothing qualified. */
  block: string;
  sources: ContextSource[];
  /** True when the wiki index has pages, so the older feature-name wiki search can be skipped. */
  wikiIndexed: boolean;
}

const OUTLINE_BASE_URL = (process.env.OUTLINE_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');

/**
 * Very short follow-ups ("go on", "and the second one?") say nothing on their
 * own, so the end of the previous reply is searched with them. Anything longer
 * is searched as-is: a new question must not be steered by the old topic.
 */
const SHORT_QUERY_WORDS = 4;

function buildQuery(userMessage: string, lastAssistantMessage: string | null): string {
  const words = userMessage.trim().split(/\s+/).length;
  if (words > SHORT_QUERY_WORDS || !lastAssistantMessage) return userMessage;
  return `${lastAssistantMessage.slice(-600)}\n\n${userMessage}`;
}

function heading(h: SearchHit, chatTitles: Map<number, string>): string {
  if (h.sourceType === 'wiki') return `Wiki: ${h.title ?? 'untitled'}`;
  if (h.sourceType === 'diagram') return `Diagram: ${h.title ?? 'untitled'}`;
  const chat = chatTitles.get(h.conversationId ?? 0) ?? h.title ?? 'chat';
  const who = h.role === 'assistant' ? 'you' : 'user';
  return `Chat "${chat}", ${who}, ${h.createdAt.slice(0, 10)}`;
}

function chatInfo(ids: number[]): Map<number, { title: string; slug: string | null }> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, title, slug FROM conversations WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: number; title: string; slug: string | null }[];
  return new Map(rows.map((r) => [r.id, { title: r.title, slug: r.slug }]));
}

function wikiIndexed(): boolean {
  return !!db.prepare(`SELECT 1 FROM retrieval_chunks WHERE source_type = 'wiki' AND text != '' LIMIT 1`).get();
}

export async function retrieveForChat(params: {
  filter: ChunkFilter;
  userMessage: string;
  lastAssistantMessage: string | null;
}): Promise<RetrievedContext> {
  const empty: RetrievedContext = { block: '', sources: [], wikiIndexed: false };
  if (!isRetrievalEnabled() || !params.userMessage.trim()) return empty;

  try {
    const started = Date.now();
    const query = buildQuery(params.userMessage, params.lastAssistantMessage);
    const hits = selectForContext(await searchChunks(query, { filter: params.filter, limit: 20 }));
    const chats = chatInfo([...new Set(hits.flatMap((h) => (h.conversationId != null ? [h.conversationId] : [])))]);
    const titles = new Map([...chats].map(([id, c]) => [id, c.title]));

    const sources: ContextSource[] = hits.map((h) => ({
      type: h.sourceType,
      title: h.sourceType !== 'message' ? h.title : (chats.get(h.conversationId ?? 0)?.title ?? h.title),
      url: h.url ? `${OUTLINE_BASE_URL}${h.url}` : null,
      conversationId: h.conversationId,
      chatSlug: h.conversationId != null ? (chats.get(h.conversationId)?.slug ?? null) : null,
      messageId: h.messageId,
      role: h.role,
      createdAt: h.createdAt,
      snippet: h.text.length > 240 ? `${h.text.slice(0, 237)}…` : h.text,
      similarity: h.similarity,
      keywordMatch: h.bm25Rank !== null,
    }));

    const block = hits.length
      ? `## Retrieved excerpts\nEarlier messages, wiki passages and diagrams found by searching for the new message, most relevant first. They may be partial or out of date; prefer the recent conversation where they disagree.\n\n${hits
          .map((h) => `### ${heading(h, titles)}\n${h.text}`)
          .join('\n\n')}`
      : '';

    console.log(
      `[Retrieval] ${hits.length} excerpts (${hits.filter((h) => h.sourceType === 'message').length} messages, ${hits.filter((h) => h.sourceType === 'wiki').length} wiki, ${hits.filter((h) => h.sourceType === 'diagram').length} diagrams) in ${Date.now() - started}ms`
    );
    return { block, sources, wikiIndexed: wikiIndexed() };
  } catch (err) {
    console.warn('[Retrieval] Failed, continuing without:', err);
    return empty;
  }
}
