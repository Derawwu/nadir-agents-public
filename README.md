# Nadir Agent Team

Multi-agent AI system for Project Nadir (solo gamedev). Simulates a persistent development team of 4 AI agents with dedicated memory, feature-scoped sessions, and dynamic roundtable capability. Also hosts a standalone diagram/dependency tool and integrates with self-hosted Plane (issues) and Outline (wiki).

## Agents

| Agent | Role | Responsibility |
|-------|------|----------------|
| **Narrator** | PM | Vision, lore, experience specs, narrative integrity |
| **Architect** | Tech Lead | Technical specs, system design, architectural integrity |
| **UX/UI** | Art Lead | Visual direction, asset guidance, UI layout |
| **Analyst** | QA / Scout | Gap analysis, blind spot hunting, scope risk flagging |

## Repo layout

```
backend/         Nadir agent-team API (Express + node:sqlite), port 3001
frontend/        Nadir agent-team UI (React + Vite + Tailwind), port 5173
diagram-tool/    Standalone node-graph diagram/dependency tracker
  backend/         API + SQLite store, port 3010
  frontend/        Canvas UI (React Flow), port 5180
outline/         Docker Compose for the Outline wiki, port 3002
plane/           Vendored upstream clone of Plane (issue tracker, port 80).
                 Its own git repo — not tracked here, see plane/README.md
scripts/         Backup/restore/seed PowerShell + Node scripts
docs/            Planning docs (e.g. the diagram-tool build prompt)
backups/         Local DB backups (gitignored)
start.bat        Launches Plane, Outline, and the agent backend/frontend
```

`plane/` and `backups/` are excluded from version control — `plane/` is its own
upstream git repository (vendored, not a subtree), and `backups/` is local
output. See `.gitignore`.

**Code vs. data**: this repo intentionally contains no application data
(Outline wiki content, Plane issues, diagrams). Those are versioned in a
separate sibling repo, `../nadir-agents-data`, so the code here can be shared
without exposing that content. See that repo's README for what it captures
and how to refresh it.

## Stack

- **Backend**: Node.js 22+, TypeScript, Express, `node:sqlite` (built-in)
- **Frontend**: React 18, Vite, Tailwind CSS
- **AI**: Anthropic SDK (`claude-sonnet-4-6`)

> **Note**: Uses Node's built-in `node:sqlite` module (requires Node 22.5+). No native compilation needed — this machine has no VS Build Tools, so avoid adding any dependency that needs native compilation (e.g. `better-sqlite3`).

## Setup

### Prerequisites

- Node.js 22.5 or higher (Node 24 recommended)
- npm 9+
- Anthropic API key
- Docker/Podman (for Plane and Outline)

### 1. Environment

Each service reads its own `.env` from its own directory (`backend/.env`,
`diagram-tool/backend/.env`, `outline/.env`). Copy the relevant `.env.example`
and fill in secrets, e.g.:

```bash
cp diagram-tool/backend/.env.example diagram-tool/backend/.env
```

Minimum `backend/.env`:

```
ANTHROPIC_API_KEY=your_key_here
PORT=3001
DB_PATH=./data/nadir.db
CORS_ORIGIN=http://localhost:5173
```

### 2. Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
cd ../diagram-tool/backend && npm install
cd ../frontend && npm install
```

### 3. Install git hooks

```powershell
.\scripts\install-hooks.ps1
```

Copies `scripts/hooks/*` into `.git/hooks/` (not version-controlled by git
itself, so re-run this after cloning or whenever a hook script changes).
Currently installs a `post-commit` hook that fires the `../nadir-agents-data`
snapshot after every commit here — see "Automatic data export" below.

### 4. Run

Easiest: run `start.bat` from the repo root — it starts Podman, Plane, Outline,
and the agent backend/frontend in separate windows. The diagram-tool isn't
wired into `start.bat` yet; start it manually when you need it:

```bash
cd diagram-tool/backend && npm run dev   # http://localhost:3010
cd diagram-tool/frontend && npm run dev  # http://localhost:5180
```

Or run each piece by hand:

**Terminal 1 — Backend:**
```bash
cd backend
npm run dev
```

The backend starts on `http://localhost:3001`. On first run it:
- Creates the SQLite database at `./data/nadir.db`
- Runs schema migrations
- Seeds the 4 agents (idempotent — safe to restart)

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```

Frontend starts at `http://localhost:5173`.

## Usage

### Chat Page (`/`)

- Select an agent from the left sidebar
- Optionally scope to a feature
- Chat with the selected agent — responses stream in real-time
- Save any agent response as a typed memory (decision / lore / technical / visual / flag / conflict)
- Memory panel on the right shows the agent's current memory for the selected feature
- Attach context (features, diagrams, etc.) via the Context Tray before sending

### Roundtable Page (`/roundtable`)

- Select a feature and enter a discussion topic
- Click **Start Roundtable** — all 4 agents respond in order (Narrator → Architect → UX/UI → Analyst)
- Conflicts are detected automatically and highlighted
- If conflicts exist, a new round begins (max 3 rounds)
- After completion or termination, a neutral summarization produces decisions, open conflicts, and per-agent action items
- Summary is automatically saved as memories for all agents
- **Terminate** button available at any time to halt mid-session

### Diagrams Tab

- Lists diagrams from the standalone diagram-tool (proxied through the backend at `/api/diagrams`)
- Attach a diagram to the Context Tray to inject its machine-readable form (Mermaid + structured dependency listing) into an agent chat
- The **Open editor** link launches the diagram-tool's own canvas UI (`http://localhost:5180`) to create/edit diagrams
- See `diagram-tool/README.md` for details on the standalone tool itself

### Export data (top-right nav button)

Triggers a one-off snapshot of Outline + Plane + diagrams data into the
separate `../nadir-agents-data` repo — the same thing `snapshot.ps1` does
manually, without leaving the app. Click **Export data**; it runs in the
background (`POST /api/data-export/run`), the button shows **Exporting…**
while the frontend polls `GET /api/data-export/status`, then reports
**Exported ✓** (hover for the commit hash/timestamp) or **Export failed**
(hover for the error) before resetting to idle after a few seconds. Requires
the Outline/Plane containers to be running and `D:\nadir-agents-data` to
exist alongside this repo — see `../nadir-agents-data/README.md`.

### Automatic data export (git hook)

A `post-commit` hook (`scripts/hooks/post-commit`, installed via
`.\scripts\install-hooks.ps1`) fires the same `snapshot.ps1` automatically
after every commit made in **this** repo — no button click needed. It:

- Launches `snapshot.ps1` fully detached (`cmd start` + `powershell -WindowStyle
  Hidden`) so it never blocks or slows down `git commit`.
- Never fails your commit: the hook always exits `0`. If the snapshot itself
  errors, that only shows up in `nadir-agents-data/snapshot.log` — check
  there if a commit doesn't seem to have produced a new snapshot.
- Only touches the separate `nadir-agents-data` repo (its own `.git`) —
  can't recurse into or interfere with this repo's own commit.
- Pushes the data-repo commit if that repo ever has a remote configured;
  today (no remote) it just logs `[SKIP] no remote configured, skipping
  push` and does nothing further.

Re-run `.\scripts\install-hooks.ps1` after cloning fresh or editing the hook
— `.git/hooks/` itself is never version-controlled.

## Architecture

```
backend/
  src/
    db/
      connection.ts     # node:sqlite singleton (WAL mode, FK enforcement)
      schema.ts         # Idempotent migrations (IF NOT EXISTS)
      seed.ts           # Agent seeding (skips if already present)
    agents/
      agentService.ts   # Agent CRUD (read-only at runtime)
      memoryService.ts  # Memory read/write/inject
      promptBuilder.ts  # Context assembly: system prompt + feature brief + memories + history
      modelConfig.ts    # Model selection config
    features/
      featureService.ts # Feature CRUD
    chat/
      chatService.ts    # Single-agent streaming sessions
      roundtableService.ts # Multi-agent orchestration with conflict detection
    diagrams/
      diagramClient.ts  # Thin proxy client to the standalone diagram-tool backend
    outline/
      outlineService.ts # Outline wiki integration
    plane/
      planeService.ts   # Plane issue tracker integration
    dataExport/
      dataExportService.ts # Runs ../nadir-agents-data/snapshot.ps1 on demand, tracks job status
    routes/
      agents.ts          # GET /api/agents, GET /api/agents/:id/memories
      features.ts         # GET/POST/PATCH /api/features
      chat.ts              # POST /api/chat/message (SSE), POST /api/chat/memory
      roundtable.ts         # POST /api/roundtable/start (SSE), GET/POST /api/roundtable/:id
      diagrams.ts            # Proxies the standalone diagram-tool app
      outline.ts              # Outline wiki proxy
      plane.ts                  # Plane issue tracker proxy
      dataExport.ts               # POST /api/data-export/run, GET /api/data-export/status
    index.ts            # Express entry point
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:id/memories` | Get agent memories (query: `featureId`, `limit`) |
| GET | `/api/features` | List all features |
| POST | `/api/features` | Create feature (`name`, `description?`, `phase?`, `locked_decisions?`) |
| PATCH | `/api/features/:id` | Update feature (partial) |
| POST | `/api/chat/message` | Send chat message (SSE response) |
| POST | `/api/chat/memory` | Save a memory from a conversation |
| POST | `/api/roundtable/start` | Start a roundtable (SSE response) |
| GET | `/api/roundtable/:id` | Get roundtable with all turns |
| POST | `/api/roundtable/:id/terminate` | Manually terminate active roundtable |
| GET | `/api/diagrams/list` | List diagrams (proxied from diagram-tool) |
| GET | `/api/diagrams/:id/agent-format` | Get a diagram's machine-readable text (proxied from diagram-tool) |
| POST | `/api/data-export/run` | Start a data snapshot (202 if started, 409 with current status if one's already running) |
| GET | `/api/data-export/status` | Poll the current/last snapshot job status |

## Feature Lifecycle

Features move through phases: `kickoff → spec → design → build → review`

Status: `backlog → active → review → closed`

`locked_decisions` is a JSON array of strings — decisions the agents will not re-litigate.

## Roundtable Conflict Protocol

Agents signal conflicts by appending this block to their response:

```
[CONFLICT:AgentName] one-sentence description of the conflict [/CONFLICT]
```

The parser is whitespace-tolerant. Conflicts trigger additional rounds up to the configured maximum (3).

## Related services

- **Plane** (`plane/`) — self-hosted issue tracker, `http://localhost` (see `plane/README.md`). Vendored upstream repo; started/stopped via `docker-compose` from that directory.
- **Outline** (`outline/`) — self-hosted wiki, `http://localhost:3002` (see `outline/README.md`). Login uses Mailpit as a local SMTP catcher.
- **Diagram tool** (`diagram-tool/`) — standalone node-graph diagram editor, integrated into the main frontend's Diagrams tab and Context Tray. See `diagram-tool/README.md`.
