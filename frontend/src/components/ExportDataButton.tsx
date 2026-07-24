import { useEffect, useRef, useState } from 'react';
import { runDataExport, fetchDataExportStatus } from '../api/client';
import type { DataExportJobState } from '../api/client';

const POLL_MS = 1500;
const RESULT_DISPLAY_MS = 6000;

export function ExportDataButton() {
  const [job, setJob] = useState<DataExportJobState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function scheduleReset() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setJob(null), RESULT_DISPLAY_MS);
  }

  async function poll() {
    try {
      const status = await fetchDataExportStatus();
      setJob(status);
      if (status.status !== 'running') {
        stopPolling();
        scheduleReset();
      }
    } catch {
      stopPolling();
      setJob({
        status: 'error',
        startedAt: null,
        finishedAt: null,
        message: 'Lost contact with the backend while checking export status',
        commitHash: null,
        commitTimestamp: null,
      });
      scheduleReset();
    }
  }

  async function handleClick() {
    if (job?.status === 'running') return;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);

    try {
      const status = await runDataExport();
      setJob(status);
      if (status.status === 'running') {
        pollRef.current = setInterval(() => {
          void poll();
        }, POLL_MS);
      } else {
        scheduleReset();
      }
    } catch (err) {
      setJob({
        status: 'error',
        startedAt: null,
        finishedAt: null,
        message: err instanceof Error ? err.message : 'Failed to start export',
        commitHash: null,
        commitTimestamp: null,
      });
      scheduleReset();
    }
  }

  useEffect(() => {
    return () => {
      stopPolling();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const isRunning = job?.status === 'running';
  const label =
    job?.status === 'running'
      ? 'Exporting…'
      : job?.status === 'success'
        ? 'Exported ✓'
        : job?.status === 'error'
          ? 'Export failed'
          : 'Export data';

  const colorClass =
    job?.status === 'success'
      ? 'border-green-400/40 text-green-400'
      : job?.status === 'error'
        ? 'border-red-400/40 text-red-400'
        : 'border-border text-gray-400 hover:text-gray-200';

  const title =
    job?.status === 'success'
      ? [job.message, job.commitHash ? `commit ${job.commitHash.slice(0, 7)}` : null, job.commitTimestamp]
          .filter(Boolean)
          .join(' — ')
      : job?.status === 'error'
        ? (job.message ?? 'Export failed')
        : 'Snapshot Outline + Plane + diagrams data into the nadir-agents-data repo';

  return (
    <button
      className={`text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${colorClass}`}
      onClick={() => void handleClick()}
      disabled={isRunning}
      title={title}
    >
      {label}
    </button>
  );
}
