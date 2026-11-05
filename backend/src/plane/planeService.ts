import db from '../db/connection';
import type { AgentRole } from '../outline/outlineService';
import { planeHtmlToText, textToPlaneHtml } from './planeHtml';

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ─── Identity ────────────────────────────────────────────────────────────────
//
// Like Outline, each agent can act under its own Plane user, so edits show who
// made them. PLANE_TOKEN_<ROLE> is that user's API token; without one the agent
// falls back to the shared PLANE_API_TOKEN. The analyst only reads.

const ROLE_TOKEN_ENV: Record<AgentRole, string> = {
  narrator: 'PLANE_TOKEN_NARRATOR',
  architect: 'PLANE_TOKEN_ARCHITECT',
  uxui: 'PLANE_TOKEN_UXUI',
  analyst: 'PLANE_TOKEN_ANALYST',
};

function tokenFor(role?: AgentRole): string {
  if (role) {
    const own = process.env[ROLE_TOKEN_ENV[role]];
    if (own) return own;
  }
  return getEnv('PLANE_API_TOKEN');
}

function assertCanWrite(role: AgentRole): void {
  if (role === 'analyst') throw new Error('Analyst has read-only access');
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function planeRequest(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; role?: AgentRole } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const base = getEnv('PLANE_BASE_URL').replace(/\/$/, '');
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'X-Api-Key': tokenFor(opts.role),
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403 && opts.role) {
      throw new Error(
        `Plane refused the ${opts.role} agent (403 on ${path}). Is its Plane user a member of the project?`
      );
    }
    throw new Error(`Plane API error ${res.status} on ${path}: ${body}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchFromPlane(path: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return planeRequest(path);
}

function projectBase(): string {
  return `/api/v1/workspaces/${getEnv('PLANE_WORKSPACE_SLUG')}/projects/${getEnv('PLANE_PROJECT_ID')}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlaneState {
  id: string;
  name: string;
  group: string; // 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
  default?: boolean;
}

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  state: string; // state UUID
  description_html?: string | null;
  priority?: string;
}

interface PlanePage<T> {
  results: T[];
  next_page_results: boolean;
  next_cursor: string;
}

interface PlaneCycle {
  id: string;
  name: string;
  status: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

async function fetchAllPages<T>(basePath: string): Promise<T[]> {
  const all: T[] = [];
  let cursor = '';

  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const url = cursor ? `${basePath}${sep}cursor=${cursor}&per_page=100` : `${basePath}${sep}per_page=100`;
    const page = (await fetchFromPlane(url)) as PlanePage<T>;
    all.push(...(page.results ?? []));
    if (!page.next_page_results) break;
    cursor = page.next_cursor;
  }

  return all;
}

// ─── Status mapping ──────────────────────────────────────────────────────────

function mapPlaneStatus(stateGroup: string): string {
  switch (stateGroup) {
    case 'started': return 'active';
    case 'completed':
    case 'cancelled': return 'closed';
    default: return 'backlog'; // 'unstarted', 'backlog', unknown
  }
}

/** App statuses → the Plane state group they land in when written back. */
const APP_STATUS_TO_GROUP: Record<string, string> = {
  backlog: 'backlog',
  todo: 'unstarted',
  active: 'started',
  review: 'started',
  closed: 'completed',
  done: 'completed',
};

/**
 * Resolves a state the caller asked for to a Plane state UUID. Accepts a
 * Plane state name ("In Progress"), a state group ("started") or an app
 * status ("active"); within a group the default state wins, else the first.
 */
function resolveState(states: PlaneState[], wanted: string): PlaneState {
  const w = wanted.trim().toLowerCase();
  const byName = states.find((s) => s.name.toLowerCase() === w);
  if (byName) return byName;
  const group = APP_STATUS_TO_GROUP[w] ?? w;
  const inGroup = states.filter((s) => s.group === group);
  const pick = inGroup.find((s) => s.default) ?? inGroup[0];
  if (!pick) {
    throw new Error(
      `Unknown state "${wanted}". Use one of: ${states.map((s) => s.name).join(', ')}`
    );
  }
  return pick;
}

export const PLANE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type PlanePriority = (typeof PLANE_PRIORITIES)[number];

// ─── Upsert ──────────────────────────────────────────────────────────────────
//
// Plane is the source of truth for the fields it owns. The description is
// only overwritten when Plane has one, so a note typed locally on an issue
// with an empty Plane description survives a sync. Prepared lazily: the
// plane_issue_id column is added by the schema migration at startup.

let upsertStmtCache: ReturnType<typeof db.prepare> | null = null;
function upsertStmt() {
  upsertStmtCache ??= db.prepare(`
    INSERT INTO features
      (name, description, jira_key, jira_type, jira_parent_key, jira_status, status, plane_issue_id, jira_synced_at)
    VALUES
      (@name, @description, @jira_key, @jira_type, @jira_parent_key, @jira_status, @status, @plane_issue_id, datetime('now'))
    ON CONFLICT(jira_key) DO UPDATE SET
      name            = excluded.name,
      description     = COALESCE(NULLIF(excluded.description, ''), features.description),
      jira_type       = excluded.jira_type,
      jira_parent_key = excluded.jira_parent_key,
      jira_status     = excluded.jira_status,
      status          = excluded.status,
      plane_issue_id  = COALESCE(excluded.plane_issue_id, features.plane_issue_id),
      jira_synced_at  = excluded.jira_synced_at,
      updated_at      = datetime('now')
  `);
  return upsertStmtCache;
}

function issueKey(issue: PlaneIssue): string {
  return `NB-${issue.sequence_id}`;
}

function upsertIssue(issue: PlaneIssue, stateGroupMap: Map<string, string>): void {
  const stateGroup = stateGroupMap.get(issue.state) ?? 'backlog';
  upsertStmt().run({
    name: issue.name,
    description: planeHtmlToText(issue.description_html),
    jira_key: issueKey(issue),
    jira_type: 'issue',
    jira_parent_key: null,
    jira_status: stateGroup,
    status: mapPlaneStatus(stateGroup),
    plane_issue_id: issue.id,
  });
}

function featureIdForKey(key: string): number | null {
  const row = db.prepare('SELECT id FROM features WHERE jira_key = ?').get(key) as { id: number } | undefined;
  return row?.id ?? null;
}

// ─── Public API: sync ────────────────────────────────────────────────────────

export interface SyncResult {
  synced: number;
  skipped: number;
}

export async function syncPlaneFeatures(): Promise<SyncResult> {
  const base = projectBase();

  // Fetch states, work items, and cycles in parallel.
  const [states, issues, cycles] = await Promise.all([
    fetchAllPages<PlaneState>(`${base}/states/`),
    fetchAllPages<PlaneIssue>(`${base}/work-items/`),
    fetchAllPages<PlaneCycle>(`${base}/cycles/`),
  ]);

  // Build state UUID → group map.
  const stateGroupMap = new Map<string, string>(states.map((s) => [s.id, s.group]));

  let synced = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const issue of issues) {
      if (!issue.name) { skipped++; continue; }
      upsertIssue(issue, stateGroupMap);
      synced++;
    }

    for (const cycle of cycles) {
      if (!cycle.name) { skipped++; continue; }
      const stateGroup = cycle.status ?? 'backlog';
      upsertStmt().run({
        name: cycle.name,
        description: null,
        jira_key: `NB-CYC-${cycle.id}`,
        jira_type: 'cycle',
        jira_parent_key: null,
        jira_status: stateGroup,
        status: mapPlaneStatus(stateGroup),
        plane_issue_id: null,
      });
      synced++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { synced, skipped };
}

// ─── Public API: writes ──────────────────────────────────────────────────────
//
// Every write goes to Plane first, then mirrors the result into the local
// features row straight away, so the app doesn't wait for the next sync.
// There is deliberately no delete.

export interface PlaneWriteResult {
  featureId: number;
  key: string;
  name: string;
  url: string;
}

function issueUrl(issue: PlaneIssue): string {
  const base = getEnv('PLANE_BASE_URL').replace(/\/$/, '');
  return `${base}/${getEnv('PLANE_WORKSPACE_SLUG')}/projects/${getEnv('PLANE_PROJECT_ID')}/issues/${issue.id}`;
}

async function getStates(): Promise<PlaneState[]> {
  return fetchAllPages<PlaneState>(`${projectBase()}/states/`);
}

function toResult(issue: PlaneIssue): PlaneWriteResult {
  const key = issueKey(issue);
  return { featureId: featureIdForKey(key) ?? -1, key, name: issue.name, url: issueUrl(issue) };
}

export interface IssueFields {
  name?: string;
  /** Plain text / light markdown; converted to Plane HTML. */
  description?: string;
  /** Plane state name, state group, or app status (backlog/active/closed…). */
  state?: string;
  priority?: PlanePriority;
}

async function buildIssueBody(fields: IssueFields, states: PlaneState[]): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    if (!fields.name.trim()) throw new Error('name must not be empty');
    body.name = fields.name.trim().slice(0, 255);
  }
  if (fields.description !== undefined) body.description_html = textToPlaneHtml(fields.description);
  if (fields.state !== undefined) body.state = resolveState(states, fields.state).id;
  if (fields.priority !== undefined) {
    if (!PLANE_PRIORITIES.includes(fields.priority)) {
      throw new Error(`priority must be one of: ${PLANE_PRIORITIES.join(', ')}`);
    }
    body.priority = fields.priority;
  }
  return body;
}

export async function createIssue(role: AgentRole, fields: IssueFields & { name: string }): Promise<PlaneWriteResult> {
  assertCanWrite(role);
  const states = await getStates();
  const body = await buildIssueBody(fields, states);
  const issue = (await planeRequest(`${projectBase()}/work-items/`, { method: 'POST', body, role })) as PlaneIssue;
  upsertIssue(issue, new Map(states.map((s) => [s.id, s.group])));
  return toResult(issue);
}

/** Looks up the Plane UUID for a local feature, syncing once if it's missing. */
async function planeIdForFeature(featureId: number): Promise<string> {
  const read = () =>
    db.prepare('SELECT plane_issue_id, jira_type FROM features WHERE id = ?').get(featureId) as
      | { plane_issue_id: string | null; jira_type: string | null }
      | undefined;
  let row = read();
  if (!row) throw new Error(`Feature ${featureId} not found`);
  if (row.jira_type !== 'issue') throw new Error(`Feature ${featureId} is not a Plane work item`);
  if (!row.plane_issue_id) {
    await syncPlaneFeatures();
    row = read();
  }
  if (!row?.plane_issue_id) throw new Error(`Feature ${featureId} has no Plane work item ID`);
  return row.plane_issue_id;
}

export async function updateIssue(role: AgentRole, featureId: number, fields: IssueFields): Promise<PlaneWriteResult> {
  assertCanWrite(role);
  if (Object.values(fields).every((v) => v === undefined)) throw new Error('Nothing to update');
  const planeId = await planeIdForFeature(featureId);
  const states = await getStates();
  const body = await buildIssueBody(fields, states);
  const issue = (await planeRequest(`${projectBase()}/work-items/${planeId}/`, {
    method: 'PATCH',
    body,
    role,
  })) as PlaneIssue;
  upsertIssue(issue, new Map(states.map((s) => [s.id, s.group])));
  return toResult(issue);
}

export async function addIssueComment(
  role: AgentRole,
  featureId: number,
  text: string
): Promise<PlaneWriteResult & { commentId: string }> {
  assertCanWrite(role);
  if (!text.trim()) throw new Error('comment must not be empty');
  const planeId = await planeIdForFeature(featureId);
  const comment = (await planeRequest(`${projectBase()}/work-items/${planeId}/comments/`, {
    method: 'POST',
    body: { comment_html: textToPlaneHtml(text) },
    role,
  })) as { id: string };
  const issue = (await planeRequest(`${projectBase()}/work-items/${planeId}/`)) as PlaneIssue;
  return { ...toResult(issue), commentId: comment.id };
}

// ─── Public API: reads ───────────────────────────────────────────────────────

export interface FeatureBrowseResult {
  id: number;
  jira_key: string | null;
  name: string;
  status: string;
  phase: string;
}

export interface FeatureContent {
  id: number;
  jira_key: string | null;
  name: string;
  description: string | null;
  locked_decisions: string[] | null;
  status: string;
  phase: string;
  jira_status: string | null;
}

interface FeatureContentRow {
  id: number;
  jira_key: string | null;
  name: string;
  description: string | null;
  locked_decisions: string | null;
  status: string;
  phase: string;
  jira_status: string | null;
}

export function browseFeatures(params: { query?: string; status?: string }): FeatureBrowseResult[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (params.status) {
    conditions.push('status = ?');
    values.push(params.status);
  }
  if (params.query) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    values.push(`%${params.query}%`, `%${params.query}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, jira_key, name, status, phase FROM features ${where} ORDER BY updated_at DESC LIMIT 50`;

  return db.prepare(sql).all(...values) as unknown as FeatureBrowseResult[];
}

export function getFeatureContent(featureId: number): FeatureContent | null {
  const row = db
    .prepare(
      `SELECT id, jira_key, name, description, locked_decisions, status, phase, jira_status
       FROM features WHERE id = ?`
    )
    .get(featureId) as FeatureContentRow | undefined;

  if (!row) return null;

  let lockedDecisions: string[] | null = null;
  if (row.locked_decisions) {
    try {
      lockedDecisions = JSON.parse(row.locked_decisions) as string[];
    } catch {
      lockedDecisions = null;
    }
  }

  return {
    id: row.id,
    jira_key: row.jira_key,
    name: row.name,
    description: row.description,
    locked_decisions: lockedDecisions,
    status: row.status,
    phase: row.phase,
    jira_status: row.jira_status,
  };
}

export async function getPlaneProjects(): Promise<unknown[]> {
  const workspace = getEnv('PLANE_WORKSPACE_SLUG');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return fetchFromPlane(`/api/v1/workspaces/${workspace}/projects/`);
}
