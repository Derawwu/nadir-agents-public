/**
 * Keeps the retrieval index in step with chat messages, the Outline wiki and
 * the diagram tool.
 *
 * Indexing has two stages, so a slow or stopped Ollama never blocks chat:
 *   1. chunk text is written to retrieval_chunks and retrieval_fts at once
 *      (keyword search works immediately);
 *   2. chunks without an embedding (or embedded by a different model) are
 *      embedded in batches.
 *
 * All work runs through one queue, so a new message arriving mid-sync never
 * races another indexing pass.
 */

import db from '../db/connection';
import { getDocumentById, listDocuments } from '../outline/outlineService';
import { getAgentFormatFromTool, listDiagramsFromTool } from '../diagrams/diagramClient';
import { chunkMarkdown, chunkText } from './chunker';
import { getEmbeddingModel, getWikiSyncMinutes, isRetrievalEnabled } from './config';
import { embed, toBlob } from './embeddings';
import type { SourceType } from './search';

/** Messages shorter than this ("ok", "go on") carry nothing worth retrieving. */
const MIN_MESSAGE_CHARS = 40;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

interface ChunkInput {
  sourceType: SourceType;
  sourceId: string;
  sourceVersion: string | null;
  agentId: number | null;
  conversationId: number | null;
  messageId: number | null;
  role: string | null;
  title: string | null;
  url: string | null;
  texts: string[];
}

/** Replaces every chunk of one source (message or wiki page). */
function writeSource(input: ChunkInput): void {
  const old = db
    .prepare('SELECT id FROM retrieval_chunks WHERE source_type = ? AND source_id = ?')
    .all(input.sourceType, input.sourceId) as { id: number }[];
  const insert = db.prepare(
    `INSERT INTO retrieval_chunks
       (source_type, source_id, chunk_index, source_version, agent_id, conversation_id, message_id, role, title, url, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare('INSERT INTO retrieval_fts (rowid, text, title) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  try {
    for (const { id } of old) db.prepare('DELETE FROM retrieval_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM retrieval_chunks WHERE source_type = ? AND source_id = ?').run(input.sourceType, input.sourceId);
    input.texts.forEach((text, i) => {
      const r = insert.run(
        input.sourceType,
        input.sourceId,
        i,
        input.sourceVersion,
        input.agentId,
        input.conversationId,
        input.messageId,
        input.role,
        input.title,
        input.url,
        text
      );
      insertFts.run(Number(r.lastInsertRowid), text, input.title ?? '');
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

/** Chunks messages not yet in the index, or every message when `all` is set. */
function chunkMessages(all = false): number {
  const rows = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.content, c.agent_id, c.title
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       ${all ? '' : `WHERE NOT EXISTS (
         SELECT 1 FROM retrieval_chunks r
         WHERE r.source_type = 'message' AND r.source_id = CAST(m.id AS TEXT)
       )`}
       ORDER BY m.id`
    )
    .all() as { id: number; conversation_id: number; role: string; content: string; agent_id: number; title: string }[];

  let n = 0;
  for (const m of rows) {
    const content = m.content.trim();
    const texts = content.length >= MIN_MESSAGE_CHARS ? chunkText(content) : [];
    writeSource({
      sourceType: 'message',
      sourceId: String(m.id),
      sourceVersion: null,
      agentId: m.agent_id,
      conversationId: m.conversation_id,
      messageId: m.id,
      role: m.role,
      title: m.title,
      url: null,
      // A short message gets one empty marker chunk, so it isn't rescanned.
      texts: texts.length ? texts : [''],
    });
    n += texts.length;
  }
  return n;
}

// ─── Wiki ────────────────────────────────────────────────────────────────────

/** Re-chunks wiki pages that changed since the last sync, or all of them when `force` is set. */
async function chunkChangedWikiDocs(force = false): Promise<{ changed: number; removed: number }> {
  // One agent's Outline token sees the whole workspace.
  const docs = await listDocuments('narrator');
  if (docs.length >= 100) console.warn('[Retrieval] Outline returned 100 documents; later pages are not indexed yet');

  const indexed = new Map(
    (
      db
        .prepare(`SELECT DISTINCT source_id, source_version FROM retrieval_chunks WHERE source_type = 'wiki'`)
        .all() as { source_id: string; source_version: string | null }[]
    ).map((r) => [r.source_id, r.source_version])
  );

  let changed = 0;
  for (const meta of docs) {
    if (!force && indexed.get(meta.id) === meta.updatedAt) continue;
    const doc = await getDocumentById('narrator', meta.id);
    const texts = chunkMarkdown(doc.text ?? '');
    writeSource({
      sourceType: 'wiki',
      sourceId: meta.id,
      sourceVersion: meta.updatedAt,
      agentId: null,
      conversationId: null,
      messageId: null,
      role: null,
      title: meta.collectionName ? `${meta.collectionName} / ${meta.title}` : meta.title,
      url: meta.url,
      texts: texts.length ? texts : [''],
    });
    changed++;
  }

  // Pages deleted in Outline.
  const live = new Set(docs.map((d) => d.id));
  let removed = 0;
  for (const id of indexed.keys()) {
    if (live.has(id)) continue;
    writeSource({
      sourceType: 'wiki', sourceId: id, sourceVersion: null, agentId: null, conversationId: null,
      messageId: null, role: null, title: null, url: null, texts: [],
    });
    removed++;
  }
  return { changed, removed };
}

// ─── Diagrams ────────────────────────────────────────────────────────────────

/**
 * Indexable text of a diagram: its name, description and the dependency
 * listing from the diagram tool's agent format. Dropped: the metadata header
 * (name again, folder, counts, date) and the Mermaid block, which repeats the
 * listing as node ids and arrows, and the generated node ids. All of it only
 * adds noise to search.
 */
function diagramText(name: string, description: string | null, agentFormat: string): string {
  const listing = agentFormat
    .replace(/^Diagram:[^\n]*\n(?:(?:Folder|Nodes|Last updated):[^\n]*\n?)*/, '')
    .replace(/```mermaid[\s\S]*?```/g, '')
    .replace(/^- \[[^\]]+\] /gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [name, description?.trim(), listing].filter(Boolean).join('\n\n');
}

/** Bump when diagramText changes, so already-indexed diagrams are rebuilt. */
const DIAGRAM_FORMAT = 'v4';

async function chunkChangedDiagrams(force = false): Promise<{ changed: number; removed: number }> {
  const diagrams = await listDiagramsFromTool();
  const indexed = new Map(
    (
      db
        .prepare(`SELECT DISTINCT source_id, source_version FROM retrieval_chunks WHERE source_type = 'diagram'`)
        .all() as { source_id: string; source_version: string | null }[]
    ).map((r) => [r.source_id, r.source_version])
  );

  let changed = 0;
  for (const d of diagrams) {
    const id = String(d.id);
    const version = `${DIAGRAM_FORMAT}:${d.updated_at}`;
    if (!force && indexed.get(id) === version) continue;
    const agentFormat = await getAgentFormatFromTool(d.id);
    if (agentFormat === null) continue;
    writeSource({
      sourceType: 'diagram',
      sourceId: id,
      sourceVersion: version,
      agentId: null,
      conversationId: null,
      messageId: null,
      role: null,
      title: d.folder_path ? `${d.folder_path} / ${d.name}` : d.name,
      url: null,
      texts: chunkText(diagramText(d.name, d.description, agentFormat)),
    });
    changed++;
  }

  const live = new Set(diagrams.map((d) => String(d.id)));
  let removed = 0;
  for (const id of indexed.keys()) {
    if (live.has(id)) continue;
    writeSource({
      sourceType: 'diagram', sourceId: id, sourceVersion: null, agentId: null, conversationId: null,
      messageId: null, role: null, title: null, url: null, texts: [],
    });
    removed++;
  }
  return { changed, removed };
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

async function embedPending(onProgress?: (done: number, total: number) => void): Promise<number> {
  const model = getEmbeddingModel();
  const rows = db
    .prepare(
      `SELECT id, title, text FROM retrieval_chunks
       WHERE text != '' AND (embedding IS NULL OR embedding_model IS NOT ?)
       ORDER BY id`
    )
    .all(model) as { id: number; title: string | null; text: string }[];
  if (rows.length === 0) return 0;

  const update = db.prepare('UPDATE retrieval_chunks SET embedding = ?, embedding_model = ? WHERE id = ?');
  const BATCH = 32;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // The title (chat or page name) gives a short excerpt its topic.
    const vectors = await embed(batch.map((r) => (r.title ? `${r.title}\n\n${r.text}` : r.text)), 'document');
    batch.forEach((r, j) => update.run(toBlob(vectors[j]), model, r.id));
    onProgress?.(Math.min(i + BATCH, rows.length), rows.length);
  }
  return rows.length;
}

async function embedPendingSafe(): Promise<void> {
  try {
    const n = await embedPending();
    if (n > 0) console.log(`[Retrieval] Embedded ${n} chunks with ${getEmbeddingModel()}`);
  } catch (err) {
    console.warn('[Retrieval] Embedding failed (is Ollama running?); keyword search still works:', (err as Error).message);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Indexes messages not yet in the index. Call after a message is saved. */
export function indexNewMessages(): Promise<void> {
  if (!isRetrievalEnabled()) return Promise.resolve();
  return enqueue(async () => {
    chunkMessages();
    await embedPendingSafe();
  });
}

/**
 * Re-indexes wiki pages and diagrams that changed since the last sync. Each
 * service is optional: one being down doesn't stop the other.
 */
export function syncSources(): Promise<void> {
  if (!isRetrievalEnabled()) return Promise.resolve();
  return enqueue(async () => {
    try {
      const { changed, removed } = await chunkChangedWikiDocs();
      if (changed || removed) console.log(`[Retrieval] Wiki sync: ${changed} pages updated, ${removed} removed`);
    } catch (err) {
      console.warn('[Retrieval] Wiki sync failed (is Outline running?):', (err as Error).message);
    }
    try {
      const { changed, removed } = await chunkChangedDiagrams();
      if (changed || removed) console.log(`[Retrieval] Diagram sync: ${changed} diagrams updated, ${removed} removed`);
    } catch (err) {
      console.warn('[Retrieval] Diagram sync failed (is the diagram tool running?):', (err as Error).message);
    }
    await embedPendingSafe();
  });
}

/** Full catch-up, then a periodic wiki sync. Called once at server start. */
export function startRetrievalIndexer(): void {
  if (!isRetrievalEnabled()) {
    console.log('[Retrieval] Disabled (RETRIEVAL_ENABLED=false)');
    return;
  }
  void indexNewMessages().then(() => syncSources());
  setInterval(() => void syncSources(), getWikiSyncMinutes() * 60_000).unref();
}

// ─── Full rebuild ────────────────────────────────────────────────────────────

export interface RebuildJob {
  status: 'idle' | 'running' | 'success' | 'error';
  /** What the job is doing now, or how it ended. */
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  embedded: number;
  toEmbed: number;
}

let rebuildJob: RebuildJob = { status: 'idle', message: null, startedAt: null, finishedAt: null, embedded: 0, toEmbed: 0 };

export function getRebuildJob(): RebuildJob {
  return rebuildJob;
}

/**
 * Rebuilds the whole index: re-chunks every message, wiki page and diagram
 * (ignoring "unchanged" checks) and re-embeds every chunk. For after a
 * chunking or embedding change, or when the index looks out of step. Runs in
 * the background; poll getRebuildJob(). Returns at once if one is running.
 */
export function startRebuild(): RebuildJob {
  if (rebuildJob.status === 'running') return rebuildJob;
  if (!isRetrievalEnabled()) {
    rebuildJob = { ...rebuildJob, status: 'error', message: 'Retrieval is disabled (RETRIEVAL_ENABLED=false)', finishedAt: new Date().toISOString() };
    return rebuildJob;
  }
  rebuildJob = { status: 'running', message: 'Re-chunking messages', startedAt: new Date().toISOString(), finishedAt: null, embedded: 0, toEmbed: 0 };
  const set = (patch: Partial<RebuildJob>) => (rebuildJob = { ...rebuildJob, ...patch });

  void enqueue(async () => {
    const problems: string[] = [];
    try {
      const messages = chunkMessages(true);
      set({ message: 'Re-chunking wiki pages' });
      let wiki = 0;
      try {
        wiki = (await chunkChangedWikiDocs(true)).changed;
      } catch (err) {
        problems.push(`wiki skipped (${(err as Error).message})`);
      }
      set({ message: 'Re-chunking diagrams' });
      let diagrams = 0;
      try {
        diagrams = (await chunkChangedDiagrams(true)).changed;
      } catch (err) {
        problems.push(`diagrams skipped (${(err as Error).message})`);
      }

      // Rebuilt rows have no embedding yet; clear the rest too, so every chunk
      // is embedded by the current model.
      db.prepare('UPDATE retrieval_chunks SET embedding = NULL, embedding_model = NULL').run();
      set({ message: 'Embedding' });
      try {
        await embedPending((done, total) => set({ embedded: done, toEmbed: total }));
      } catch (err) {
        problems.push(`embedding failed, keyword search only (${(err as Error).message})`);
      }

      const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
      const summary = `${n(messages, 'message chunk')}, ${n(wiki, 'wiki page')}, ${n(diagrams, 'diagram')}`;
      set({
        status: problems.length ? 'error' : 'success',
        message: problems.length ? `${summary}; ${problems.join('; ')}` : summary,
        finishedAt: new Date().toISOString(),
      });
      console.log(`[Retrieval] Rebuild finished: ${rebuildJob.message}`);
    } catch (err) {
      set({ status: 'error', message: (err as Error).message, finishedAt: new Date().toISOString() });
      console.warn('[Retrieval] Rebuild failed:', err);
    }
  });
  return rebuildJob;
}

/** Waits for queued indexing to finish (scripts). */
export function whenIdle(): Promise<unknown> {
  return queue;
}

export function getIndexStats(): {
  messageChunks: number;
  wikiChunks: number;
  diagramChunks: number;
  embedded: number;
  model: string;
} {
  const r = db
    .prepare(
      `SELECT
         SUM(CASE WHEN source_type = 'message' AND text != '' THEN 1 ELSE 0 END) AS messageChunks,
         SUM(CASE WHEN source_type = 'wiki' AND text != '' THEN 1 ELSE 0 END) AS wikiChunks,
         SUM(CASE WHEN source_type = 'diagram' AND text != '' THEN 1 ELSE 0 END) AS diagramChunks,
         SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END) AS embedded
       FROM retrieval_chunks`
    )
    .get(getEmbeddingModel()) as {
    messageChunks: number | null;
    wikiChunks: number | null;
    diagramChunks: number | null;
    embedded: number | null;
  };
  return {
    messageChunks: r.messageChunks ?? 0,
    wikiChunks: r.wikiChunks ?? 0,
    diagramChunks: r.diagramChunks ?? 0,
    embedded: r.embedded ?? 0,
    model: getEmbeddingModel(),
  };
}
