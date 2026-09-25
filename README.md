# Togezer

Togezer is an agent-coordination workspace MVP: you submit a goal, an orchestrator
decomposes it into role-matched sub-tasks executed by **simulated** specialized agents
(a Researcher, a Coder, and a Reviewer), a real-time React kanban dashboard streams
the execution over WebSocket, and every task outcome banks a lesson into persistent
SQLite shared memory that the whole team reads from.

The agents are deterministic simulations (no LLM calls), but everything around them
is real: the REST + WebSocket server, the persistence layer, the event stream, and
the dashboard.

## Prerequisites

- **Node.js >= 22** (pinned via `engines` in `package.json`; the server uses Node's
  built-in `node:sqlite` driver, available since Node 22 — the repo is developed
  and verified against Node 24).

## Quickstart

```bash
npm install     # installs all workspaces (server + web)
npm run dev     # starts the API server (:3001) and the Vite dev server (:5173)
```

Open **http://localhost:5173** and type a goal into the form — e.g.
`launch the marketing site`. The orchestrator decomposes it into four sub-tasks
(1 research, 2 code, 1 review) and the simulated agents pick them up: watch the
cards move across the kanban board (Todo → In Progress → Done), the agent panel
flip between idle/working, and lessons land in the Lessons Feed as each task
finishes. Reconnects are handled automatically; the header shows the live
connection state.

## Scripts

Run from the repo root:

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs `npm run dev -w server` and `npm run dev -w web` concurrently |
| `npm run dev -w server` | Express + WS API with `tsx watch` (auto-reload), port 3001 |
| `npm run dev -w web` | Vite dev server for the dashboard, port 5173 |
| `npm run build` | Builds both workspaces (`tsc` for server; `tsc --noEmit` + `vite build` for web) |
| `npm test` | Runs the full vitest suite (server + web) |
| `npm run typecheck` | `tsc --noEmit` over server and web |
| `npm run lint` | ESLint over the repo |
| `npm run smoke` | End-to-end backend smoke test (same as `node scripts/smoke.mjs`) |

`node scripts/smoke.mjs` boots the full backend composition by hand (temp SQLite
database, seeded three-agent team, Express + WS hub on an ephemeral port), submits
a goal, collects live WebSocket events, polls until every task reaches a terminal
status, and verifies lessons were persisted. Exit codes: `0` pass, `1` boot or
assertion failure, `2` tasks still non-terminal after the 20s poll timeout.

## Architecture

```
+--------------------------- Browser (web/) ---------------------------+
|  React 19 dashboard                                                  |
|    GoalForm  Board (kanban)  AgentPanel  LessonsFeed                 |
|    store.ts  - reducer store via useSyncExternalStore                |
|    api.ts    - typed REST client + WS client (reconnect + backoff)   |
+-------------------------^------------------------^-------------------+
          REST (same-origin; Vite dev proxy -> localhost:3001)   WS /ws
+-------------------------v------------------------v-------------------+
|  Server (server/, Express 5 + ws)                                    |
|    api.ts          REST routes, JSON errors                          |
|    ws.ts           WebSocket hub at /ws, JSON fan-out                |
|    orchestrator.ts goal decomposition + role-matched assignment      |
|    agents.ts       simulation tick loop (deterministic, seeded)      |
|    db.ts           SQLite persistence (node:sqlite)                  |
|    types.ts        canonical shared domain contract                  |
+----------------------------------------------------------------------+
```

- `server/src/db.ts` — idempotent schema, prepared statements, ISO 8601 timestamps,
  UUID ids; every accessor takes the `DatabaseSync` handle first.
- `server/src/orchestrator.ts` — pure layer, no HTTP/timers: a fixed deterministic
  4-task template (one researcher, two coder, one reviewer task) and assignment that
  prefers idle agents, then lowest open-task load, ties broken by creation order.
- `server/src/agents.ts` — tick loop advancing each agent's task
  `todo -> in_progress -> done/failed` with a seeded mulberry32 PRNG (~8% failure
  rate by default); every terminal transition banks a lesson (success) or a pitfall
  (failure). Same seed reproduces the same run.
- `server/src/ws.ts` — hub attached at `/ws`; broadcasts JSON events to open
  clients and prunes dead sockets.
- `server/src/api.ts` — Express app wiring db + orchestrator + the event sink.
- `web/src/types.ts` — type-only re-export of `server/src/types.ts`, which is the
  canonical contract for `Agent`/`Task`/`Goal`/`Lesson`/`WsEvent`. Do not duplicate.

## REST API

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| `GET` | `/health` | `200` `{ ok: true }` | — |
| `POST` | `/goals` body `{ "text": string }` | `201` `{ goal, tasks }` | `400` `{ error }` when text is empty |
| `GET` | `/goals/:id` | `200` `{ goal, tasks }` | `404` `{ error: "goal not found" }` |
| `GET` | `/agents` | `200` `{ agents }` | — |
| `GET` | `/lessons?limit=N` | `200` `{ lessons }` (newest first) | `limit` defaults to 50, clamped to 1–200 |
| `GET` | `/state` | `200` `{ agents, goals, tasks, lessons }` | — |

Unknown routes return `404 { error: "not found" }`; malformed JSON bodies return
`400 { error: "invalid JSON body" }`. There is no auth and no CORS — the dev
dashboard talks same-origin through the Vite proxy.

## WebSocket events

Connect to `ws://localhost:3001/ws` (dev browsers connect same-origin; Vite proxies
`/ws`). Every event has an ISO 8601 `at` timestamp:

| `type` | Payload | Meaning |
| --- | --- | --- |
| `task.updated` | `{ at, task }` | Full task row: status, `result`, `activity[]` log |
| `agent.status` | `{ at, agent }` | Agent flipped idle/working, current task id |
| `lesson.created` | `{ at, lesson }` | A lesson (or pitfall) was banked |
| `goal.status` | `{ at, goal }` | Aggregated goal status: pending/running/done/failed |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + WebSocket listen port |
| `TOGEZER_DB` | `server/data/togezer.db` | SQLite file path (parent dir is created) |
| `TOGEZER_SEED` | `42` | Simulation PRNG seed — same seed, same run |
| `TOGEZER_TICK_MS` | `600` | Simulation tick interval in milliseconds |

## Out of MVP scope

Explicitly deferred from this MVP (the PRD vision, not the current code):

- **Human-in-the-loop (HITL)** approval/escalation flows
- **Real LLM agents** — execution is simulated; there are no model calls
- **gRPC** transport protocols — REST + WebSocket only
- **Vector / semantic memory search** — lessons live in plain SQLite rows
- **Auth and multi-user** support
- **Docker / deployment** packaging (local-first dev workflow only)
