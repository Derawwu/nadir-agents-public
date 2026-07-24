import { Router, type Request, type Response } from 'express';
import { syncPlaneFeatures, getPlaneProjects, browseFeatures, getFeatureContent } from '../plane/planeService';

const router = Router();

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
