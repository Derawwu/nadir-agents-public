import { useEffect, useState } from 'react';
import { fetchModelStatus, type ModelCheck, type ModelStatus } from '../api/client';

/**
 * Checks once per browser session whether the configured Claude models are
 * current, and shows a dismissible banner when one has a newer model in its
 * family, is deprecated, or isn't known to the API.
 *
 * The result is kept in sessionStorage, so the check runs on the first page
 * load of a tab and not again on reloads or navigation in that tab.
 */

const STORAGE_KEY = 'nadir.modelStatus';
const DISMISSED_KEY = 'nadir.modelStatus.dismissed';

function readCached(): ModelStatus | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ModelStatus) : null;
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function describe(m: ModelCheck): string {
  const parts: string[] = [];
  if (m.issues.includes('unknown')) parts.push('not found in the Models API (typo, or retired)');
  if (m.issues.includes('deprecated')) {
    parts.push(m.retiresAt ? `deprecated, retires ${formatDate(m.retiresAt)}` : 'deprecated');
  }
  if (m.latest) parts.push(`${m.latest.displayName} is available`);
  return parts.join('; ');
}

export function ModelUpdateBanner() {
  const [status, setStatus] = useState<ModelStatus | null>(readCached);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISSED_KEY) === '1');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (status) return;
    let cancelled = false;
    fetchModelStatus()
      .then((s) => {
        if (cancelled) return;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        setStatus(s);
      })
      .catch((err) => {
        // Not worth interrupting the user over; try again next session.
        console.warn('[ModelUpdateBanner] model check failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  if (!status || status.upToDate || dismissed) return null;

  const flagged = status.models.filter((m) => m.issues.length > 0);
  const urgent = flagged.some((m) => m.issues.includes('deprecated') || m.issues.includes('unknown'));

  const dismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className={`border-b px-6 py-2 text-sm shrink-0 ${
        urgent ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-yellow-400/20 bg-yellow-400/10 text-yellow-100'
      }`}
    >
      <div className="flex items-center gap-3">
        <span>
          {urgent ? 'Some configured models are deprecated or unavailable.' : 'Newer Claude models are available.'}{' '}
          {flagged.length} of {status.models.length} model settings affected.
        </span>
        <button onClick={() => setExpanded((v) => !v)} className="underline underline-offset-2 hover:text-white">
          {expanded ? 'Hide details' : 'Details'}
        </button>
        <button onClick={dismiss} className="ml-auto text-gray-400 hover:text-white" aria-label="Dismiss for this session">
          Dismiss
        </button>
      </div>

      {expanded && (
        <div className="mt-2 mb-1">
          <div className="overflow-x-auto"><table className="text-xs">
            <tbody>
              {flagged.map((m) => (
                <tr key={m.envVar}>
                  <td className="pr-4 py-0.5 text-gray-300 whitespace-nowrap">{m.label}</td>
                  <td className="pr-4 py-0.5 font-mono whitespace-nowrap">{m.model}</td>
                  <td className="pr-4 py-0.5">{describe(m)}</td>
                  <td className="py-0.5 font-mono text-gray-400 whitespace-nowrap">
                    {m.latest ? `${m.envVar}=${m.latest.id}` : m.envVar}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="mt-2 text-xs text-gray-400">
            Change these in <code className="font-mono">backend/.env</code> and restart the backend. Checked{' '}
            {new Date(status.checkedAt).toLocaleString()}.
          </p>
        </div>
      )}
    </div>
  );
}
