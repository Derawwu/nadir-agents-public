/**
 * Express application entry point for the standalone diagram tool.
 *
 * Startup order:
 *   1. Run DB migrations (idempotent schema creation)
 *   2. Mount routes
 *   3. Start HTTP server
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { runMigrations } from './db/schema';
import diagramsRouter from './routes/diagrams';

dotenv.config();

const PORT = parseInt(process.env.PORT ?? '3010', 10);

runMigrations();

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5180,http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/diagrams', diagramsRouter);

app.listen(PORT, () => {
  console.log(`Diagram tool backend running on http://localhost:${PORT}`);
});
