/**
 * SQLite connection singleton using Node's built-in node:sqlite module.
 *
 * node:sqlite is synchronous and available in Node 22.5+.
 * It requires no native compilation unlike better-sqlite3.
 *
 * A single shared DatabaseSync instance is safe here because SQLite
 * WAL mode allows concurrent reads and the server is single-process.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH ?? './data/nadir.db';
const resolvedPath = path.resolve(DB_PATH);

// Ensure the data directory exists before opening the database.
const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(resolvedPath);

// WAL mode improves concurrent read performance.
db.exec('PRAGMA journal_mode = WAL');
// Foreign key enforcement is off by default in SQLite — enable it explicitly.
db.exec('PRAGMA foreign_keys = ON');

export default db;
