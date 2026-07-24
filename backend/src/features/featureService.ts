/**
 * CRUD operations for features.
 *
 * locked_decisions is stored as a JSON string in SQLite and
 * serialized/deserialized here so callers always receive typed objects.
 *
 * node:sqlite rows are cast via `as` assertions — safe because schema is stable.
 */

import db from '../db/connection';

export type FeatureStatus = 'backlog' | 'active' | 'review' | 'closed';
export type FeaturePhase = 'kickoff' | 'spec' | 'design' | 'build' | 'review';

export interface Feature {
  id: number;
  name: string;
  description: string | null;
  status: FeatureStatus;
  phase: FeaturePhase;
  locked_decisions: string[] | null;
  jira_key: string | null;
  jira_type: string | null;       // 'epic' | 'issue' | null
  jira_parent_key: string | null;
  jira_status: string | null;     // raw Jira status string
  jira_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row as stored in SQLite — locked_decisions is a JSON string. */
interface FeatureRow {
  id: number;
  name: string;
  description: string | null;
  status: string;
  phase: string;
  locked_decisions: string | null;
  jira_key: string | null;
  jira_type: string | null;
  jira_parent_key: string | null;
  jira_status: string | null;
  jira_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function deserialize(row: FeatureRow): Feature {
  return {
    ...row,
    status: row.status as FeatureStatus,
    phase: row.phase as FeaturePhase,
    locked_decisions: row.locked_decisions ? (JSON.parse(row.locked_decisions) as string[]) : null,
    // Jira columns pass through as-is; they are null for local-only features.
  };
}

export function getAllFeatures(): Feature[] {
  const rows = db
    .prepare('SELECT * FROM features ORDER BY created_at DESC')
    .all() as unknown as FeatureRow[];
  return rows.map(deserialize);
}

export function getFeatureById(id: number): Feature | undefined {
  const row = db
    .prepare('SELECT * FROM features WHERE id = ?')
    .get(id) as unknown as FeatureRow | undefined;
  return row ? deserialize(row) : undefined;
}

export interface CreateFeatureParams {
  name: string;
  description?: string;
  phase?: FeaturePhase;
  locked_decisions?: string[];
}

export function createFeature(params: CreateFeatureParams): Feature {
  const result = db
    .prepare(
      `INSERT INTO features (name, description, phase, locked_decisions)
       VALUES (@name, @description, @phase, @locked_decisions)`
    )
    .run({
      name: params.name,
      description: params.description ?? null,
      phase: params.phase ?? 'kickoff',
      locked_decisions: params.locked_decisions ? JSON.stringify(params.locked_decisions) : null,
    });

  const created = getFeatureById(Number(result.lastInsertRowid));
  if (!created) throw new Error('Failed to retrieve newly created feature');
  return created;
}

export interface UpdateFeatureParams {
  name?: string;
  description?: string;
  status?: FeatureStatus;
  phase?: FeaturePhase;
  locked_decisions?: string[];
}

export function updateFeature(id: number, params: UpdateFeatureParams): Feature | undefined {
  const existing = getFeatureById(id);
  if (!existing) return undefined;

  // Build update fields dynamically — only set what was provided.
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: Record<string, unknown> = { id };

  if (params.name !== undefined) { fields.push('name = @name'); values.name = params.name; }
  if (params.description !== undefined) { fields.push('description = @description'); values.description = params.description; }
  if (params.status !== undefined) { fields.push('status = @status'); values.status = params.status; }
  if (params.phase !== undefined) { fields.push('phase = @phase'); values.phase = params.phase; }
  if (params.locked_decisions !== undefined) {
    fields.push('locked_decisions = @locked_decisions');
    values.locked_decisions = JSON.stringify(params.locked_decisions);
  }

  // node:sqlite requires Record<string, SQLInputValue>; cast is safe because all
  // values assigned above are string | number | null which are valid SQLInputValues.
  db.prepare(`UPDATE features SET ${fields.join(', ')} WHERE id = @id`).run(
    values as Record<string, string | number | null | bigint | Uint8Array>
  );
  return getFeatureById(id);
}
