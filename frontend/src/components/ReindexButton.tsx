import { useEffect, useRef, useState } from 'react';
import { fetchRetrievalStatus, startRetrievalRebuild } from '../api/client';
import type { RetrievalRebuildJob, RetrievalStatus } from '../api/client';

/**
 * "Reindex" in the top nav: rebuilds the retrieval index from scratch
 * (re-chunks every message, wiki page and diagram, re-embeds every chunk).
 * The regular index only picks up new and changed items; this is for after
 * a chunking or model change, or when search results look stale.
 */

const POLL_MS = 1000;
const RESULT_DISPLAY_MS = 6000;

export function ReindexButton() {
  const [job, setJob] = useState<RetrievalRebuildJob | null>(null);
  const [stats, setStats] = useState<RetrievalStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }

  function scheduleReset() {
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setJob(null), RESULT_DISPLAY_MS);
  }

  async function poll() {
    try {
      const s = await fetchRetrievalStatus();
      setStats(s);
      setJob(s.rebuild);
      if (s.rebuild.status !== 'running') {
        stopPolling();
        scheduleReset();
      }
    } catch {
      stopPolling();
      setJob({ status: 'error', message: 'Lost contact with the backend', startedAt: null, finishedAt: null, embedded: 0, toEmbed: 0 });
      scheduleReset();
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(() => void poll(), POLL_MS);
  }

  async function handleClick() {
    if (job?.status === 'running') return;
    if (resetRef.current) clearTimeout(resetRef.current);
    try {
      const started = await startRetrievalRebuild();
      setJob(started);
      if (started.status === 'running') startPolling();
      else scheduleReset();
    } catch (err) {
      setJob({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to start reindex',
        startedAt: null,
        finishedAt: null,
        embedded: 0,
        toEmbed: 0,
      });
      scheduleReset();
    }
  }

  // Pick up a rebuild already running (started in another tab, or before a reload).
  useEffect(() => {
    fetchRetrievalStatus()
      .then((s) => {
        setStats(s);
        if (s.rebuild.status === 'running') {
          setJob(s.rebuild);
          startPolling();
        }
      })
      .catch(() => undefined);
    return () => {
      stopPolling();
      if (resetRef.current) clearTimeout(resetRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = job?.status === 'running';
  const label = running
    ? job.toEmbed > 0
      ? `Reindexing ${job.embedded}/${job.toEmbed}…`
      : 'Reindexing…'
    : job?.status === 'success'
      ? 'Reindexed ✓'
      : job?.status === 'error'
        ? 'Reindex failed'
        : 'Reindex';

  const color =
    job?.status === 'success'
      ? 'border-green-400/40 text-green-400'
      : job?.status === 'error'
        ? 'border-red-400/40 text-red-400'
        : 'border-border text-gray-400 hover:text-gray-200';

  const indexLine = stats
    ? `Index: ${stats.messageChunks} message, ${stats.wikiChunks} wiki and ${stats.diagramChunks} diagram chunks (${stats.model})`
    : null;
  const title = job && job.status !== 'idle' && job.message
    ? job.message
    : ['Rebuild the retrieval index from scratch: re-chunk and re-embed every message, wiki page and diagram', indexLine]
        .filter(Boolean)
        .join('\n');

  return (
    <button
      className={`text-xs px-2.5 py-1.5 rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${color}`}
      onClick={() => void handleClick()}
      disabled={running}
      title={title}
    >
      {label}
    </button>
  );
}
