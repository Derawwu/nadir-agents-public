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

Each service reads its own `.env` from its own directory. Copy each
`.env.example` and fill in the placeholders:

```bash
cp backend/.env.example backend/.env
cp outline/.env.example outline/.env
cp diagram-tool/backend/.env.example diagram-tool/backend/.env
```

Only `ANTHROPIC_API_KEY` is needed to chat with the agents; the Plane and
Outline values are needed for those integrations. Every variable is
explained in the example files. For `outline/.env`, set
`OUTLINE_PG_PASSWORD` (and the matching password inside `DATABASE_URL`)
before the first `docker-compose up`.

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
the agent backend/frontend, and the diagram-tool backend/editor in separate
windows. To start the diagram-tool on its own:

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

### Usage Tab (`/usage`)

- Every Claude API call is logged (chat replies, roundtable turns and summaries, chat titles, chat summaries) with tokens, cache reads and writes, latency, stop reason and cost
- Headline numbers: total cost vs the previous period, average cost per chat reply, cache hit rate, tokens in/out
- Cost per day stacked by agent, with a marker for the day windowed history was switched on
- Cost by model, and the most expensive chats and roundtables (click a chat to open it)
- Each chat header shows a small badge: total cost, plus size and cache hit rate of the last request

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
      seed.example.ts   # Generic agent prompts + seeding (skips if already present);
                        # copy to seed.ts (gitignored) for your own prompts
    agents/
      agentService.ts   # Agent CRUD (read-only at runtime)
      memoryService.ts  # Memory read/write/inject
      promptBuilder.ts  # Context assembly: cache-friendly order, windowed history
      contextConfig.ts  # Context strategy, history budget, cache TTL settings
      modelConfig.ts    # Model selection config
    features/
      featureService.ts # Feature CRUD
    chat/
      chatService.ts    # Single-agent streaming sessions
      roundtableService.ts # Multi-agent orchestration with conflict detection
      chatSummary.ts    # Running chat summary that replaces older history
    llm/
      pricing.ts        # Per-model prices; cost computed when a call is logged
      usageLog.ts       # Writes every Claude call to llm_calls
      usageService.ts   # Queries for the Usage tab and chat badge
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
      usage.ts                    # GET /api/usage/summary, GET /api/usage/chats/:id
    index.ts            # Express entry point
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:id/memories` | Memories visible in a context, each tagged with its scope (query: `chatId`, `featureId`, `limit`) |
| PATCH | `/api/agents/:id/memories/:memoryId` | Move a memory between scopes (`scope`: `chat` / `feature` / `agent`) |
| GET | `/api/features` | List all features |
| POST | `/api/features` | Create feature (`name`, `description?`, `phase?`, `locked_decisions?`) |
| PATCH | `/api/features/:id` | Update feature (partial) |
| GET | `/api/chat/chats` | List an agent's chats (query: `agentId`, `archived=1` to include archived) |
| POST | `/api/chat/chats` | Create an empty chat (`agentId`, `featureId?`, `title?`) |
| GET | `/api/chat/chats/by-slug` | Chat + messages by URL slug (query: `agentId`, `slug`) |
| GET | `/api/chat/chats/:id` | Chat + messages |
| PATCH | `/api/chat/chats/:id` | Rename, pin, archive or change feature |
| DELETE | `/api/chat/chats/:id` | Soft-delete a chat |
| POST | `/api/chat/message` | Send a chat message (SSE: `chunk`, `done`, `title`, `error`); omitting `conversationId` creates a chat |
| POST | `/api/chat/memory` | Save a chat-scoped memory from a message |
| POST | `/api/roundtable/start` | Start a roundtable (SSE response) |
| GET | `/api/roundtable/:id` | Get roundtable with all turns |
| POST | `/api/roundtable/:id/terminate` | Manually terminate active roundtable |
| GET | `/api/diagrams/list` | List diagrams (proxied from diagram-tool) |
| GET | `/api/diagrams/:id/agent-format` | Get a diagram's machine-readable text (proxied from diagram-tool) |
| GET | `/api/usage/summary` | Usage totals and breakdowns (query: `days` = number or `all`, `kind`) |
| GET | `/api/usage/chats/:id` | One chat's total cost and its last request's tokens and cache hit rate |
| POST | `/api/data-export/run` | Start a data snapshot (202 if started, 409 with current status if one's already running) |
| GET | `/api/data-export/status` | Poll the current/last snapshot job status |

## Context management & cost

Long chats used to resend their whole history on every message. The busiest
chat (100 messages) cost about 76k input tokens per reply, none of it cached:
the only cache point was on the agent prompt, which is shorter than the
1,024-token minimum Claude needs before it caches anything.

Chat requests are now built in three layers:

1. **Cache-friendly order.** Content goes from most to least stable: agent
   prompt, feature brief, chat summary (cache point), then the verbatim
   history (cache point), then the new message. Memories and wiki snippets
   change between turns, so they sit in a `<context>` block on the new message
   instead of the system prompt, where they would invalidate everything after
   them. Each turn reads the previous turn's prefix from cache at a tenth of
   the input price.
2. **Windowed history.** Only roughly the last `HISTORY_TOKEN_BUDGET` tokens
   (20k) are sent verbatim. Older turns are folded into a running summary
   (decisions, facts and lore, user preferences, open questions) by Haiku, in
   the background after a reply.
3. **Batched summary updates.** The summary is only rewritten once another
   `SUMMARY_BATCH_TOKENS` (10k) of history has piled up. Every rewrite changes
   the system prompt and costs one cache rebuild, so rewriting on every turn
   would throw the caching away.

**Measured on the real chats** with `backend/scripts/bench-context.ts`. Token
totals come from Anthropic's token-counting endpoint; the cached/uncached split
is estimated, and only input cost is compared, since output is the same in
every layout:

| Chat | Messages | Before | Cache only | Cache + windowed | Saving |
|---|---|---|---|---|---|
| Narrator (Sonnet 4.6) | 100 | 75,987 tokens / $0.228 | 76,016 / $0.033 | 19,986 / $0.016 | 93% |
| Architect (Opus 4.8) | 56 | 68,953 tokens / $0.345 | 69,216 / $0.041 | 31,762 / $0.024 | 93% |

A live check on the Narrator chat confirmed it: the second identical request
read 18,450 tokens from cache and paid full price for 1,531.

**Trade-offs**
- **Cache lifetime.** The cache expires 5 minutes after last use. When you
  reply after a longer pause, the prefix is written again at 1.25× the input
  price. With windowing that "cold" message still costs about a third of what
  it did before ($0.074 vs $0.228 on the Narrator chat). `CACHE_TTL=1h` keeps
  the cache longer, but writes cost 2×. The Usage tab's cache hit rate shows
  which suits how you work.
- **Summaries lose detail.** Exact wording older than the window is gone.
  The summary prompt keeps names, numbers and decisions verbatim. Retrieval
  over old messages is the next step, so precise recall comes back.
- **Token estimates are approximate** (characters ÷ 4). They are only used to
  size the window, and they run low for code-heavy text and the Opus 4.7+
  tokenizer, which is why the Architect chat's window is above 20k.
- `CONTEXT_STRATEGY=full` switches back to sending the whole history (still
  with the new caching), and every logged call records which strategy it used.

Re-run the benchmark from `backend/` with `npx tsx scripts/bench-context.ts`.
Add `--summarize` to build missing summaries first, which calls the summary
model.

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

- **Plane** (`plane/`) — self-hosted issue tracker, `http://localhost`. Vendored upstream repo (its own git history, not tracked here — see `docs/plane.md`); started/stopped via `docker-compose` from that directory.
- **Outline** (`outline/`) — self-hosted wiki, `http://localhost:3002` (see `outline/README.md`). Login uses Mailpit as a local SMTP catcher.
- **Diagram tool** (`diagram-tool/`) — standalone node-graph diagram editor, integrated into the main frontend's Diagrams tab and Context Tray. See `diagram-tool/README.md`.

## License

[MIT](LICENSE)
