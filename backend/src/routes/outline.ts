import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getCollections,
  getOrCreateCollection,
  createDocument,
  searchDocuments,
  saveMemoryToOutline,
  browseDocuments,
  getDocumentById,
} from '../outline/outlineService';
import type { AgentRole } from '../outline/outlineService';

const router = Router();

// GET /api/outline/collections
// Returns all collections visible to the narrator token (used for the wiki tree nav).
router.get('/collections', async (_req: Request, res: Response) => {
  try {
    const collections = await getCollections('narrator');
    res.json({ collections });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Outline request failed' });
  }
});

const VALID_ROLES = new Set<AgentRole>(['narrator', 'architect', 'uxui', 'analyst']);

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && VALID_ROLES.has(value as AgentRole);
}

// POST /api/outline/browse
// Body: { role: AgentRole, query?: string, collectionId?: string }
router.post('/browse', async (req: Request, res: Response) => {
  const { role, query, collectionId } = req.body as {
    role: unknown;
    query?: unknown;
    collectionId?: unknown;
  };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }

  const queryStr = typeof query === 'string' ? query.trim() : undefined;
  const collectionIdStr = typeof collectionId === 'string' ? collectionId.trim() : undefined;

  try {
    const results = await browseDocuments(role, queryStr, collectionIdStr);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Outline request failed' });
  }
});

// POST /api/outline/document-content
// Body: { role: AgentRole, documentId: string }
router.post('/document-content', async (req: Request, res: Response) => {
  const { role, documentId } = req.body as { role: unknown; documentId: unknown };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (typeof documentId !== 'string' || !documentId.trim()) {
    res.status(400).json({ error: 'documentId must be a non-empty string' });
    return;
  }

  try {
    const doc = await getDocumentById(role, documentId);
    res.json({ id: doc.id, title: doc.title, text: doc.text, url: doc.url });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Outline request failed' });
  }
});

// GET /api/outline/status
// Tests connection using the narrator token and returns collection count.
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const collections = await getCollections('narrator');
    res.json({ connected: true, collectionsCount: collections.length });
  } catch (err) {
    res.json({
      connected: false,
      collectionsCount: 0,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// POST /api/outline/quick-search
// Body: { role: AgentRole, query: string }
// Returns top 5 results as { title, snippet, url }
router.post('/quick-search', async (req: Request, res: Response) => {
  const { role, query } = req.body as { role: unknown; query: unknown };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  if (typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'query must be a non-empty string' });
    return;
  }

  try {
    const results = await searchDocuments(role, query);
    const top5 = results.slice(0, 5).map((doc, i) => ({
      title: doc.title,
      snippet: i === 0 ? doc.text : doc.text.length > 300 ? doc.text.slice(0, 300) : doc.text,
      url: doc.url,
    }));
    res.json({ results: top5 });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Outline request failed' });
  }
});

// POST /api/outline/search
// Body: { role: AgentRole, query: string }
router.post('/search', async (req: Request, res: Response) => {
  const { role, query } = req.body as { role: unknown; query: unknown };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  if (typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'query must be a non-empty string' });
    return;
  }

  try {
    const results = await searchDocuments(role, query);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Outline request failed' });
  }
});

// POST /api/outline/document
// Body: { role: AgentRole, title: string, text: string, collectionName: string }
// Gets or creates the named collection, then creates the document inside it.
router.post('/document', async (req: Request, res: Response) => {
  const { role, title, text, collectionName } = req.body as {
    role: unknown;
    title: unknown;
    text: unknown;
    collectionName: unknown;
  };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role. Must be one of: narrator, architect, uxui, analyst' });
    return;
  }
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title must be a non-empty string' });
    return;
  }
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text must be a string' });
    return;
  }
  if (typeof collectionName !== 'string' || !collectionName.trim()) {
    res.status(400).json({ error: 'collectionName must be a non-empty string' });
    return;
  }

  try {
    const collectionId = await getOrCreateCollection(role, collectionName);
    const doc = await createDocument({ role, title, text, collectionId });
    res.json({ document: doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Outline request failed';
    if (message === 'Analyst has read-only access') {
      res.status(403).json({ error: message });
      return;
    }
    res.status(502).json({ error: message });
  }
});

// POST /api/outline/memory
// Convenience endpoint used by the frontend memory panel's "Save to Wiki" button.
// Body: { role: AgentRole, featureName: string, memoryType: string, content: string }
router.post('/memory', async (req: Request, res: Response) => {
  const { role, featureName, memoryType, content } = req.body as {
    role: unknown;
    featureName: unknown;
    memoryType: unknown;
    content: unknown;
  };

  if (!isAgentRole(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (typeof featureName !== 'string' || !featureName.trim()) {
    res.status(400).json({ error: 'featureName must be a non-empty string' });
    return;
  }
  if (typeof memoryType !== 'string' || !memoryType.trim()) {
    res.status(400).json({ error: 'memoryType must be a non-empty string' });
    return;
  }
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }

  try {
    await saveMemoryToOutline({ role, featureName, memoryType, content });
    res.json({ saved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Outline request failed';
    if (message === 'Analyst has read-only access') {
      res.status(403).json({ error: message });
      return;
    }
    res.status(502).json({ error: message });
  }
});

export default router;
