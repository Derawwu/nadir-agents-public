/**
 * CRUD operations for agents.
 *
 * Agents are seeded at startup and not mutated at runtime —
 * only reads are exposed here.
 *
 * node:sqlite does not support generics on prepare(), so rows are cast
 * via `as` assertions after retrieval. This is intentional and safe because
 * the schema is controlled by us and does not change at runtime.
 */

import db from '../db/connection';

export interface Agent {
  id: number;
  name: string;
  role: string;
  system_prompt: string;
  created_at: string;
}

export function getAllAgents(): Agent[] {
  // Double-cast justified: node:sqlite returns Record<string,SQLOutputValue>[], which doesn't
  // structurally match Agent[] even though the schema guarantees the columns exist.
  return db.prepare('SELECT * FROM agents ORDER BY id ASC').all() as unknown as Agent[];
}

export function getAgentById(id: number): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as Agent | undefined;
}

export function getAgentByName(name: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as unknown as Agent | undefined;
}
