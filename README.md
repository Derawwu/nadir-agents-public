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
- **AI**: Anthropic SDK: Sonnet 5.5, Opus 5.5 and Haiku 5.5, picked per agent (see [Models](#models))
- **Retrieval**: local embeddings through [Ollama](https://ollama.com) (`qwen3-embedding:0.6b`) plus SQLite FTS5 keyword search (see [Retrieval](#retrieval))

> **Note**: Uses Node's built-in `node:sqlite` module (requires Node 22.5+). No native compilation needed — this machine has no VS Build Tools, so avoid adding any dependency that needs native compilation (e.g. `better-sqlite3`).

## Setup

### Prerequisites

- Node.js 22.5 or higher (Node 24 recommended)
- npm 9+
- Anthropic API key
- [Ollama](https://ollama.com) with `ollama pull qwen3-embedding:0.6b` (optional: without it, retrieval falls back to keyword search)
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
- "Context: 2 earlier messages · 1 wiki excerpt · 1 diagram" under a reply lists what retrieval added to its request, with links to each source

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
      modelStatus.ts    # Compares configured models with the Models API
    retrieval/
      chunker.ts        # Splits messages, wiki pages and diagrams into ~400-token chunks
      embeddings.ts     # Ollama embedding client (local)
      indexer.ts        # Keeps the index in step with messages, Outline and the diagram tool
      search.ts         # BM25 + embedding search, rank fusion, relevance gate
      context.ts        # Turns hits into the prompt's excerpts and the UI's source list
    diagrams/
      diagramClient.ts  # Thin proxy client to the standalone diagram-tool backend
    outline/
      outlineService.ts # Outline wiki integration
    plane/
      planeService.ts   # Plane sync plus per-agent create / update / comment
      planeHtml.ts      # Plane description HTML <-> plain text
    dataExport/
      dataExportService.ts # Runs ../nadir-agents-data/snapshot.ps1 on demand, tracks job status
    routes/
      agents.ts          # GET /api/agents, GET /api/agents/:id/memories
      features.ts         # GET/POST/PATCH /api/features
      chat.ts              # POST /api/chat/message (SSE), POST /api/chat/memory
      roundtable.ts         # POST /api/roundtable/start (SSE), GET/POST /api/roundtable/:id
      diagrams.ts            # Proxies the standalone diagram-tool app
      outline.ts              # Outline wiki proxy
      plane.ts                  # Plane sync, browse, and per-agent writes
      dataExport.ts               # POST /api/data-export/run, GET /api/data-export/status
      usage.ts                    # GET /api/usage/summary, GET /api/usage/chats/:id
      models.ts                   # GET /api/models/status
      retrieval.ts                # GET /api/retrieval/status, /search; POST /api/retrieval/reindex, /rebuild
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
| POST | `/api/plane/sync` | Pull Plane work items (title, state, description, ID) and cycles into features |
| POST | `/api/plane/issues` | Create a Plane work item as an agent (`role`, `name`, `description?`, `state?`, `priority?`) |
| PATCH | `/api/plane/issues/:featureId` | Edit a work item's `name`, `description`, `state` or `priority` as an agent (`role`) |
| POST | `/api/plane/issues/:featureId/comments` | Comment on a work item as an agent (`role`, `text`) |
| GET | `/api/diagrams/list` | List diagrams (proxied from diagram-tool) |
| GET | `/api/diagrams/:id/agent-format` | Get a diagram's machine-readable text (proxied from diagram-tool) |
| GET | `/api/usage/summary` | Usage totals and breakdowns (query: `days` = number or `all`, `kind`) |
| GET | `/api/usage/chats/:id` | One chat's total cost and its last request's tokens and cache hit rate |
| GET | `/api/retrieval/status` | Retrieval index size, embedding model and the last full rebuild's progress |
| POST | `/api/retrieval/rebuild` | Re-chunk and re-embed everything in the background (202; 409 if one is running) |
| GET | `/api/retrieval/search` | Debug search over the whole index (query: `q`, `mode` = `hybrid` / `bm25` / `vector`, `limit`) |
| POST | `/api/retrieval/reindex` | Index new messages and re-sync changed wiki pages and diagrams now |
| GET | `/api/models/status` | Whether each configured model is current, deprecated, or has a newer model in its family (cached 1h; `refresh=1` to bypass) |
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
   (decisions, facts and lore, user preferences, open questions) by Haiku 5.5, in
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
| Narrator (Sonnet 5.5) | 100 | 108,252 tokens / $0.217 | 108,290 / $0.031 | 29,125 / $0.015 | 93% |
| Architect (Opus 5.5) | 56 | 68,955 tokens / $0.276 | 69,218 / $0.020 | 31,764 / $0.013 | 95% |

The same chat counts about 40% more tokens on Sonnet 5.5 because of its newer
tokenizer, but the lower price more than makes up for it.

A live check on the Narrator chat confirmed it: the second identical request
read 27,041 tokens from cache and paid full price for 2,076.

**Trade-offs**
- **Cache lifetime.** The cache expires 5 minutes after last use. When you
  reply after a longer pause, the prefix is written again at 1.25× the input
  price. With windowing that "cold" message still costs about a third of what
  it did before ($0.072 vs $0.217 on the Narrator chat). `CACHE_TTL=1h` keeps
  the cache longer, but writes cost 2×. The Usage tab's cache hit rate shows
  which suits how you work.
- **Summaries lose detail.** Exact wording older than the window is gone
  from the history. The summary prompt keeps names, numbers and decisions
  verbatim, and [retrieval](#retrieval) brings back the original messages
  when a new one is about them.
- **Token estimates are approximate** (characters ÷ 4). They are only used to
  size the window, and they run low for code-heavy text and the Opus 4.7+
  tokenizer, which is why the Architect chat's window is above 20k.
- `CONTEXT_STRATEGY=full` switches back to sending the whole history (still
  with the new caching), and every logged call records which strategy it used.

Re-run the benchmark from `backend/` with `npx tsx scripts/bench-context.ts`.

### Models

Each agent's model is set in `backend/.env`, and so is how hard it thinks:

| Role | Default model | Price in / out per MTok | Why |
|---|---|---|---|
| Narrator | Sonnet 5.5 | $2 / $10 | Long creative threads; good writing at mid price |
| Architect | Opus 5.5 | $4 / $20 | Hardest technical reasoning |
| UX/UI, Analyst | Haiku 5.5 | $0.10 / $0.50 | Short reviews and checklists |
| Titles, chat summaries | Haiku 5.5 | $0.10 / $0.50 | Cheap background jobs |
| Roundtable summary | Sonnet 5.5 | $2 / $10 | Merges several agents' views into decisions |

- **Effort, not temperature.** 5.5 models think adaptively. `ANTHROPIC_EFFORT_<ROLE>`
  (`low` to `max`, default `medium`) sets how much, which is the main lever on
  cost and latency per reply. Titles and summaries run at `low`.
- **Refusals don't break a chat.** Opus 5.5 and Sonnet 5.5 requests set
  server-side `fallbacks`, so a request their classifiers decline is retried on
  another model inside the same call. If a reply is still declined, the chat
  shows a notice with the category instead of an empty message.
- Pricing, including Haiku 5.5's higher rate above 100k prompt tokens and Opus
  5.5's cheaper cache reads, lives in `backend/src/llm/pricing.ts`.
- **Staying current.** On the first page load of a browser session the app asks
  the backend to compare every configured model with Anthropic's Models API.
  If a newer model exists in the same family (Opus, Sonnet, Haiku), or a model
  is deprecated or unknown, a banner lists which env var to change and to what.
  The result is kept in `sessionStorage`, so it doesn't run again until a new
  session, and the backend caches the model list for an hour.
Add `--summarize` to build missing summaries first, which calls the summary
model.

## Retrieval

Each chat message is searched against an index of older messages, the
Outline wiki and the diagram tool, and the most relevant excerpts go into
the request's `<context>` block.

Before this:
- **Wiki:** Outline was searched by the feature's name, so every message got
  the same three pages.
- **Memories:** the newest 20 went in, relevant or not.
- **Old messages:** anything outside the history window was only in the
  summary.
- **Diagrams:** only reached the agent when you added one to the Context
  Tray by hand. That still works and sends the full diagram.

Memories are still added in full. There are few of them and the user saves
each one on purpose, so filtering them would only lose information.

**How it works** (`backend/src/retrieval/`)
1. **Indexing.** Messages, wiki pages and diagrams are split into ~400-token
   chunks.
   - **Diagrams** are indexed from the diagram tool's agent format: name,
     description, nodes with their notes, and dependencies. The Mermaid
     block and generated node ids are dropped, since they only repeat the
     listing.
   - **Keyword index:** each chunk goes into an FTS5 index at once.
   - **Embeddings:** each chunk is embedded in the background by a local
     model (`qwen3-embedding:0.6b` through Ollama). If Ollama is down,
     keyword search still works.
   - **When:** new messages after every reply; changed wiki pages and
     diagrams every 10 minutes. Outline or the diagram tool being down
     doesn't stop the other.
2. **Search.** The new message is run through both:
   - **BM25 keyword search** catches exact names and terms.
   - **Embedding search** catches the same idea in other words.

   The two rankings are merged with reciprocal rank fusion, so their scores
   never need calibrating against each other. The vectors are compared by
   brute force in memory: a few thousand chunks take about 7 ms, so a vector
   database would add nothing.
3. **Selection.** A chunk goes into the prompt only if it's similar enough to
   the message (cosine ≥ 0.55, or ≥ 0.45 for a top-3 keyword match), up to 8
   chunks and about 3k tokens.
4. **What's skipped.**
   - Messages already in the verbatim history.
   - Other agents' chats.
   - Deleted chats.
5. **Short follow-ups.** For "go on" and other messages of four words or
   fewer, the end of the previous reply is searched with them.

**Why local embeddings.** Claude has no embeddings endpoint. A local model
is free, needs no extra API key and keeps chat history on the machine. It
runs through Ollama's HTTP API, so the backend gains no native dependency.

**Evaluated** with `backend/scripts/eval-retrieval.ts`, on 48 questions
(30 about chat messages, 18 about wiki pages; there were no diagrams yet,
and once there are, the eval samples them too). Claude Haiku wrote one
question per sampled chunk, then 20 off-topic messages such as recipes,
meeting replies or "tabs or spaces?". A question counts as found when a
chunk from the same message or page is returned. There are two sets of
questions over the same chunks:
- **Natural:** worded freely. These tend to reuse the passage's words, which
  flatters keyword search.
- **Paraphrased:** the passage's distinctive words are banned (names
  excepted).

| Questions | Search | Recall@1 | Recall@5 | MRR@10 |
|---|---|---|---|---|
| Natural | Keyword (BM25) | 52% | 94% | 0.70 |
| | Embeddings | 50% | 79% | 0.60 |
| | Hybrid | 46% | 85% | 0.63 |
| Paraphrased | Keyword (BM25) | 42% | 94% | 0.60 |
| | Embeddings | 38% | 65% | 0.49 |
| | Hybrid | **48%** | 90% | **0.64** |

The threshold was picked from a sweep of what actually reaches the prompt:

| Min similarity | Passage reaches the prompt (natural / paraphrased) | Off-topic messages that get any excerpt |
|---|---|---|
| 0.45 | 90% / 98% | 27% / 10% |
| 0.55 (default) | 90% / 90% | 9% / 5% |
| 0.65 | 85% / 60% | 0% / 0% |

What the numbers say:
- **Keyword search is strong here.** The corpus is full of distinctive names
  (gods, places, mechanics), and even paraphrased questions keep them.
- **Hybrid ranks best when the wording changes.** On paraphrased questions it
  has the best top-1 hit rate and MRR. Keyword search still finds a few
  more in the top 5, and embeddings alone fall off.
- **Embeddings mostly act as the relevance check.** Keyword search matches
  any shared word, so on its own it can't tell what is worth putting in
  the prompt.
- **Weighting the two rankings differently in fusion** changed results by one
  question at most, so the setting isn't exposed.

**First eval run.** It scored only 47% on chat questions. The cause was a bug
in the eval, not in search: Haiku returned the questions as a plain list,
and one skipped item shifted every later question onto the wrong passage.
Questions are now matched by the index each one echoes back.

**Cost.** Embedding and searching take about 30 ms per message. The excerpts
add up to ~3k uncached input tokens, about $0.006 per reply on Sonnet 5.5.
Generating the eval sets cost under $0.01.

**Reindex button** (top nav). The index normally only picks up new and
changed items. Reindex rebuilds all of it: every message, wiki page and
diagram is re-chunked and every chunk re-embedded, about 15 s for ~640
chunks, with progress shown on the button. Use it after changing chunking
or when results look stale. While it runs, search falls back to keywords.

Settings (`backend/.env.example`): `RETRIEVAL_ENABLED`, `EMBEDDING_MODEL`,
`OLLAMA_BASE_URL`, `RETRIEVAL_TOKEN_BUDGET`, `RETRIEVAL_MAX_CHUNKS`,
`RETRIEVAL_MIN_SIMILARITY`. Changing `EMBEDDING_MODEL` re-embeds the index
automatically.

```bash
cd backend
npx tsx scripts/eval-retrieval.ts --generate 60   # writes data/eval/ (gitignored: it quotes chats)
npx tsx scripts/eval-retrieval.ts
```

## Plane integration

Plane work items sync into the `features` table (title, state, description
and Plane's own ID). Agents can also write back, the same way they write to
the Outline wiki:

- **Each agent edits as its own Plane user**, so Plane's history shows who
  changed what. Set `PLANE_TOKEN_NARRATOR`, `PLANE_TOKEN_ARCHITECT` and
  `PLANE_TOKEN_UXUI` to API tokens of those users; an agent without one falls
  back to `PLANE_API_TOKEN`. The users must be members of the project, not
  only the workspace. The analyst is read-only, as in Outline.
- **Create, edit, comment; never delete.** Writes take plain text with
  `#` headings and `-` bullets, converted to Plane's HTML. `state` accepts a
  Plane state name ("In Progress"), a state group (`started`) or an app status
  (`active`). Each write updates the local feature row straight away.
- **Roundtables leave their outcome on the issue.** When a roundtable is about
  a Plane work item, the narrator posts the decisions, open conflicts and
  action items as a comment, with a link to the full summary in the wiki.

Local bot users need email only to sign up. Point Plane's SMTP at the Outline
stack's Mailpit (`podman network connect plane_default outline-outline-mailpit-1`,
then host `outline-outline-mailpit-1`, port 1025, no auth) and use any
`@nadir.test` address.

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
