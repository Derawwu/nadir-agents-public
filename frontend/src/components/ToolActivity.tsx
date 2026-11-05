import { useState } from 'react';
import type { ToolCall } from '../api/client';

/**
 * What the agent did with tools while writing a reply: one line per read
 * (search, open a page…), and an action card per write. A pending card has
 * Approve / Decline; once decided it collapses to a line like the reads.
 */

interface Props {
  calls: ToolCall[];
  /** Set while the reply waits for decisions; omitted for saved replies. */
  onDecide?: (call: ToolCall, decision: 'approve' | 'reject') => void;
  /** Decisions made but not sent yet (several cards in one reply). */
  decided?: Record<number, 'approve' | 'reject'>;
  busy?: boolean;
}

const ICON: Record<string, string> = {
  search_knowledge: '🔎',
  list_wiki_pages: '📚',
  read_wiki_page: '📄',
  list_diagrams: '🗺️',
  read_diagram: '🗺️',
  list_plane_issues: '📋',
  read_plane_issue: '📋',
  create_wiki_page: '📝',
  update_wiki_page: '📝',
  create_plane_issue: '➕',
  update_plane_issue: '✏️',
  comment_on_plane_issue: '💬',
  add_to_diagram: '🧩',
  save_memory: '🧠',
};

function statusLabel(call: ToolCall): { text: string; color: string } | null {
  switch (call.status) {
    case 'error':
      return { text: 'failed', color: 'text-red-400' };
    case 'rejected':
      return { text: 'declined', color: 'text-gray-500' };
    case 'skipped':
      return { text: 'skipped', color: 'text-gray-500' };
    default:
      return null;
  }
}

function CallLine({ call }: { call: ToolCall }) {
  const status = statusLabel(call);
  const text = call.status === 'rejected' || call.status === 'skipped' ? (call.preview?.title ?? call.name) : (call.summary ?? call.name);
  return (
    <li className="flex items-baseline gap-1.5 text-xs text-gray-400 min-w-0">
      <span className="shrink-0">{ICON[call.name] ?? '🔧'}</span>
      <span className={`truncate ${call.status === 'error' ? 'text-red-300/80' : ''}`} title={call.summary ?? undefined}>
        {text}
      </span>
      {status && <span className={`shrink-0 ${status.color}`}>· {status.text}</span>}
      {call.url && call.status === 'done' && (
        <a href={call.url} target="_blank" rel="noreferrer" className="shrink-0 text-accent-hover hover:underline">
          open ↗
        </a>
      )}
    </li>
  );
}

function ActionCard({
  call,
  decision,
  onDecide,
  busy,
}: {
  call: ToolCall;
  decision?: 'approve' | 'reject';
  onDecide?: Props['onDecide'];
  busy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = call.preview;
  const body = preview?.body ?? '';
  const long = body.length > 600 || body.split('\n').length > 12;

  return (
    <div className="border border-amber-400/30 bg-amber-400/5 rounded-md p-3 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <span>{ICON[call.name] ?? '🔧'}</span>
        <span className="font-medium text-amber-200">{preview?.title ?? call.name}</span>
        <span className="text-gray-500">· needs your approval</span>
      </div>

      {preview && preview.fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {preview.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-gray-500">{f.label}</dt>
              <dd className="text-gray-200 break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {body && (
        <div>
          <pre
            className={`whitespace-pre-wrap break-words font-sans text-gray-300 bg-surface-100 border border-border rounded p-2
              ${long && !expanded ? 'max-h-40 overflow-hidden' : 'max-h-96 overflow-y-auto'}`}
          >
            {body}
          </pre>
          {long && (
            <button className="text-gray-500 hover:text-gray-300 mt-1" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}

      {onDecide && (
        <div className="flex items-center gap-2 pt-1">
          {decision ? (
            <span className="text-gray-400">
              {decision === 'approve' ? 'Approved' : 'Declined'} · waiting for the other actions
            </span>
          ) : (
            <>
              <button
                className="px-2.5 py-1 rounded border border-green-500/40 text-green-300 hover:bg-green-500/10 disabled:opacity-50"
                disabled={busy}
                onClick={() => onDecide(call, 'approve')}
              >
                Approve
              </button>
              <button
                className="px-2.5 py-1 rounded border border-border text-gray-400 hover:text-gray-200 disabled:opacity-50"
                disabled={busy}
                onClick={() => onDecide(call, 'reject')}
              >
                Decline
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolActivity({ calls, onDecide, decided, busy }: Props) {
  if (calls.length === 0) return null;
  const pending = calls.filter((c) => c.status === 'pending');
  const settled = calls.filter((c) => c.status !== 'pending');

  return (
    <div className="mt-1.5 ml-1 space-y-2 max-w-[42rem]">
      {settled.length > 0 && (
        <ul className="space-y-0.5">
          {settled.map((c) => (
            <CallLine key={c.id} call={c} />
          ))}
        </ul>
      )}
      {pending.map((c) => (
        <ActionCard key={c.id} call={c} decision={decided?.[c.id]} onDecide={onDecide} busy={busy} />
      ))}
    </div>
  );
}
