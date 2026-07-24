import { Router, type Request, type Response } from 'express';
import { listDiagramsFromTool, getAgentFormatFromTool } from '../diagrams/diagramClient';

const router = Router();

// GET /api/diagrams/list
// Proxies the standalone diagram-tool app so the frontend can show a picker
// without talking to a different origin/port directly.
router.get('/list', async (_req: Request, res: Response) => {
  try {
    const diagrams = await listDiagramsFromTool();
    res.json({ diagrams });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Diagram tool request failed' });
  }
});

// GET /api/diagrams/:id/agent-format
router.get('/:id/agent-format', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id must be a number' });
    return;
  }
  try {
    const text = await getAgentFormatFromTool(id);
    if (text === null) {
      res.status(404).json({ error: 'Diagram not found' });
      return;
    }
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Diagram tool request failed' });
  }
});

export default router;
