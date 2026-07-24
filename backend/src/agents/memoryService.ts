/**
 * Memory read/write operations.
 *
 * Memories are agent-scoped knowledge blobs. They can be tied to a specific
 * feature (feature_id) or global (feature_id = NULL).
 *
 * node:sqlite does not support generics on prepare() — rows are cast via
 * `as` assertions. Safe here because schema is controlled and stable.
 */

import db from '../db/connection';

export type MemoryType = 'decision' | 'lore' | 'technical' | 'visual' | 'flag' | 'conflict';

export interface Memory {
  id: number;
  agent_id: number;
  feature_id: number | null;
  type: MemoryType;
  content: string;
  created_at: string;
}

export interface SaveMemoryParams {
  agentId: number;
  featureId?: number | null;
  type: MemoryType;
  content: string;
}

/**
 * Returns memories for an agent, ordered by most recent first.
 * When featureId is provided, returns memories matching that feature OR global
 * memories (feature_id IS NULL) — an agent should have access to both contexts.
 */
export function getMemoriesForAgent(
  agentId: number,
  featureId?: number | null,
  limit = 20
): Memory[] {
  if (featureId != null) {
    return db
      .prepare(
        `SELECT * FROM memories
         WHERE agent_id = ?
           AND (feature_id = ? OR feature_id IS NULL)
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(agentId, featureId, limit) as unknown as Memory[];
  }

  return db
    .prepare(
      `SELECT * FROM memories
       WHERE agent_id = ?
         AND feature_id IS NULL
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(agentId, limit) as unknown as Memory[];
}

/**
 * Persists a new memory entry.
 * Returns the rowid of the newly inserted memory.
 */
export function saveMemory(params: SaveMemoryParams): number {
  const result = db
    .prepare(
      `INSERT INTO memories (agent_id, feature_id, type, content)
       VALUES (@agentId, @featureId, @type, @content)`
    )
    .run({
      agentId: params.agentId,
      featureId: params.featureId ?? null,
      type: params.type,
      content: params.content,
    });

  // node:sqlite returns lastInsertRowid as number|bigint — coerce to number.
  return Number(result.lastInsertRowid);
}

/**
 * Formats memories into the canonical injection string used in prompts.
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `[${m.type.toUpperCase()}] ${m.content}`).join('\n');
  return `## Your Memory\n${lines}`;
}
