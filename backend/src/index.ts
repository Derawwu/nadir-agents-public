/**
 * Express application entry point.
 *
 * Startup order:
 *   1. Run DB migrations (idempotent schema creation)
 *   2. Seed agents (idempotent — skips if already present)
 *   3. Mount routes
 *   4. Start HTTP server
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runMigrations } from './db/schema';
import fs from 'fs';
import path from 'path';
import agentsRouter from './routes/agents';
import featuresRouter from './routes/features';
import chatRouter from './routes/chat';
import roundtableRouter from './routes/roundtable';
import planeRouter from './routes/plane';
import outlineRouter from './routes/outline';
import diagramsRouter from './routes/diagrams';
import dataExportRouter from './routes/dataExport';
import { getUploadsDir } from './chat/imageStore';

dotenv.config();

const PORT = parseInt(process.env.PORT ?? '3001', 10);

// Initialize database before anything else.
runMigrations();

// Agent prompts: a private, gitignored db/seed.ts wins when present;
// otherwise the generic db/seed.example.ts is used.
const hasPrivateSeed = ['seed.ts', 'seed.js'].some((f) => fs.existsSync(path.join(__dirname, 'db', f)));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { seedAgents } = require(hasPrivateSeed ? './db/seed' : './db/seed.example') as typeof import('./db/seed.example');
seedAgents();

const app = express();

app.use(
  cors({
    // In development, the Vite dev server runs on 5173.
    // In production, frontend is served statically from the same origin.
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
  })
);

// Higher limit accommodates base64-encoded pasted images.
app.use(express.json({ limit: '15mb' }));

// Health check — useful for docker/CI readiness probes.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/agents', agentsRouter);
app.use('/api/features', featuresRouter);
app.use('/api/chat', chatRouter);
app.use('/api/roundtable', roundtableRouter);
app.use('/api/plane', planeRouter);
app.use('/api/outline', outlineRouter);
app.use('/api/diagrams', diagramsRouter);
app.use('/api/data-export', dataExportRouter);
app.use('/uploads', express.static(getUploadsDir()));

app.listen(PORT, () => {
  console.log(`Nadir agents backend running on http://localhost:${PORT}`);
});
