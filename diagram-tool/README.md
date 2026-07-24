# Diagram Tool

Standalone node-graph diagram / dependency tracker. Runs alongside the main
Nadir agent-team app and is embedded in its **Diagrams** tab and Context Tray
— attaching a diagram to a chat injects a machine-readable form (Mermaid +
structured dependency listing) into the agent's context.

Every bubble is a **node** (id, label, optional notes, type/color) and every
arrow is an **edge** (source → target, optional label, dependency semantics).
Diagrams are organized into folders.

See `../docs/DIAGRAM_TOOL_PROMPT.md` for the original design brief.

## Stack

- **Backend**: TypeScript + Express + `node:sqlite`, port `3010`
- **Frontend**: React + Vite + Tailwind + `@xyflow/react` (React Flow), port `5180`

Same constraint as the main backend: no native-module dependencies
(`node:sqlite`, not `better-sqlite3`) — this machine has no VS Build Tools.

## Setup

```bash
cd diagram-tool/backend
cp .env.example .env
npm install

cd ../frontend
npm install
```

## Run

```bash
cd diagram-tool/backend
npm run dev   # http://localhost:3010

cd diagram-tool/frontend
npm run dev   # http://localhost:5180
```

Not currently launched by the root `start.bat` — start it manually when
you need the editor or want diagrams available to attach in the main app.

## Integration with the main app

The main backend (`backend/src/diagrams/diagramClient.ts`) proxies this
service's API under `/api/diagrams` so the frontend's Diagrams tab never
talks to port 3010 directly for listing/attaching. The **Open editor** link
in that tab opens this tool's own UI (`http://localhost:5180`) directly for
creating/editing diagrams.

Override the target with `DIAGRAM_TOOL_BASE_URL` in `backend/.env` if this
service runs on a different host/port.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/diagrams/folders` | List folders |
| POST | `/api/diagrams/folders` | Create folder (`name`, `parent_id?`) |
| PATCH | `/api/diagrams/folders/:id` | Rename folder |
| DELETE | `/api/diagrams/folders/:id` | Delete folder |
| GET | `/api/diagrams` | List diagrams |
| POST | `/api/diagrams` | Create diagram |
| GET | `/api/diagrams/:id` | Get a diagram (full node/edge graph) |
| PATCH | `/api/diagrams/:id` | Update a diagram |
| DELETE | `/api/diagrams/:id` | Delete a diagram |
| GET | `/api/diagrams/:id/agent-format` | Get the diagram's machine-readable text (Mermaid + dependency listing) |

## Data

SQLite database at `diagram-tool/backend/data/diagrams.db` (gitignored).
