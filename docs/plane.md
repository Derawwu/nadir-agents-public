# Plane integration

[Plane](https://plane.so) is the self-hosted issue tracker used by this
project (it replaced an earlier Jira integration — that's why some backend
identifiers still say `jira_*`). This doc covers how it's wired into
nadir-agents; for running Plane itself see `plane/README.md` inside the
vendored clone (not available on GitHub — see "The vendored clone" below).

## Not tracked in this repo

`plane/` is excluded via `.gitignore` (`/plane/`) because it's a full
vendored clone of the upstream [Plane](https://github.com/makeplane/plane)
repo — its own git history, own `.git`, own README/docs. This project only
runs it via `plane/docker-compose.yml`; nothing under `plane/` is
project-specific code. If you're reading this on GitHub, `plane/` won't be
there — see "The vendored clone" below for how to get it locally.

## How it's used here

- Backend service: `backend/src/plane/planeService.ts`. Calls the Plane REST
  API (`X-Api-Key` auth) and upserts issues/cycles into the local `features`
  table, reusing the same `jira_key`/`jira_status` columns from the earlier
  Jira integration (issues get keys like `NB-123`, cycles `NB-CYC-<id>`).
- Routes: `backend/src/routes/plane.ts`
  - `POST /api/plane/sync` — pulls all states/issues/cycles for the
    configured project and upserts them.
  - `GET /api/plane/status` — connection check (lists projects if reachable).
  - `POST /api/plane/browse` — search/filter synced features by name or status.
  - `POST /api/plane/issue-content` — full detail for one synced feature.
- Frontend: `frontend/src/components/PlaneTab.tsx` (the **Plane** nav tab) —
  triggers sync, browses synced issues, and surfaces them for attaching to
  agent chat via the Context Tray.

## Configuration

Set in `backend/.env`:

```
PLANE_BASE_URL=http://localhost
PLANE_API_TOKEN=<personal API token from Plane's settings>
PLANE_WORKSPACE_SLUG=<your workspace slug>
PLANE_PROJECT_ID=<the project UUID to sync>
```

## The vendored clone

`plane/` is a full clone of upstream Plane, pinned to whatever commit was
checked out when it was set up here. It's not tracked by this repo, so:

- **Running it**: `cd plane && docker-compose up -d` (or via the root
  `start.bat`, which starts it alongside Outline and the agent stack).
- **On a fresh machine / clone of nadir-agents**: `plane/` won't exist —
  clone Plane separately (`git clone https://github.com/makeplane/plane`
  into `plane/`) and follow its own setup docs, or copy an existing `plane/`
  checkout over. This repo assumes `plane/docker-compose.yml` exists at that
  path; nothing here recreates it.

## Plane's data

Plane's issues/cycles/attachments live in Docker volumes (Postgres +
MinIO), not in this repo. They're captured separately in the
`../nadir-agents-data` repo (`plane/plane.sql` + `plane/uploads/`) — see
that repo's README for what's captured and how to refresh/restore it. The
`features` table in nadir-agents' own SQLite DB (`backend/data/nadir.db`) is
a synced *copy* of a subset of that data (name/status/keys only), not the
source of truth.
