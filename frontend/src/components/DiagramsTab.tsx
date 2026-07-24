import { useEffect, useState } from 'react';
import { fetchDiagramList } from '../api/client';
import type { DiagramMeta } from '../api/client';
import { useContextTray } from '../contexts/ContextTrayContext';

const DIAGRAM_TOOL_URL = 'http://localhost:5180';

export function DiagramsTab() {
  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { addItem, removeItem, hasTrayItem } = useContextTray();

  useEffect(() => {
    fetchDiagramList()
      .then(setDiagrams)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load diagrams'))
      .finally(() => setLoading(false));
  }, []);

  function toggleTray(diagram: DiagramMeta) {
    const id = String(diagram.id);
    const label = diagram.folder_path ? `${diagram.folder_path} / ${diagram.name}` : diagram.name;
    if (hasTrayItem(id, 'diagram')) {
      removeItem(id, 'diagram');
    } else {
      addItem({ type: 'diagram', id, label });
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-medium text-gray-100">Diagrams</h1>
          <a
            href={DIAGRAM_TOOL_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs px-2.5 py-1.5 rounded border border-border text-gray-400
                       hover:border-gray-500 hover:text-gray-200 transition-colors"
          >
            Open editor ↗
          </a>
        </div>

        <p className="text-sm text-gray-500 mb-6">
          Diagrams are created and edited in the standalone editor. Add any diagram here to your
          Context Tray so agent chats receive the full Mermaid + dependency listing.
        </p>

        {loading && <p className="text-gray-600 text-sm">Loading…</p>}
        {error && (
          <p className="text-red-400 text-sm">
            {error} — make sure the diagram-tool backend is running on port 3010.
          </p>
        )}
        {!loading && !error && diagrams.length === 0 && (
          <p className="text-gray-600 text-sm">
            No diagrams yet. Open the editor to create your first one.
          </p>
        )}

        <div className="space-y-1">
          {diagrams.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-4 px-3 py-2 rounded border border-border hover:bg-surface-200 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm text-gray-200 truncate">{d.name}</p>
                <p className="text-[11px] text-gray-500 truncate">
                  {d.folder_path || '(root)'} · updated {d.updated_at}
                </p>
              </div>
              <button
                onClick={() => toggleTray(d)}
                className={`shrink-0 text-xs px-2.5 py-1.5 rounded border transition-colors ${
                  hasTrayItem(String(d.id), 'diagram')
                    ? 'border-accent/40 bg-accent/5 text-accent'
                    : 'border-border text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                {hasTrayItem(String(d.id), 'diagram') ? '✓ In context' : '+ Add to context'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
