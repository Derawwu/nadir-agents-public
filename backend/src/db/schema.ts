/**
 * Database schema creation and migration.
 *
 * All tables use IF NOT EXISTS so this is safe to run on every startup.
 * Schema changes require explicit migration statements appended below —
 * never alter the original CREATE TABLE blocks silently.
 */

import db from './connection';
import { slugifyTitle } from '../chat/slug';

/** Retrieval index table: one row per chunk of a message, wiki page or diagram. */
const RETRIEVAL_CHUNKS_SQL = `
  CREATE TABLE IF NOT EXISTS retrieval_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK(source_type IN ('message', 'wiki', 'diagram')),
    source_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    source_version TEXT,
    agent_id INTEGER,
    conversation_id INTEGER,
    message_id INTEGER,
    role TEXT,
    title TEXT,
    url TEXT,
    text TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_type, source_id, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_agent ON retrieval_chunks(source_type, agent_id);
`;

export function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      phase TEXT NOT NULL DEFAULT 'kickoff',
      locked_decisions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      feature_id INTEGER REFERENCES features(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      feature_id INTEGER REFERENCES features(id),
      type TEXT NOT NULL CHECK(type IN ('decision', 'lore', 'technical', 'visual', 'flag', 'conflict')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS roundtables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id INTEGER NOT NULL REFERENCES features(id),
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_round INTEGER NOT NULL DEFAULT 1,
      max_rounds INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS roundtable_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roundtable_id INTEGER NOT NULL REFERENCES roundtables(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      round_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      has_conflict INTEGER NOT NULL DEFAULT 0,
      conflict_target_agent_id INTEGER REFERENCES agents(id),
      conflict_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Migration: Jira integration columns ──────────────────────────────────
  // ALTER TABLE fails if the column already exists, so we check PRAGMA first.
  // Each column is added individually so a partial previous run is recoverable.
  interface ColRow { name: string }
  const existingCols = new Set(
    (db.prepare('PRAGMA table_info(features)').all() as unknown as ColRow[]).map((r) => r.name)
  );

  const newCols: [string, string][] = [
    ['jira_key',        'TEXT'],
    ['jira_type',       'TEXT'],
    ['jira_parent_key', 'TEXT'],
    ['jira_status',     'TEXT'],
    ['jira_synced_at',  'TEXT'],
    // Plane's own UUID for the work item, needed to edit it.
    ['plane_issue_id',  'TEXT'],
  ];

  for (const [col, type] of newCols) {
    if (!existingCols.has(col)) {
      db.exec(`ALTER TABLE features ADD COLUMN ${col} ${type}`);
    }
  }

  // Unique index on jira_key — SQLite allows multiple NULLs in a unique index,
  // so local-only features (jira_key = NULL) are unaffected.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_features_jira_key ON features(jira_key)'
  );

  // ── Migration: pasted-image attachments on messages ──────────────────────
  // Stores a JSON array of { filename, media_type } — the actual image bytes
  // live on disk under data/uploads/, keeping the DB itself lightweight.
  const messagesCols = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as unknown as ColRow[]).map((r) => r.name)
  );
  if (!messagesCols.has('images')) {
    db.exec('ALTER TABLE messages ADD COLUMN images TEXT');
  }

  // ── Migration: multiple chats per agent ──────────────────────────────────
  // Conversations become user-visible "chats" with a title, pin/archive state
  // and a last-activity timestamp. Chats that existed before this migration
  // are titled "Misc" so prior history stays reachable as its own chat.
  const convCols = new Set(
    (db.prepare('PRAGMA table_info(conversations)').all() as unknown as ColRow[]).map((r) => r.name)
  );
  if (!convCols.has('title')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT 'New chat'`);
    db.exec(`UPDATE conversations SET title = 'Misc'`);
  }
  if (!convCols.has('updated_at')) {
    // ALTER TABLE cannot use a non-constant default, so backfill explicitly.
    db.exec('ALTER TABLE conversations ADD COLUMN updated_at TEXT');
    db.exec(`
      UPDATE conversations SET updated_at = COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id),
        created_at
      )
    `);
  }
  if (!convCols.has('pinned')) {
    db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!convCols.has('archived_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN archived_at TEXT');
  }
  if (!convCols.has('deleted_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN deleted_at TEXT');
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated ON conversations(agent_id, updated_at)'
  );

  // ── Migration: readable chat URLs (/chat/<agent>/<slug>) ─────────────────
  // slug is derived from the title and unique per agent among live chats.
  if (!convCols.has('slug')) {
    db.exec('ALTER TABLE conversations ADD COLUMN slug TEXT');
    const rows = db
      .prepare('SELECT id, agent_id, title FROM conversations ORDER BY id ASC')
      .all() as unknown as { id: number; agent_id: number; title: string }[];
    const taken = new Map<number, Set<string>>();
    for (const row of rows) {
      const used = taken.get(row.agent_id) ?? new Set<string>();
      const base = slugifyTitle(row.title);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      taken.set(row.agent_id, used);
      db.prepare('UPDATE conversations SET slug = ? WHERE id = ?').run(slug, row.id);
    }
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_agent_slug
     ON conversations(agent_id, slug) WHERE deleted_at IS NULL`
  );

  // ── Migration: memory scoping (chat / feature / agent) ───────────────────
  // scope = 'chat'    → injected only into conversation_id's chat
  // scope = 'feature' → shared by every chat (and roundtable) on feature_id
  // scope = 'agent'   → global for the agent
  const memCols = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as unknown as ColRow[]).map((r) => r.name)
  );
  if (!memCols.has('scope')) {
    db.exec('ALTER TABLE memories ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)');
    db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'agent'`);
    db.exec(`ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);

    // Roundtable summaries are feature-wide knowledge — keep them shared.
    db.exec(`
      UPDATE memories SET scope = 'feature', source = 'roundtable'
      WHERE content LIKE 'Roundtable on "%' AND feature_id IS NOT NULL
    `);
    // Memories saved manually from chat belong to that agent's Misc chat.
    db.exec(`
      UPDATE memories SET
        scope = 'chat',
        conversation_id = (
          SELECT c.id FROM conversations c
          WHERE c.agent_id = memories.agent_id
          ORDER BY c.created_at ASC LIMIT 1
        )
      WHERE source = 'user'
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.agent_id = memories.agent_id)
    `);
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_memories_agent_scope ON memories(agent_id, scope)'
  );

  // ── Migration: LLM usage log (one row per Claude API call) ───────────────
  // cost_usd is computed at insert time from llm/pricing.ts, so later price
  // edits don't rewrite history. input_tokens excludes cached tokens, matching
  // the API's usage fields.
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      agent_id INTEGER REFERENCES agents(id),
      conversation_id INTEGER REFERENCES conversations(id),
      roundtable_id INTEGER REFERENCES roundtables(id),
      model TEXT NOT NULL,
      strategy TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT,
      latency_ms INTEGER,
      ttft_ms INTEGER,
      cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_conversation ON llm_calls(conversation_id);
  `);

  // ── Migration: running chat summary for history windowing ────────────────
  // summary covers every message with id <= summary_upto_message_id; newer
  // messages are sent verbatim.
  const convCols2 = new Set(
    (db.prepare('PRAGMA table_info(conversations)').all() as unknown as ColRow[]).map((r) => r.name)
  );
  if (!convCols2.has('summary')) {
    db.exec('ALTER TABLE conversations ADD COLUMN summary TEXT');
    db.exec('ALTER TABLE conversations ADD COLUMN summary_upto_message_id INTEGER');
  }

  // ── Migration: retrieval index (see src/retrieval/) ───────────────────────
  // One row per chunk of a chat message, wiki page or diagram. embedding is a
  // Float32Array blob; NULL until the indexer has embedded it, so keyword
  // search works even while Ollama is down. retrieval_fts mirrors text and
  // title for BM25 keyword search, keyed by chunk id (rowid).
  db.exec(`
    ${RETRIEVAL_CHUNKS_SQL}
    CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_fts USING fts5(text, title, tokenize = 'porter unicode61');
  `);

  // ── Migration: what retrieval added to each reply's request ─────────────
  const msgCols = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as unknown as ColRow[]).map((r) => r.name)
  );
  if (!msgCols.has('context_sources')) {
    db.exec('ALTER TABLE messages ADD COLUMN context_sources TEXT');
  }

  // ── Migration: agent tool use (see src/tools/ and chat/agentRun.ts) ─────
  // agent_runs: one row per chat reply that can use tools. While a write
  // action waits for approval the run is 'awaiting_approval' and `state`
  // holds the exact request (system, messages incl. thinking blocks) so the
  // reply resumes where it stopped.
  // tool_calls: every tool the agent called, with its input, result and,
  // for writes, the preview the user approved or rejected. message_id is set
  // once the reply is saved.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL CHECK(status IN ('running', 'awaiting_approval', 'done', 'error', 'abandoned')),
      state TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, status);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES agent_runs(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      message_id INTEGER REFERENCES messages(id),
      round INTEGER NOT NULL,
      tool_use_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('read', 'write')),
      input TEXT NOT NULL,
      preview TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'done', 'error', 'rejected', 'skipped')),
      summary TEXT,
      link_url TEXT,
      result TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
  `);
}
