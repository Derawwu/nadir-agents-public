/**
 * Roundtable routes.
 *
 * POST /api/roundtable/start — starts a roundtable and streams progress via SSE.
 * GET  /api/roundtable/:id   — returns full roundtable with all turns.
 */

import { Router, type Request, type Response } from 'express';
import { startRoundtable, continueRoundtable, getRoundtableById } from '../chat/roundtableService';
import db from '../db/connection';

const router = Router();

router.post('/start', async (req: Request, res: Response) => {
  const { featureId, topic, agentIds } = req.body as {
    featureId?: number;
    topic?: string;
    agentIds?: number[];
  };

  if (!featureId || !topic) {
    res.status(400).json({ error: 'featureId and topic are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await startRoundtable({
      featureId,
      topic,
      agentIds,
      onEvent: (event) => {
        res.write(event);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
  } finally {
    res.end();
  }
});

router.post('/:id/continue', async (req: Request, res: Response) => {
  const roundtableId = parseInt(req.params.id, 10);
  if (isNaN(roundtableId)) {
    res.status(400).json({ error: 'Invalid roundtable id' });
    return;
  }

  const { message, agentIds } = req.body as {
    message?: string;
    agentIds?: number[];
  };

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await continueRoundtable({
      roundtableId,
      message,
      agentIds,
      onEvent: (event) => {
        res.write(event);
      },
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: errMessage })}\n\n`);
  } finally {
    res.end();
  }
});

router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid roundtable id' });
    return;
  }

  const result = getRoundtableById(id);
  if (!result) {
    res.status(404).json({ error: 'Roundtable not found' });
    return;
  }

  res.json(result);
});

/**
 * Manual termination endpoint.
 * Sets status to 'terminated' immediately without running summarization.
 * The frontend terminate button calls this.
 */
router.post('/:id/terminate', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid roundtable id' });
    return;
  }

  const existing = db
    .prepare('SELECT status FROM roundtables WHERE id = ?')
    .get(id) as { status: string } | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Roundtable not found' });
    return;
  }

  if (existing.status !== 'active') {
    res.status(409).json({ error: `Roundtable is already ${existing.status}` });
    return;
  }

  db.prepare(
    `UPDATE roundtables SET status = 'terminated', updated_at = datetime('now') WHERE id = ?`
  ).run(id);

  res.json({ ok: true });
});

export default router;
