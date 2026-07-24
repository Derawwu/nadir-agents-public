import { Router, type Request, type Response } from 'express';
import {
  getAllFeatures,
  getFeatureById,
  createFeature,
  updateFeature,
  type FeatureStatus,
  type FeaturePhase,
} from '../features/featureService';

const router = Router();

router.get('/', (_req, res: Response) => {
  res.json(getAllFeatures());
});

router.post('/', (req: Request, res: Response) => {
  const { name, description, phase, locked_decisions } = req.body as {
    name?: string;
    description?: string;
    phase?: FeaturePhase;
    locked_decisions?: string[];
  };

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const feature = createFeature({ name, description, phase, locked_decisions });
  res.status(201).json(feature);
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid feature id' });
    return;
  }

  const { name, description, status, phase, locked_decisions } = req.body as {
    name?: string;
    description?: string;
    status?: FeatureStatus;
    phase?: FeaturePhase;
    locked_decisions?: string[];
  };

  const updated = updateFeature(id, { name, description, status, phase, locked_decisions });
  if (!updated) {
    res.status(404).json({ error: 'Feature not found' });
    return;
  }

  res.json(updated);
});

router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const feature = getFeatureById(id);
  if (!feature) {
    res.status(404).json({ error: 'Feature not found' });
    return;
  }
  res.json(feature);
});

export default router;
