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
    CREATE TABLE IF NOT EXISTS diagram_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES diagram_folders(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS diagrams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER REFERENCES diagram_folders(id),
      name TEXT NOT NULL,
      description TEXT,
      graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
