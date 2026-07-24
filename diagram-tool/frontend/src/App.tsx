import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { DiagramCanvas } from './components/DiagramCanvas';

export default function App() {
  const [selectedDiagramId, setSelectedDiagramId] = useState<number | null>(null);

  return (
    <div className="flex h-full">
      <Sidebar selectedDiagramId={selectedDiagramId} onSelect={setSelectedDiagramId} />
      {selectedDiagramId !== null ? (
        <DiagramCanvas key={selectedDiagramId} diagramId={selectedDiagramId} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Select or create a diagram to start editing.
        </div>
      )}
    </div>
  );
}
