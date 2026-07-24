/**
 * Runs the ../nadir-agents-data snapshot (Outline + Plane dumps, diagrams.db)
 * by shelling out to that repo's snapshot.ps1 — kept as the single source of
 * truth for the dump/copy/commit logic rather than reimplementing it here.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const DATA_REPO_DIR = process.env.DATA_REPO_DIR ?? 'D:\\nadir-agents-data';
const SNAPSHOT_SCRIPT = path.join(DATA_REPO_DIR, 'snapshot.ps1');

export type ExportStatus = 'idle' | 'running' | 'success' | 'error';

export interface ExportJobState {
  status: ExportStatus;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  commitHash: string | null;
  commitTimestamp: string | null;
}

let job: ExportJobState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  message: null,
  commitHash: null,
  commitTimestamp: null,
};

export function getExportStatus(): ExportJobState {
  return { ...job };
}

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', DATA_REPO_DIR, ...args]);
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * Starts the snapshot script if one isn't already running.
 * Returns immediately — poll getExportStatus() for progress/result.
 */
export function startExport(): { started: boolean; status: ExportJobState } {
  if (job.status === 'running') {
    return { started: false, status: getExportStatus() };
  }

  job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: null,
    commitHash: null,
    commitTimestamp: null,
  };

  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SNAPSHOT_SCRIPT],
    { cwd: DATA_REPO_DIR }
  );

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on('error', (err) => {
    job = {
      ...job,
      status: 'error',
      finishedAt: new Date().toISOString(),
      message: `Failed to launch snapshot.ps1: ${err.message}`,
    };
  });

  proc.on('close', (code) => {
    void (async () => {
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split('\n').slice(-5).join('\n');
        job = {
          ...job,
          status: 'error',
          finishedAt: new Date().toISOString(),
          message: tail || `snapshot.ps1 exited with code ${code}`,
        };
        return;
      }

      const noChange = stdout.includes('[SKIP] nothing changed, no commit made');

      try {
        const commitHash = await runGit(['log', '-1', '--format=%H']);
        const commitTimestamp = await runGit(['log', '-1', '--format=%cI']);
        job = {
          ...job,
          status: 'success',
          finishedAt: new Date().toISOString(),
          message: noChange ? 'Snapshot ran — no changes since last export' : 'Snapshot committed',
          commitHash,
          commitTimestamp,
        };
      } catch (err) {
        job = {
          ...job,
          status: 'success',
          finishedAt: new Date().toISOString(),
          message: 'Snapshot ran, but could not read the resulting commit info',
        };
        void err;
      }
    })();
  });

  return { started: true, status: getExportStatus() };
}
