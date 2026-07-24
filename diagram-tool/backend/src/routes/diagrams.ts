import { Router, type Request, type Response } from 'express';
import {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  getFolderPath,
  listDiagrams,
  createDiagram,
  getDiagram,
  updateDiagram,
  deleteDiagram,
  serializeDiagramForAgent,
} from '../diagrams/diagramService';

const router = Router();

// ── Folders ──────────────────────────────────────────────────────────────

router.get('/folders', (_req: Request, res: Response) => {
  res.json({ folders: listFolders() });
});

router.post('/folders', (req: Request, res: Response) => {
  const { name, parent_id } = req.body as { name?: unknown; parent_id?: unknown };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  const parentId = typeof parent_id === 'number' ? parent_id : null;
  res.json({ folder: createFolder(name.trim(), parentId) });
});

router.patch('/folders/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name } = req.body as { name?: unknown };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  const folder = renameFolder(id, name.trim());
  if (!folder) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }
  res.json({ folder });
});

router.delete('/folders/:id', (req: Request, res: Response) => {
  deleteFolder(Number(req.params.id));
  res.json({ deleted: true });
});

// ── Diagrams ─────────────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  const folderIdParam = req.query.folder_id;
  const folderId = typeof folderIdParam === 'string' ? Number(folderIdParam) : undefined;
  const diagrams = listDiagrams(folderId).map((d) => ({
    ...d,
    folder_path: getFolderPath(d.folder_id),
  }));
  res.json({ diagrams });
});

router.post('/', (req: Request, res: Response) => {
  const { name, folder_id, description } = req.body as {
    name?: unknown;
    folder_id?: unknown;
    description?: unknown;
  };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  const folderId = typeof folder_id === 'number' ? folder_id : null;
  const desc = typeof description === 'string' ? description : undefined;
  res.json({ diagram: createDiagram(name.trim(), folderId, desc) });
});

router.get('/:id', (req: Request, res: Response) => {
  const diagram = getDiagram(Number(req.params.id));
  if (!diagram) {
    res.status(404).json({ error: 'Diagram not found' });
    return;
  }
  res.json({ diagram });
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, description, graph_json, folder_id } = req.body as {
    name?: unknown;
    description?: unknown;
    graph_json?: unknown;
    folder_id?: unknown;
  };

  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  if (graph_json !== undefined && typeof graph_json !== 'string') {
    res.status(400).json({ error: 'graph_json must be a JSON string' });
    return;
  }

  const diagram = updateDiagram(id, {
    name: typeof name === 'string' ? name.trim() : undefined,
    description: typeof description === 'string' ? description : undefined,
    graph_json: typeof graph_json === 'string' ? graph_json : undefined,
    folder_id: folder_id === null ? null : typeof folder_id === 'number' ? folder_id : undefined,
  });

  if (!diagram) {
    res.status(404).json({ error: 'Diagram not found' });
    return;
  }
  res.json({ diagram });
});

router.delete('/:id', (req: Request, res: Response) => {
  deleteDiagram(Number(req.params.id));
  res.json({ deleted: true });
});

router.get('/:id/agent-format', (req: Request, res: Response) => {
  const text = serializeDiagramForAgent(Number(req.params.id));
  if (text === null) {
    res.status(404).json({ error: 'Diagram not found' });
    return;
  }
  res.json({ text });
});

export default router;
