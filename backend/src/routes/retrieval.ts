import { Router, type Request, type Response } from 'express';
import { getIndexStats, getRebuildJob, indexNewMessages, startRebuild, syncSources } from '../retrieval/indexer';
import { searchChunks, type SearchMode } from '../retrieval/search';

const router = Router();

/** GET /api/retrieval/status: index size, embedding model and the last full rebuild. */
router.get('/status', (_req: Request, res: Response) => {
  res.json({ ...getIndexStats(), rebuild: getRebuildJob() });
});

/**
 * POST /api/retrieval/rebuild: re-chunk and re-embed everything in the
 * background. 202 when started, 409 with the running job if one is going.
 */
router.post('/rebuild', (_req: Request, res: Response) => {
  const wasRunning = getRebuildJob().status === 'running';
  const job = startRebuild();
  res.status(wasRunning ? 409 : job.status === 'running' ? 202 : 400).json(job);
});

/** POST /api/retrieval/reindex: index new messages and re-sync changed wiki pages and diagrams now. */
router.post('/reindex', async (_req: Request, res: Response) => {
  await indexNewMessages();
  await syncSources();
  res.json(getIndexStats());
});

/**
 * GET /api/retrieval/search?q=...&mode=hybrid|bm25|vector&limit=10
 * Debug view of raw search results over the whole index (no per-chat filter).
 */
router.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  const mode = (['bm25', 'vector', 'hybrid'].includes(String(req.query.mode)) ? req.query.mode : 'hybrid') as SearchMode;
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
  res.json(await searchChunks(q, { mode, limit }));
});

export default router;
