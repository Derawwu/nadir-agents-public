import db from '../db/connection';

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchFromPlane(path: string): Promise<any> {
  const base = getEnv('PLANE_BASE_URL').replace(/\/$/, '');
  const url = `${base}${path}`;

  const res = await fetch(url, {
    headers: {
      'X-Api-Key': getEnv('PLANE_API_TOKEN'),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Plane API error ${res.status} on ${path}: ${body}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return res.json();
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlaneState {
  id: string;
  group: string; // 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
}

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  state: string; // state UUID
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

// ─── Upsert ──────────────────────────────────────────────────────────────────

const upsertStmt = db.prepare(`
  INSERT INTO features
    (name, jira_key, jira_type, jira_parent_key, jira_status, status, jira_synced_at)
  VALUES
    (@name, @jira_key, @jira_type, @jira_parent_key, @jira_status, @status, datetime('now'))
  ON CONFLICT(jira_key) DO UPDATE SET
    name            = excluded.name,
    jira_type       = excluded.jira_type,
    jira_parent_key = excluded.jira_parent_key,
    jira_status     = excluded.jira_status,
    status          = excluded.status,
    jira_synced_at  = excluded.jira_synced_at,
    updated_at      = datetime('now')
`);

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SyncResult {
  synced: number;
  skipped: number;
}

export async function syncPlaneFeatures(): Promise<SyncResult> {
  const workspace = getEnv('PLANE_WORKSPACE_SLUG');
  const project = getEnv('PLANE_PROJECT_ID');
  const base = `/api/v1/workspaces/${workspace}/projects/${project}`;

  // Fetch states, issues, and cycles in parallel.
  const [states, issues, cycles] = await Promise.all([
    fetchAllPages<PlaneState>(`${base}/states/`),
    fetchAllPages<PlaneIssue>(`${base}/issues/`),
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
      const stateGroup = stateGroupMap.get(issue.state) ?? 'backlog';
      upsertStmt.run({
        name: issue.name,
        jira_key: `NB-${issue.sequence_id}`,
        jira_type: 'issue',
        jira_parent_key: null,
        jira_status: stateGroup,
        status: mapPlaneStatus(stateGroup),
      });
      synced++;
    }

    for (const cycle of cycles) {
      if (!cycle.name) { skipped++; continue; }
      const stateGroup = cycle.status ?? 'backlog';
      upsertStmt.run({
        name: cycle.name,
        jira_key: `NB-CYC-${cycle.id}`,
        jira_type: 'cycle',
        jira_parent_key: null,
        jira_status: stateGroup,
        status: mapPlaneStatus(stateGroup),
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
