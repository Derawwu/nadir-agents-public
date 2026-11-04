import { Router, type Request, type Response } from 'express';
import { getChatUsage, getUsageSummary } from '../llm/usageService';
import type { CallKind } from '../llm/usageLog';

const router = Router();

const KINDS: CallKind[] = ['chat', 'roundtable_turn', 'roundtable_summary', 'title', 'chat_summary'];

/**
 * GET /api/usage/summary?days=30&kind=chat
 * days: positive integer, or "all" (default 30). kind: optional CallKind.
 */
router.get('/summary', (req: Request, res: Response) => {
  const daysRaw = String(req.query.days ?? '30');
  const days = daysRaw === 'all' ? null : parseInt(daysRaw, 10);
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
    res.status(400).json({ error: 'days must be a positive integer or "all"' });
    return;
  }
  const kindRaw = req.query.kind ? String(req.query.kind) : null;
  if (kindRaw && !KINDS.includes(kindRaw as CallKind)) {
    res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    return;
  }
  res.json(getUsageSummary({ days, kind: (kindRaw as CallKind) ?? null }));
});

/** GET /api/usage/chats/:id — totals and last reply for one chat (header badge). */
router.get('/chats/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid chat id' });
    return;
  }
  res.json(getChatUsage(id));
});

export default router;
