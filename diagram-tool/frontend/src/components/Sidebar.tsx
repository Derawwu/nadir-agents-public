import { useEffect, useState } from 'react';
import type { DiagramFolder, DiagramSummary } from '../api/client';
import {
  fetchFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  fetchDiagrams,
  createDiagram,
  deleteDiagram,
} from '../api/client';

interface SidebarProps {
  selectedDiagramId: number | null;
  onSelect: (id: number) => void;
}

export function Sidebar({ selectedDiagramId, onSelect }: SidebarProps) {
  const [folders, setFolders] = useState<DiagramFolder[]>([]);
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function reload() {
    fetchFolders().then(setFolders);
    fetchDiagrams().then(setDiagrams);
  }

  useEffect(() => {
    reload();
  }, []);

  function toggle(folderId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function handleNewFolder(parentId: number | null) {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    await createFolder(name.trim(), parentId);
    reload();
  }

  async function handleRenameFolder(folder: DiagramFolder) {
    const name = window.prompt('Rename folder', folder.name);
    if (!name?.trim() || name === folder.name) return;
    await renameFolder(folder.id, name.trim());
    reload();
  }

  async function handleDeleteFolder(folder: DiagramFolder) {
    if (!window.confirm(`Delete folder "${folder.name}"? Diagrams inside move to root.`)) return;
    await deleteFolder(folder.id);
    reload();
  }

  async function handleNewDiagram(folderId: number | null) {
    const name = window.prompt('Diagram name');
    if (!name?.trim()) return;
    const diagram = await createDiagram(name.trim(), folderId);
    reload();
    onSelect(diagram.id);
  }

  async function handleDeleteDiagram(id: number) {
    if (!window.confirm('Delete this diagram? This cannot be undone.')) return;
    await deleteDiagram(id);
    reload();
  }

  const rootFolders = folders.filter((f) => f.parent_id === null);
  const childFolders = (parentId: number) => folders.filter((f) => f.parent_id === parentId);
  const diagramsIn = (folderId: number | null) => diagrams.filter((d) => d.folder_id === folderId);

  function renderFolder(folder: DiagramFolder, depth: number) {
    const isOpen = expanded.has(folder.id);
    return (
      <div key={folder.id}>
        <div
          className="flex items-center gap-1 rounded hover:bg-surface-200 group"
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          <button
            onClick={() => toggle(folder.id)}
            className={`w-4 text-center text-[10px] text-gray-500 shrink-0 transition-transform ${
              isOpen ? 'rotate-90' : ''
            }`}
          >
            ▶
          </button>
          <span className="flex-1 text-sm text-gray-300 truncate py-1">{folder.name}</span>
          <button
            onClick={() => handleNewDiagram(folder.id)}
            className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-500 hover:text-accent px-1"
            title="New diagram in this folder"
          >
            +diag
          </button>
          <button
            onClick={() => handleRenameFolder(folder)}
            className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-500 hover:text-gray-200 px-1"
          >
            rename
          </button>
          <button
            onClick={() => handleDeleteFolder(folder)}
            className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-500 hover:text-red-400 px-1"
          >
            del
          </button>
        </div>

        {isOpen && (
          <div>
            {childFolders(folder.id).map((child) => renderFolder(child, depth + 1))}
            {diagramsIn(folder.id).map((d) => renderDiagram(d, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderDiagram(diagram: DiagramSummary, depth: number) {
    const isSelected = selectedDiagramId === diagram.id;
    return (
      <div
        key={diagram.id}
        className={`flex items-center gap-1 rounded group ${
          isSelected ? 'bg-accent/10 text-accent' : 'hover:bg-surface-200'
        }`}
        style={{ paddingLeft: `${depth * 14 + 14}px` }}
      >
        <button
          onClick={() => onSelect(diagram.id)}
          className={`flex-1 text-left text-sm truncate py-1 ${isSelected ? '' : 'text-gray-300'}`}
          title={diagram.name}
        >
          {diagram.name}
        </button>
        <button
          onClick={() => handleDeleteDiagram(diagram.id)}
          className="opacity-0 group-hover:opacity-100 text-[10px] text-gray-500 hover:text-red-400 px-1"
        >
          del
        </button>
      </div>
    );
  }

  return (
    <aside className="w-72 shrink-0 border-r border-border flex flex-col">
      <div className="border-b border-border px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-300">Diagrams</span>
        <div className="flex gap-2">
          <button
            onClick={() => handleNewFolder(null)}
            className="text-xs text-gray-500 hover:text-gray-200"
            title="New root folder"
          >
            + Folder
          </button>
          <button
            onClick={() => handleNewDiagram(null)}
            className="text-xs text-gray-500 hover:text-accent"
            title="New diagram at root"
          >
            + Diagram
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {rootFolders.map((f) => renderFolder(f, 0))}
        {diagramsIn(null).map((d) => renderDiagram(d, 0))}
        {folders.length === 0 && diagrams.length === 0 && (
          <p className="text-gray-600 text-xs px-2 py-4">
            No diagrams yet. Create one with "+ Diagram".
          </p>
        )}
      </div>
    </aside>
  );
}
