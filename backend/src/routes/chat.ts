/**
 * Chat routes.
 *
 * POST /api/chat/message — streams assistant response via SSE.
 * POST /api/chat/memory  — saves a memory entry from a chat message.
 *
 * SSE format: each event is `data: <json>\n\n`
 * Event types: { type: 'chunk', text: string } | { type: 'done', conversationId: number }
 */

import { Router, type Request, type Response } from 'express';
import { sendMessage, saveConversationMemory, getConversationHistory } from '../chat/chatService';
import { saveImageFromDataUrl } from '../chat/imageStore';
import type { MemoryType } from '../agents/memoryService';

const router = Router();

// POST /api/chat/upload-image
// Body: { dataUrl: string } — a `data:image/...;base64,...` URL from a clipboard paste.
router.post('/upload-image', (req: Request, res: Response) => {
  const { dataUrl } = req.body as { dataUrl?: unknown };
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    res.status(400).json({ error: 'dataUrl must be an image data URL' });
    return;
  }

  try {
    const image = saveImageFromDataUrl(dataUrl);
    res.json({ filename: image.filename, media_type: image.media_type, url: `/uploads/${image.filename}` });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save image' });
  }
});

router.get('/conversation', (req: Request, res: Response) => {
  const rawAgentId = req.query.agentId;
  const rawFeatureId = req.query.featureId;

  if (!rawAgentId || typeof rawAgentId !== 'string') {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }

  const agentId = Number(rawAgentId);
  if (isNaN(agentId)) {
    res.status(400).json({ error: 'agentId must be a number' });
    return;
  }

  const featureId =
    rawFeatureId && typeof rawFeatureId === 'string' ? Number(rawFeatureId) : null;

  const history = getConversationHistory(agentId, featureId);
  res.json(history);
});

router.post('/message', async (req: Request, res: Response) => {
  const { agentId, featureId, message, images, conversationId } = req.body as {
    agentId?: number;
    featureId?: number | null;
    message?: string;
    images?: { filename: string; media_type: string }[];
    conversationId?: number | null;
  };

  if (!agentId || (!message && (!images || images.length === 0))) {
    res.status(400).json({ error: 'agentId and (message or images) are required' });
    return;
  }

  // Set SSE headers before any streaming begins.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind a proxy.
  res.flushHeaders();

  try {
    const result = await sendMessage({
      agentId,
      featureId: featureId ?? null,
      message: message ?? '',
      images,
      conversationId: conversationId ?? null,
      onChunk: (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
    });

    res.write(
      `data: ${JSON.stringify({ type: 'done', conversationId: result.conversationId })}\n\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
  } finally {
    res.end();
  }
});

router.post('/memory', (req: Request, res: Response) => {
  const { conversationId, agentId, featureId, type, content } = req.body as {
    conversationId?: number;
    agentId?: number;
    featureId?: number | null;
    type?: MemoryType;
    content?: string;
  };

  if (!conversationId || !agentId || !type || !content) {
    res.status(400).json({ error: 'conversationId, agentId, type, and content are required' });
    return;
  }

  const validTypes: MemoryType[] = ['decision', 'lore', 'technical', 'visual', 'flag', 'conflict'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    return;
  }

  const memoryId = saveConversationMemory({
    conversationId,
    agentId,
    featureId: featureId ?? null,
    type,
    content,
  });

  res.status(201).json({ memoryId });
});

export default router;
