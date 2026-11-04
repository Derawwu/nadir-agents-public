import { Router, type Request, type Response } from 'express';
import { getAllAgents } from '../agents/agentService';
import {
  getMemoriesForContext,
  getMemoryById,
  updateMemoryScope,
  MEMORY_SCOPES,
  type MemoryScope,
} from '../agents/memoryService';

const router = Router();

router.get('/', (_req, res: Response) => {
  const agents = getAllAgents();
  res.json(agents);
});

/**
 * GET /api/agents/:id/memories
 * Query params: chatId, featureId (both optional), limit (optional, default 50)
 *
 * Returns every memory visible in that context — agent-wide, the feature's,
 * and the chat's — each tagged with its scope. Used by the MemoryPanel.
 */
router.get('/:id/memories', (req: Request, res: Response) => {
  const agentId = parseInt(req.params.id, 10);
  if (isNaN(agentId)) {
    res.status(400).json({ error: 'Invalid agent id' });
    return;
  }

  const featureId = req.query.featureId ? parseInt(req.query.featureId as string, 10) : null;
  const conversationId = req.query.chatId ? parseInt(req.query.chatId as string, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

  res.json(getMemoriesForContext({ agentId, featureId, conversationId, limit }));
});

/**
 * PATCH /api/agents/:id/memories/:memoryId
 * Body: { scope: 'chat' | 'feature' | 'agent', chatId?, featureId? }
 *
 * Moves a memory between scopes (e.g. promote a chat memory to agent-wide).
 */
router.patch('/:id/memories/:memoryId', (req: Request, res: Response) => {
  const agentId = parseInt(req.params.id, 10);
  const memoryId = parseInt(req.params.memoryId, 10);
  const memory = isNaN(memoryId) ? undefined : getMemoryById(memoryId);
  if (!memory || memory.agent_id !== agentId) {
    res.status(404).json({ error: 'Memory not found' });
    return;
  }

  const { scope, chatId, featureId } = req.body as {
    scope?: MemoryScope;
    chatId?: number | null;
    featureId?: number | null;
  };
  if (!scope || !MEMORY_SCOPES.includes(scope)) {
    res.status(400).json({ error: `scope must be one of: ${MEMORY_SCOPES.join(', ')}` });
    return;
  }

  try {
    res.json(updateMemoryScope(memoryId, scope, { conversationId: chatId, featureId }));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid scope change' });
  }
});

export default router;
