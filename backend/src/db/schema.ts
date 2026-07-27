/**
 * Database schema creation and migration.
 *
 * All tables use IF NOT EXISTS so this is safe to run on every startup.
 * Schema changes require explicit migration statements appended below —
 * never alter the original CREATE TABLE blocks silently.
 */

import db from './connection';

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
}
