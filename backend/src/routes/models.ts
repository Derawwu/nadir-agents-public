import { Router, type Request, type Response } from 'express';
import { getModelStatus } from '../llm/modelStatus';

const router = Router();

/**
 * GET /api/models/status[?refresh=1]
 * Whether each configured model is current, deprecated, or has a newer
 * model in its family. Cached for an hour unless refresh=1.
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    res.json(await getModelStatus(req.query.refresh === '1'));
  } catch (err) {
    console.error('[Models] status check failed:', err);
    res.status(502).json({ error: 'Could not reach the Anthropic Models API' });
  }
});

export default router;
