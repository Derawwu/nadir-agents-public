import { useState } from 'react';
import { Link } from 'react-router-dom';
import { agentSlug, type ContextSource } from '../api/client';

/**
 * "Context: 2 earlier messages · 1 wiki excerpt · 1 diagram" under a reply. Expands to
 * show what retrieval put into the request, with links back to each source.
 */

interface Props {
  sources: ContextSource[];
  agentName: string | null;
}

const TYPE_COLOR: Record<ContextSource['type'], string> = {
  message: 'text-accent-hover',
  wiki: 'text-emerald-400',
  diagram: 'text-sky-400',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function SourceRow({ s, agentName }: { s: ContextSource; agentName: string | null }) {
  const label =
    s.type === 'wiki' ? 'Wiki' : s.type === 'diagram' ? 'Diagram' : s.role === 'assistant' ? (agentName ?? 'Agent') : 'You';
  const title = s.title ?? (s.type === 'message' ? 'Chat' : 'Untitled');
  // Diagrams have no per-diagram URL in the editor, so they link to the Diagrams tab.
  const appPath =
    s.type === 'diagram' ? '/diagrams' : agentName && s.chatSlug ? `/chat/${agentSlug(agentName)}/${s.chatSlug}` : null;
  const match = [
    s.similarity !== null ? `${Math.round(s.similarity * 100)}% similar` : null,
    s.keywordMatch ? 'keyword match' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="border-l-2 border-border pl-2 py-1">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className={`shrink-0 ${TYPE_COLOR[s.type]}`}>{label}</span>
        {s.type === 'wiki' && s.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" className="text-gray-300 hover:text-white underline-offset-2 hover:underline truncate min-w-[5rem]">
            {title}
          </a>
        ) : appPath ? (
          <Link to={appPath} className="text-gray-300 hover:text-white underline-offset-2 hover:underline truncate min-w-[5rem]">
            {title}
          </Link>
        ) : (
          <span className="text-gray-300 truncate min-w-[5rem]">{title}</span>
        )}
        {s.type === 'message' && <span className="text-gray-600 shrink-0">{s.createdAt.slice(0, 10)}</span>}
        <span className="text-gray-600 ml-auto pl-2 shrink-0">{match}</span>
      </div>
      <div className="text-[11px] text-gray-500 whitespace-pre-wrap line-clamp-3">{s.snippet}</div>
    </li>
  );
}

export function ContextSources({ sources, agentName }: Props) {
  const [open, setOpen] = useState(false);
  const messages = sources.filter((s) => s.type === 'message').length;
  const wiki = sources.filter((s) => s.type === 'wiki').length;
  const diagrams = sources.filter((s) => s.type === 'diagram').length;
  const summary = [
    messages ? plural(messages, 'earlier message') : null,
    wiki ? plural(wiki, 'wiki excerpt') : null,
    diagrams ? plural(diagrams, 'diagram') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mt-1 ml-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-gray-500 hover:text-gray-300"
        title="Excerpts retrieval added to this reply's request"
      >
        {open ? '▾' : '▸'} Context: {summary}
      </button>
      {open && <ul className="mt-1 space-y-1 w-[34rem] max-w-full">{sources.map((s, i) => <SourceRow key={i} s={s} agentName={agentName} />)}</ul>}
    </div>
  );
}
