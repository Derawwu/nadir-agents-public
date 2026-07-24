# Claude Code Prompt — Self-Hosted Diagram / Bubbles / Dependency Tracker with Nadir-Agents Integration

> Paste everything below into Claude Code from the `D:\nadir-agents` root.

---

## What I want you to build

A **self-hosted node-graph diagram editor** ("bubbles with text, arrows, and dependencies" — like Excalidraw / tldraw / draw.io / Whimsical, but structured so it exports to a format AI agents can read). It lives **inside the existing nadir-agents app** as a new tab, stores diagrams in the existing SQLite DB with **folder organization**, and plugs into the existing **Context Tray** so I can attach a diagram to any agent chat. In the nadir-agents UI I only ever see the diagram's **name and folder** — but when I send a message the agent receives the **full machine-readable diagram** (Mermaid + a structured dependency listing) transparently injected as context.

Think structured graph, NOT freeform whiteboard: every bubble is a **node** (id, label, optional notes, type/color) and every arrow is an **edge** (source → target, optional label, dependency semantics). This structure is what makes it exportable to something agents understand.

## Tech constraints (match the existing repo exactly — do not deviate)

- **Backend**: TypeScript + Express, runs on port **3001**. Entry `backend/src/index.ts`.
- **Frontend**: React + Vite + Tailwind (dark theme), runs on port **5173**. Uses `react-router-dom`.
- **Database**: Node's built-in **`node:sqlite`** (`DatabaseSync`) via the shared singleton in `backend/src/db/connection.ts`. **Do NOT add `better-sqlite3` or any native module** — this machine has no VS Build Tools and native compilation fails. Any npm dependency you add must be pure JS/WASM.
- **Canvas library**: use **`@xyflow/react`** (React Flow — pure JS, no native build). If you judge a different pure-JS lib is clearly better, propose it first and wait for my confirmation before installing.
- Follow the existing code conventions precisely:
  - Services live in `backend/src/<domain>/<domain>Service.ts`, routes in `backend/src/routes/<domain>.ts`, mounted in `index.ts` via `app.use('/api/<domain>', ...)`.
  - Schema changes go in `backend/src/db/schema.ts` inside `runMigrations()` using `CREATE TABLE IF NOT EXISTS` and appended `ALTER`-style migration blocks. **Never edit an existing `CREATE TABLE` block.**
  - Frontend API calls go through the typed client `frontend/src/api/client.ts` (base `'/api'`). Components in `frontend/src/components/`. Match the Tailwind class vocabulary already in use (`border-border`, `text-accent`, `bg-gray-900/40`, `text-gray-*`, etc.).

## Data model (new tables in `schema.ts`)

```sql
CREATE TABLE IF NOT EXISTS diagram_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES diagram_folders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diagrams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER REFERENCES diagram_folders(id),
  name TEXT NOT NULL,
  description TEXT,
  -- Full canvas state (React Flow nodes + edges) as JSON:
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- Folders can nest (self-referential `parent_id`). Keep it simple — one level is fine to start, but the schema should allow nesting.
- `graph_json` is the single source of truth for the canvas: `{ nodes: Node[], edges: Edge[] }` in React Flow shape. Each node's `data` carries `{ label, notes?, kind? }`; each edge carries `{ label?, dependency?: boolean }`.

## The agent-readable export (this is the core requirement)

Add a backend function `serializeDiagramForAgent(diagram)` that turns `graph_json` into a deterministic, LLM-friendly text block. It must include **all three** of the following so any agent can reason over it without seeing pixels:

1. **A Mermaid `flowchart` block** (nodes as `id["label"]`, edges as `a --> b` with edge labels as `a -->|label| b`). Sanitize labels for Mermaid (escape quotes, strip newlines).
2. **A structured dependency listing** in plain text, e.g.:
   ```
   Nodes:
   - [n1] Auth Service (kind: service) — notes: handles JWT
   - [n2] User DB (kind: datastore)
   Dependencies (edges):
   - Auth Service --> User DB  (label: "reads/writes")
   - ...
   Roots (no incoming edges): Auth Service
   Leaves (no outgoing edges): User DB
   ```
3. **Metadata header**: diagram name, folder path, node/edge counts, last-updated timestamp.

Compute and surface **roots** (nodes with no incoming edges) and **leaves** (no outgoing edges) — this is the "root tracker" behavior I want. Keep the output stable/ordered so the same diagram always serializes identically.

## Backend spec

- `backend/src/diagrams/diagramService.ts`:
  - CRUD for folders and diagrams (create, list, get, rename, update `graph_json`, delete).
  - `getFolderPath(folderId)` → `"Parent / Child"` string.
  - `serializeDiagramForAgent(id)` → the text block described above.
  - Update `updated_at` on every `graph_json` save.
- `backend/src/routes/diagrams.ts` (mount at `/api/diagrams` in `index.ts`):
  - `GET /folders`, `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id`
  - `GET /` (list diagrams, optionally `?folder_id=`), `POST /`, `GET /:id`, `PATCH /:id` (name/description/graph_json), `DELETE /:id`
  - `GET /:id/agent-format` → `{ text: string }` from `serializeDiagramForAgent` (this is what the Context Tray fetches).
- Validate inputs and return the same error shapes as existing routes (`res.status(400).json({ error: '...' })`).

## Frontend spec — new "Diagrams" tab

- Add a `Diagrams` `NavLink` + `Route` in `frontend/src/App.tsx` (pattern-match the existing Wiki/Plane tabs).
- New component `frontend/src/components/DiagramTab.tsx`:
  - **Left panel**: folder tree + diagram list (create folder, create diagram, rename, delete). Show name and folder.
  - **Right panel**: the React Flow canvas editor.
- Canvas editor (`@xyflow/react`):
  - Add a bubble/node (double-click canvas or a "+ Node" button), edit its label inline and notes in a side field, choose a `kind`/color.
  - Draw arrows by dragging from one node handle to another; optionally label an edge and mark it as a "dependency".
  - Delete nodes/edges; pan/zoom; drag to reposition.
  - **Autosave** `graph_json` to `PATCH /api/diagrams/:id` (debounced ~800ms) and on blur.
  - A small **"Export"** menu: copy Mermaid, copy agent-format text, download `.json`.
- Add typed client functions in `frontend/src/api/client.ts` for every endpoint above (mirror the existing `fetch*`/`browse*` style; base `'/api'`).

## Context Tray integration (so agents get the diagram, I only see the name)

Extend the existing tray in `frontend/src/contexts/ContextTrayContext.tsx`:

- Widen `TrayItem['type']` to include `'diagram'`, and widen `removeItem`/`hasTrayItem` signatures accordingly.
- In `augmentMessage`, when `item.type === 'diagram'`, fetch `GET /api/diagrams/:id/agent-format` and use its `text` as the attachment content (cache it like the others).
- In `frontend/src/components/ContextTrayBar.tsx`, give diagram chips an icon (e.g. 🕸️ or 🔗) and show only the **label** (the diagram name; include folder path in the label, e.g. `"Architecture / Auth Flow"`).
- In `DiagramTab.tsx`, add a **"+ Add to context"** / **"✓ In context"** toggle button (mirror `WikiTab.tsx`'s use of `addItem`/`removeItem`/`hasTrayItem`), passing `{ type: 'diagram', id: String(diagram.id), label: folderPath + ' / ' + name }`.

Net effect: I add a diagram to the tray from the Diagrams tab, see just its name as a chip, and when I message any agent the **full Mermaid + dependency listing** is injected automatically — exactly like Wiki and Plane items already work.

## Acceptance criteria

1. New "Diagrams" tab loads; I can create folders and diagrams, and organize diagrams into folders.
2. I can add labeled bubbles, connect them with (optionally labeled) arrows, mark dependencies, reposition, and it autosaves — reloading restores the exact canvas.
3. `GET /api/diagrams/:id/agent-format` returns a Mermaid block + structured dependency listing + roots/leaves + metadata, deterministically.
4. From the Diagrams tab I can add a diagram to the Context Tray; the chip shows only the name/folder.
5. Sending an agent message with a diagram in the tray injects the agent-format text (verify the outgoing message contains the Mermaid + dependency listing).
6. No native modules added; `node:sqlite` only; backend still starts on 3001 and frontend on 5173.

## Working method

- Start by restating your implementation plan and the exact dependency you'll install; wait for my OK before installing.
- Make the schema + backend + a passing `curl` of `/api/diagrams/:id/agent-format` work **before** building the canvas UI.
- Keep changes additive; don't touch unrelated tables, routes, or components.
- When done, give me the manual test steps and the `curl` commands to verify the agent-format export.
