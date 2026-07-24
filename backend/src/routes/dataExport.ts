import { Router, type Request, type Response } from 'express';
import { startExport, getExportStatus } from '../dataExport/dataExportService';

const router = Router();

// POST /api/data-export/run
// Kicks off the data snapshot (Outline + Plane dumps, diagrams.db) in the
// background. Returns 202 once started, or 409 if one is already running.
router.post('/run', (_req: Request, res: Response) => {
  const { started, status } = startExport();
  res.status(started ? 202 : 409).json(status);
});

// GET /api/data-export/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(getExportStatus());
});

export default router;
