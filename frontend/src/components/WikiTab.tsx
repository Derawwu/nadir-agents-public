import { useEffect, useState } from 'react';
import {
  browseWiki,
  fetchWikiCollections,
  fetchDocumentContent,
} from '../api/client';
import type { WikiCollection, WikiDocumentMeta, WikiDocumentContent } from '../api/client';
import { useContextTray } from '../contexts/ContextTrayContext';

const OUTLINE_BASE_URL = 'http://localhost:3002';

interface DocNode {
  doc: WikiDocumentMeta;
  children: DocNode[];
}

/** Builds a parent/child tree from Outline's flat document list, mirroring its own sidebar nesting. */
function buildDocTree(docs: WikiDocumentMeta[]): DocNode[] {
  const nodeById = new Map<string, DocNode>(docs.map((doc) => [doc.id, { doc, children: [] }]));
  const roots: DocNode[] = [];

  for (const node of nodeById.values()) {
    const parentId = node.doc.parentDocumentId;
    const parent = parentId ? nodeById.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function DocTreeNode({
  node,
  depth,
  selectedDocId,
  expandedDocs,
  onToggle,
  onOpen,
}: {
  node: DocNode;
  depth: number;
  selectedDocId: string | null;
  expandedDocs: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (doc: WikiDocumentMeta) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expandedDocs.has(node.doc.id);

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded transition-colors ${
          selectedDocId === node.doc.id ? 'bg-accent/10 text-accent' : 'hover:bg-surface-200'
        }`}
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <button
          onClick={() => hasChildren && onToggle(node.doc.id)}
          className={`w-4 text-center text-[10px] text-gray-500 shrink-0 transition-transform ${
            hasChildren && isOpen ? 'rotate-90' : ''
          } ${hasChildren ? '' : 'invisible'}`}
        >
          ▶
        </button>
        <button
          onClick={() => onOpen(node.doc)}
          className={`flex-1 text-left px-1 py-1 text-sm truncate ${
            selectedDocId === node.doc.id ? '' : 'text-gray-300'
          }`}
          title={node.doc.title}
        >
          {node.doc.title}
        </button>
      </div>

      {hasChildren && isOpen && (
        <div>
          {node.children.map((child) => (
            <DocTreeNode
              key={child.doc.id}
              node={child}
              depth={depth + 1}
              selectedDocId={selectedDocId}
              expandedDocs={expandedDocs}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WikiTab() {
  const [collections, setCollections] = useState<WikiCollection[]>([]);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [docsByCollection, setDocsByCollection] = useState<Record<string, WikiDocumentMeta[]>>({});
  const [loadingCollection, setLoadingCollection] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<WikiDocumentMeta[]>([]);
  const [searching, setSearching] = useState(false);

  const [selectedDoc, setSelectedDoc] = useState<WikiDocumentContent | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const { addItem, removeItem, hasTrayItem } = useContextTray();

  useEffect(() => {
    fetchWikiCollections()
      .then(setCollections)
      .catch((e: unknown) =>
        setCollectionsError(e instanceof Error ? e.message : 'Failed to load wiki collections')
      );
  }, []);

  // Debounced cross-collection search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      browseWiki({ role: 'narrator', query: q })
        .then((results) => {
          setSearchResults(results);
          setSearching(false);
        })
        .catch(() => {
          setSearchResults([]);
          setSearching(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  function toggleCollection(collectionId: string) {
    setExpandedCollections((prev) => {
      const next = new Set(prev);
      if (next.has(collectionId)) {
        next.delete(collectionId);
      } else {
        next.add(collectionId);
        if (!docsByCollection[collectionId]) {
          setLoadingCollection(collectionId);
          browseWiki({ role: 'narrator', collectionId })
            .then((docs) => {
              setDocsByCollection((prevDocs) => ({ ...prevDocs, [collectionId]: docs }));
            })
            .catch(() => {
              setDocsByCollection((prevDocs) => ({ ...prevDocs, [collectionId]: [] }));
            })
            .finally(() => setLoadingCollection(null));
        }
      }
      return next;
    });
  }

  function toggleDoc(docId: string) {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function openDocument(doc: WikiDocumentMeta) {
    setSelectedDocId(doc.id);
    setDocLoading(true);
    setDocError(null);
    setSelectedDoc(null);
    fetchDocumentContent({ role: 'narrator', documentId: doc.id })
      .then(setSelectedDoc)
      .catch((e: unknown) => setDocError(e instanceof Error ? e.message : 'Failed to load document'))
      .finally(() => setDocLoading(false));
  }

  function toggleTray(doc: { id: string; title: string }) {
    if (hasTrayItem(doc.id, 'wiki')) {
      removeItem(doc.id, 'wiki');
    } else {
      addItem({ type: 'wiki', id: doc.id, label: doc.title });
    }
  }

  const showingSearch = query.trim().length > 0;

  return (
    <div className="flex h-full">
      {/* Tree nav sidebar */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="border-b border-border px-4 py-3">
          <input
            className="input text-sm w-full"
            placeholder="Search wiki…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {collectionsError && (
            <p className="text-red-400 text-xs px-2 py-4">{collectionsError}</p>
          )}

          {showingSearch ? (
            <>
              {searching && <p className="text-gray-600 text-xs px-2 py-2">Searching…</p>}
              {!searching && searchResults.length === 0 && (
                <p className="text-gray-600 text-xs px-2 py-2">No matches.</p>
              )}
              {!searching &&
                searchResults.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => openDocument(doc)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm truncate transition-colors ${
                      selectedDocId === doc.id
                        ? 'bg-accent/10 text-accent'
                        : 'text-gray-300 hover:bg-surface-200'
                    }`}
                    title={doc.title}
                  >
                    {doc.title}
                    <span className="block text-[11px] text-gray-500 truncate">
                      {doc.collectionName}
                    </span>
                  </button>
                ))}
            </>
          ) : (
            collections.map((col) => {
              const isOpen = expandedCollections.has(col.id);
              const docs = docsByCollection[col.id];
              const tree = docs ? buildDocTree(docs) : null;

              return (
                <div key={col.id} className="mb-0.5">
                  <button
                    onClick={() => toggleCollection(col.id)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-sm
                               text-gray-300 hover:bg-surface-200 transition-colors"
                  >
                    <span className={`text-gray-500 text-[10px] transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                      ▶
                    </span>
                    <span className="truncate">{col.name}</span>
                  </button>

                  {isOpen && (
                    <div className="ml-2">
                      {loadingCollection === col.id && (
                        <p className="text-gray-600 text-xs px-2 py-1">Loading…</p>
                      )}
                      {tree?.length === 0 && (
                        <p className="text-gray-600 text-xs px-2 py-1">No documents.</p>
                      )}
                      {tree?.map((node) => (
                        <DocTreeNode
                          key={node.doc.id}
                          node={node}
                          depth={1}
                          selectedDocId={selectedDocId}
                          expandedDocs={expandedDocs}
                          onToggle={toggleDoc}
                          onOpen={openDocument}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Reading pane */}
      <div className="flex-1 overflow-y-auto">
        {!selectedDocId && (
          <div className="flex h-full items-center justify-center text-gray-600 text-sm">
            Select a document from the tree to read it.
          </div>
        )}

        {selectedDocId && docLoading && (
          <div className="flex h-full items-center justify-center text-gray-600 text-sm">
            Loading…
          </div>
        )}

        {selectedDocId && docError && (
          <div className="flex h-full items-center justify-center text-red-400 text-sm">
            {docError}
          </div>
        )}

        {selectedDoc && !docLoading && !docError && (
          <div className="max-w-3xl mx-auto px-8 py-8">
            <div className="flex items-start justify-between gap-4 mb-6">
              <h1 className="text-xl font-medium text-gray-100">{selectedDoc.title}</h1>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleTray({ id: selectedDoc.id, title: selectedDoc.title })}
                  className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
                    hasTrayItem(selectedDoc.id, 'wiki')
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border text-gray-400 hover:border-gray-500 hover:text-gray-200'
                  }`}
                >
                  {hasTrayItem(selectedDoc.id, 'wiki') ? '✓ In context' : '+ Add to context'}
                </button>
                <a
                  href={`${OUTLINE_BASE_URL}${selectedDoc.url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs px-2.5 py-1.5 rounded border border-border text-gray-400
                             hover:border-gray-500 hover:text-gray-200 transition-colors"
                >
                  Open in Outline ↗
                </a>
              </div>
            </div>
            <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
              {selectedDoc.text}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
