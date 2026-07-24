import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Diagram, Graph } from '../api/client';
import { fetchDiagram, updateDiagram, fetchAgentFormat } from '../api/client';

const KIND_COLORS: Record<string, string> = {
  service: '#7c6af7',
  datastore: '#34d399',
  external: '#f97316',
  default: '#4a3fa8',
};

function graphToFlow(graph: Graph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: { label: n.data.label, notes: n.data.notes, kind: n.data.kind },
      type: 'default',
      style: {
        background: KIND_COLORS[n.data.kind ?? 'default'] ?? KIND_COLORS.default,
        color: '#fff',
        border: '1px solid #2e2e42',
        borderRadius: 8,
        fontSize: 12,
        padding: 8,
      },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      data: { dependency: e.data?.dependency ?? false },
      style: e.data?.dependency ? { stroke: '#f97316', strokeWidth: 2 } : undefined,
      labelStyle: { fill: '#e5e7eb', fontSize: 11 },
      animated: e.data?.dependency ?? false,
    })),
  };
}

function flowToGraph(nodes: Node[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: {
        label: (n.data as { label: string }).label,
        notes: (n.data as { notes?: string }).notes,
        kind: (n.data as { kind?: string }).kind,
      },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : undefined,
      data: { dependency: Boolean((e.data as { dependency?: boolean } | undefined)?.dependency) },
    })),
  };
}

let nodeIdCounter = 1;
let edgeIdCounter = 1;

export function DiagramCanvas({ diagramId }: { diagramId: number }) {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    loadedRef.current = false;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    fetchDiagram(diagramId).then((d) => {
      setDiagram(d);
      const graph: Graph = JSON.parse(d.graph_json);
      const { nodes: flowNodes, edges: flowEdges } = graphToFlow(graph);
      setNodes(flowNodes);
      setEdges(flowEdges);
      loadedRef.current = true;
    });
  }, [diagramId]);

  const scheduleSave = useCallback(
    (nextNodes: Node[], nextEdges: Edge[]) => {
      if (!loadedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveStatus('saving');
      saveTimer.current = setTimeout(async () => {
        const graph = flowToGraph(nextNodes, nextEdges);
        await updateDiagram(diagramId, { graph_json: JSON.stringify(graph) });
        setSaveStatus('saved');
      }, 800);
    },
    [diagramId]
  );

  useEffect(() => {
    scheduleSave(nodes, edges);
  }, [nodes, edges, scheduleSave]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          { ...connection, id: `e${Date.now()}_${edgeIdCounter++}`, data: { dependency: false } },
          eds
        )
      );
    },
    [setEdges]
  );

  function handlePaneDoubleClick(event: React.MouseEvent) {
    const label = window.prompt('Node label');
    if (!label?.trim()) return;
    const bounds = (event.target as HTMLElement).closest('.react-flow')?.getBoundingClientRect();
    const position = rfInstance.current?.screenToFlowPosition
      ? rfInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };

    const id = `n${Date.now()}_${nodeIdCounter++}`;
    const newNode: Node = {
      id,
      position,
      data: { label: label.trim() },
      type: 'default',
      style: {
        background: KIND_COLORS.default,
        color: '#fff',
        border: '1px solid #2e2e42',
        borderRadius: 8,
        fontSize: 12,
        padding: 8,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }

  function handleAddNodeButton() {
    const label = window.prompt('Node label');
    if (!label?.trim()) return;
    const id = `n${Date.now()}_${nodeIdCounter++}`;
    const newNode: Node = {
      id,
      position: { x: 100 + Math.random() * 300, y: 100 + Math.random() * 200 },
      data: { label: label.trim() },
      type: 'default',
      style: {
        background: KIND_COLORS.default,
        color: '#fff',
        border: '1px solid #2e2e42',
        borderRadius: 8,
        fontSize: 12,
        padding: 8,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  function updateSelectedNode(patch: Partial<{ label: string; notes: string; kind: string }>) {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== selectedNodeId) return n;
        const nextData = { ...(n.data as Record<string, unknown>), ...patch };
        const kind = (nextData.kind as string | undefined) ?? 'default';
        return {
          ...n,
          data: nextData,
          style: { ...n.style, background: KIND_COLORS[kind] ?? KIND_COLORS.default },
        };
      })
    );
  }

  function updateSelectedEdge(patch: Partial<{ label: string; dependency: boolean }>) {
    setEdges((eds) =>
      eds.map((e) => {
        if (e.id !== selectedEdgeId) return e;
        const dependency =
          patch.dependency ?? Boolean((e.data as { dependency?: boolean } | undefined)?.dependency);
        return {
          ...e,
          label: patch.label !== undefined ? patch.label : e.label,
          data: { dependency },
          style: dependency ? { stroke: '#f97316', strokeWidth: 2 } : undefined,
          animated: dependency,
        };
      })
    );
  }

  function deleteSelectedNode() {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }

  function deleteSelectedEdge() {
    if (!selectedEdgeId) return;
    setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  }

  async function handleExport(kind: 'mermaid' | 'agent' | 'json') {
    if (!diagram) return;
    if (kind === 'json') {
      const graph = flowToGraph(nodes, edges);
      const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${diagram.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      return;
    }
    const text = await fetchAgentFormat(diagram.id);
    if (kind === 'agent') {
      await navigator.clipboard.writeText(text);
      setExportText('Copied agent-format text to clipboard.');
    } else {
      const match = text.match(/```mermaid\n([\s\S]*?)```/);
      const mermaid = match ? match[1].trim() : text;
      await navigator.clipboard.writeText(mermaid);
      setExportText('Copied Mermaid block to clipboard.');
    }
    setTimeout(() => setExportText(null), 2000);
    setExportOpen(false);
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId);

  if (!diagram) {
    return <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">Loading…</div>;
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 relative">
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
          <span className="text-sm font-medium text-gray-200 bg-surface-100/80 px-2 py-1 rounded border border-border">
            {diagram.name}
          </span>
          <button onClick={handleAddNodeButton} className="btn-ghost text-xs px-2 py-1">
            + Node
          </button>
          <div className="relative">
            <button onClick={() => setExportOpen((o) => !o)} className="btn-ghost text-xs px-2 py-1">
              Export ▾
            </button>
            {exportOpen && (
              <div className="absolute top-full mt-1 left-0 bg-surface-100 border border-border rounded shadow-lg w-48 z-20">
                <button
                  onClick={() => handleExport('mermaid')}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-surface-200"
                >
                  Copy Mermaid
                </button>
                <button
                  onClick={() => handleExport('agent')}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-surface-200"
                >
                  Copy agent-format text
                </button>
                <button
                  onClick={() => handleExport('json')}
                  className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-surface-200"
                >
                  Download .json
                </button>
              </div>
            )}
          </div>
          <span className="text-[11px] text-gray-500">
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
          {exportText && <span className="text-[11px] text-accent">{exportText}</span>}
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          onDoubleClick={handlePaneDoubleClick}
          onInit={(instance) => {
            rfInstance.current = instance;
          }}
          deleteKeyCode={['Backspace', 'Delete']}
          colorMode="dark"
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {(selectedNode || selectedEdge) && (
        <aside className="w-64 shrink-0 border-l border-border p-4 space-y-3">
          {selectedNode && (
            <>
              <h3 className="text-sm font-medium text-gray-200">Node</h3>
              <label className="block text-xs text-gray-500">Label</label>
              <input
                className="input text-sm"
                value={(selectedNode.data as { label: string }).label}
                onChange={(e) => updateSelectedNode({ label: e.target.value })}
              />
              <label className="block text-xs text-gray-500">Kind</label>
              <select
                className="input text-sm"
                value={(selectedNode.data as { kind?: string }).kind ?? 'default'}
                onChange={(e) => updateSelectedNode({ kind: e.target.value })}
              >
                <option value="default">default</option>
                <option value="service">service</option>
                <option value="datastore">datastore</option>
                <option value="external">external</option>
              </select>
              <label className="block text-xs text-gray-500">Notes</label>
              <textarea
                className="input text-sm h-24 resize-none"
                value={(selectedNode.data as { notes?: string }).notes ?? ''}
                onChange={(e) => updateSelectedNode({ notes: e.target.value })}
              />
              <button onClick={deleteSelectedNode} className="btn-ghost text-xs px-2 py-1 text-red-400 border-red-900">
                Delete node
              </button>
            </>
          )}

          {selectedEdge && (
            <>
              <h3 className="text-sm font-medium text-gray-200">Edge</h3>
              <label className="block text-xs text-gray-500">Label</label>
              <input
                className="input text-sm"
                value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
                onChange={(e) => updateSelectedEdge({ label: e.target.value })}
              />
              <label className="flex items-center gap-2 text-xs text-gray-400 mt-2">
                <input
                  type="checkbox"
                  checked={Boolean((selectedEdge.data as { dependency?: boolean } | undefined)?.dependency)}
                  onChange={(e) => updateSelectedEdge({ dependency: e.target.checked })}
                />
                Mark as dependency
              </label>
              <button onClick={deleteSelectedEdge} className="btn-ghost text-xs px-2 py-1 text-red-400 border-red-900">
                Delete edge
              </button>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
