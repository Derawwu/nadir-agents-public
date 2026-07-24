import { Router, type Request, type Response } from 'express';
import { getAllAgents } from '../agents/agentService';
import { getMemoriesForAgent } from '../agents/memoryService';

const router = Router();

router.get('/', (_req, res: Response) => {
  const agents = getAllAgents();
  res.json(agents);
});

/**
 * GET /api/agents/:id/memories
 * Query params: featureId (optional), limit (optional, default 20)
 *
 * Used by the MemoryPanel to display an agent's memory context.
 */
router.get('/:id/memories', (req: Request, res: Response) => {
  const agentId = parseInt(req.params.id, 10);
  if (isNaN(agentId)) {
    res.status(400).json({ error: 'Invalid agent id' });
    return;
  }

  const featureId = req.query.featureId ? parseInt(req.query.featureId as string, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

  const memories = getMemoriesForAgent(agentId, featureId, limit);
  res.json(memories);
});

export default router;
