/**
 * Chat routes.
 *
 * POST   /api/chat/upload-image   — stores a pasted image
 * POST   /api/chat/message        — streams assistant response via SSE
 * POST   /api/chat/memory         — saves a chat-scoped memory from a message
 * GET    /api/chat/chats?agentId= — lists an agent's chats (&archived=1 to include archived)
 * POST   /api/chat/chats          — creates an empty chat
 * GET    /api/chat/chats/by-slug  — chat + messages by ?agentId=&slug=
 * GET    /api/chat/chats/:id      — chat metadata + messages
 * PATCH  /api/chat/chats/:id      — rename / pin / archive / change feature
 * DELETE /api/chat/chats/:id      — soft-deletes a chat
 *
 * SSE format: each event is `data: <json>\n\n`
 * Event types:
 *   { type: 'chunk', text } | { type: 'done', conversationId, slug }
 *   | { type: 'title', conversationId, title, slug } | { type: 'error', error }
 */

import { Router, type Request, type Response } from 'express';
import {
  sendMessage,
  saveConversationMemory,
  listChats,
  getChat,
  getChatBySlug,
  createChat,
  updateChat,
  deleteChat,
  getChatMessages,
  generateChatTitle,
} from '../chat/chatService';
import { saveImageFromDataUrl } from '../chat/imageStore';
import { MEMORY_TYPES, type MemoryType } from '../agents/memoryService';

const router = Router();

function parseId(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

// ─── Chats ───────────────────────────────────────────────────────────────────

router.get('/chats', (req: Request, res: Response) => {
  const agentId = parseId(req.query.agentId);
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  res.json(listChats(agentId, req.query.archived === '1'));
});

router.post('/chats', (req: Request, res: Response) => {
  const { agentId, featureId, title } = req.body as {
    agentId?: number;
    featureId?: number | null;
    title?: string;
  };
  if (!parseId(agentId)) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  res.status(201).json(createChat({ agentId: agentId!, featureId: featureId ?? null, title }));
});

// GET /api/chat/chats/by-slug?agentId=&slug= — resolves a readable chat URL.
router.get('/chats/by-slug', (req: Request, res: Response) => {
  const agentId = parseId(req.query.agentId);
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  const chat = agentId && slug ? getChatBySlug(agentId, slug) : undefined;
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.json({ chat, messages: getChatMessages(chat.id) });
});

router.get('/chats/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  const chat = id ? getChat(id) : undefined;
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.json({ chat, messages: getChatMessages(chat.id) });
});

router.patch('/chats/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id || !getChat(id)) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const body = req.body as {
    title?: unknown;
    pinned?: unknown;
    archived?: unknown;
    featureId?: unknown;
  };
  const patch: Parameters<typeof updateChat>[1] = {};
  if (typeof body.title === 'string') patch.title = body.title.slice(0, 120);
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;
  if (body.featureId === null || typeof body.featureId === 'number') patch.featureId = body.featureId;

  res.json(updateChat(id, patch));
});

router.delete('/chats/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id || !deleteChat(id)) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.status(204).end();
});

// ─── Messaging ───────────────────────────────────────────────────────────────

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

    const chat = getChat(result.conversationId);
    res.write(
      `data: ${JSON.stringify({ type: 'done', conversationId: result.conversationId, slug: chat?.slug ?? null })}\n\n`
    );

    // Auto-title after 'done' so the reply is never held up by it.
    if (result.needsTitle) {
      const titled = await generateChatTitle(result.conversationId, message ?? '', result.fullResponse);
      if (titled) {
        res.write(
          `data: ${JSON.stringify({
            type: 'title',
            conversationId: titled.id,
            title: titled.title,
            slug: titled.slug,
          })}\n\n`
        );
      }
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: errMessage })}\n\n`);
  } finally {
    res.end();
  }
});

router.post('/memory', (req: Request, res: Response) => {
  const { conversationId, agentId, type, content } = req.body as {
    conversationId?: number;
    agentId?: number;
    type?: MemoryType;
    content?: string;
  };

  if (!conversationId || !agentId || !type || !content) {
    res.status(400).json({ error: 'conversationId, agentId, type, and content are required' });
    return;
  }

  if (!MEMORY_TYPES.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${MEMORY_TYPES.join(', ')}` });
    return;
  }

  try {
    const memoryId = saveConversationMemory({ conversationId, agentId, type, content });
    res.status(201).json({ memoryId });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Chat not found' });
  }
});

export default router;
