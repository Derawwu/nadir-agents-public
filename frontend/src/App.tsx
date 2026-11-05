import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { RoundtablePage } from './pages/RoundtablePage';
import { WikiTab } from './components/WikiTab';
import { PlaneTab } from './components/PlaneTab';
import { DiagramsTab } from './components/DiagramsTab';
import { UsagePage } from './pages/UsagePage';
import { ExportDataButton } from './components/ExportDataButton';
import { ReindexButton } from './components/ReindexButton';
import { ModelUpdateBanner } from './components/ModelUpdateBanner';
import { ContextTrayProvider } from './contexts/ContextTrayContext';

export default function App() {
  return (
    <ContextTrayProvider>
      <BrowserRouter>
        <div className="flex flex-col h-full">
          {/* Top nav */}
          <nav className="border-b border-border px-6 py-3 flex items-center gap-6 shrink-0">
            <span className="text-sm font-medium text-gray-400 mr-4">
              Nadir <span className="text-accent">Agent Team</span>
            </span>

            <NavLink
              to="/chat"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Chat
            </NavLink>

            <NavLink
              to="/roundtable"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Roundtable
            </NavLink>

            <NavLink
              to="/wiki"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Wiki
            </NavLink>

            <NavLink
              to="/plane"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Plane
            </NavLink>

            <NavLink
              to="/diagrams"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Diagrams
            </NavLink>

            <NavLink
              to="/usage"
              className={({ isActive }) =>
                `text-sm transition-colors ${
                  isActive ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`
              }
            >
              Usage
            </NavLink>

            <div className="ml-auto flex items-center gap-2">
              <ReindexButton />
              <ExportDataButton />
            </div>
          </nav>

          <ModelUpdateBanner />

          {/* Page content */}
          <div className="flex-1 min-h-0">
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat/:agentSlug?/:chatSlug?" element={<ChatPage />} />
              <Route path="/roundtable" element={<RoundtablePage />} />
              <Route path="/wiki" element={<WikiTab />} />
              <Route path="/plane" element={<PlaneTab />} />
              <Route path="/diagrams" element={<DiagramsTab />} />
              <Route path="/usage" element={<UsagePage />} />
            </Routes>
          </div>
        </div>
      </BrowserRouter>
    </ContextTrayProvider>
  );
}
