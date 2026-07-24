import { useEffect, useState } from 'react';
import { browsePlane } from '../api/client';
import type { PlaneIssueMeta } from '../api/client';
import { useContextTray } from '../contexts/ContextTrayContext';

const STATUS_OPTIONS = ['', 'backlog', 'active', 'review', 'closed'] as const;

const STATUS_LABELS: Record<string, string> = {
  '': 'All statuses',
  backlog: 'Backlog',
  active: 'Active',
  review: 'Review',
  closed: 'Closed',
};

const STATUS_COLORS: Record<string, string> = {
  backlog: 'text-gray-500',
  active: 'text-green-400',
  review: 'text-yellow-400',
  closed: 'text-gray-600',
};

export function PlaneTab() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<PlaneIssueMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addItem, removeItem, hasTrayItem } = useContextTray();

  useEffect(() => {
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      browsePlane({
        query: query.trim() || undefined,
        status: status || undefined,
      })
        .then((data) => {
          setResults(data);
          setLoading(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Failed to browse issues');
          setResults([]);
          setLoading(false);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [query, status]);

  function toggleItem(issue: PlaneIssueMeta) {
    const id = String(issue.id);
    if (hasTrayItem(id, 'plane')) {
      removeItem(id, 'plane');
    } else {
      const label = issue.jira_key ? `${issue.jira_key} — ${issue.name}` : issue.name;
      addItem({ type: 'plane', id, label });
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4 space-y-3">
        <h2 className="text-sm font-medium text-gray-200">Plane Issues</h2>
        <div className="flex gap-2">
          <input
            className="input text-sm flex-1"
            placeholder="Search issues…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="input text-sm w-36"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <p className="text-gray-600 text-sm text-center mt-8">Loading…</p>
        )}

        {!loading && error && (
          <p className="text-red-400 text-sm text-center mt-8">{error}</p>
        )}

        {!loading && !error && results.length === 0 && (
          <p className="text-gray-600 text-sm text-center mt-8">No issues found.</p>
        )}

        {!loading && !error && results.length > 0 && (
          <ul className="space-y-2">
            {results.map((issue) => {
              const id = String(issue.id);
              const inTray = hasTrayItem(id, 'plane');
              return (
                <li
                  key={issue.id}
                  className={`flex items-center justify-between gap-3 p-3 rounded border transition-colors cursor-pointer ${
                    inTray
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border hover:border-gray-600 bg-gray-900/30'
                  }`}
                  onClick={() => toggleItem(issue)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {issue.jira_key && (
                        <span className="text-xs font-mono text-gray-500 shrink-0">
                          {issue.jira_key}
                        </span>
                      )}
                      <p className="text-sm text-gray-200 truncate">{issue.name}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-xs ${STATUS_COLORS[issue.status] ?? 'text-gray-500'}`}>
                        {issue.status}
                      </span>
                      <span className="text-xs text-gray-600">·</span>
                      <span className="text-xs text-gray-600">{issue.phase}</span>
                    </div>
                  </div>
                  <span
                    className={`text-xs shrink-0 ${inTray ? 'text-accent' : 'text-gray-600'}`}
                  >
                    {inTray ? '✓ Added' : '+ Add'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
