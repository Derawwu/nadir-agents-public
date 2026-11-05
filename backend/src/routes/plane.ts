import { Router, type Request, type Response } from 'express';
import {
  syncPlaneFeatures,
  getPlaneProjects,
  browseFeatures,
  getFeatureContent,
  createIssue,
  updateIssue,
  addIssueComment,
  PLANE_PRIORITIES,
  type IssueFields,
  type PlanePriority,
} from '../plane/planeService';
import type { AgentRole } from '../outline/outlineService';

const router = Router();

const VALID_ROLES = new Set<AgentRole>(['narrator', 'architect', 'uxui', 'analyst']);

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && VALID_ROLES.has(value as AgentRole);
}

/** Pulls the editable fields out of a request body, rejecting wrong types. */
function readFields(body: Record<string, unknown>): IssueFields | string {
  const fields: IssueFields = {};
  for (const key of ['name', 'description', 'state'] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') return `${key} must be a string`;
    fields[key] = v;
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== 'string' || !PLANE_PRIORITIES.includes(body.priority as PlanePriority)) {
      return `priority must be one of: ${PLANE_PRIORITIES.join(', ')}`;
    }
    fields.priority = body.priority as PlanePriority;
  }
  return fields;
}

function sendWriteError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Plane request failed';
  if (message === 'Analyst has read-only access') {
    res.status(403).json({ error: message });
  } else if (/not found/i.test(message)) {
    res.status(404).json({ error: message });
  } else if (/must|Unknown state|Nothing to update|not a Plane work item/.test(message)) {
    res.status(400).json({ error: message });
  } else {
    res.status(502).json({ error: message });
  }
}

// POST /api/plane/issues
// Body: { role, name, description?, state?, priority? }
// Creates a work item in Plane as that agent's Plane user.
router.post('/issues', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!isAgentRole(body.role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  const fields = readFields(body);
  if (typeof fields === 'string') { res.status(400).json({ error: fields }); return; }
  if (!fields.name?.trim()) { res.status(400).json({ error: 'name must be a non-empty string' }); return; }
  try {
    res.status(201).json(await createIssue(body.role, { ...fields, name: fields.name }));
  } catch (err) {
    sendWriteError(res, err);
  }
});

// PATCH /api/plane/issues/:featureId
// Body: { role, name?, description?, state?, priority? }
router.patch('/issues/:featureId', async (req: Request, res: Response) => {
  const featureId = Number(req.params.featureId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(featureId)) { res.status(400).json({ error: 'featureId must be a number' }); return; }
  if (!isAgentRole(body.role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  const fields = readFields(body);
  if (typeof fields === 'string') { res.status(400).json({ error: fields }); return; }
  try {
    res.json(await updateIssue(body.role, featureId, fields));
  } catch (err) {
    sendWriteError(res, err);
  }
});

// POST /api/plane/issues/:featureId/comments
// Body: { role, text }
router.post('/issues/:featureId/comments', async (req: Request, res: Response) => {
  const featureId = Number(req.params.featureId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(featureId)) { res.status(400).json({ error: 'featureId must be a number' }); return; }
  if (!isAgentRole(body.role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  if (typeof body.text !== 'string' || !body.text.trim()) {
    res.status(400).json({ error: 'text must be a non-empty string' });
    return;
  }
  try {
    res.status(201).json(await addIssueComment(body.role, featureId, body.text));
  } catch (err) {
    sendWriteError(res, err);
  }
});

// POST /api/plane/browse
// Body: { query?: string, status?: string }
router.post('/browse', (req: Request, res: Response) => {
  const { query, status } = req.body as { query?: unknown; status?: unknown };
  const queryStr = typeof query === 'string' ? query.trim() : undefined;
  const statusStr = typeof status === 'string' ? status.trim() : undefined;

  const results = browseFeatures({ query: queryStr, status: statusStr });
  res.json({ results });
});

// POST /api/plane/issue-content
// Body: { featureId: number }
router.post('/issue-content', (req: Request, res: Response) => {
  const { featureId } = req.body as { featureId?: unknown };

  if (typeof featureId !== 'number') {
    res.status(400).json({ error: 'featureId must be a number' });
    return;
  }

  const content = getFeatureContent(featureId);
  if (!content) {
    res.status(404).json({ error: 'Feature not found' });
    return;
  }

  res.json(content);
});

router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncPlaneFeatures();
    res.json({ ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    res.status(500).json({ error: message });
  }
});

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const projects = await getPlaneProjects();
    res.json({ connected: true, projects });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    res.json({ connected: false, projects: [], error: message });
  }
});

export default router;
