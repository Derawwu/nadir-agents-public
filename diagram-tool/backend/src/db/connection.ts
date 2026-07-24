/**
 * SQLite connection singleton using Node's built-in node:sqlite module.
 *
 * node:sqlite is synchronous and available in Node 22.5+.
 * It requires no native compilation unlike better-sqlite3.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH ?? './data/diagrams.db';
const resolvedPath = path.resolve(DB_PATH);

const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(resolvedPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

export default db;
