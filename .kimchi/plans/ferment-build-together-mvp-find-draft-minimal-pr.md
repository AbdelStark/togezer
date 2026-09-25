# Plan: Togezer Agent Workspace MVP
---

## Goal
  Build the Togezer MVP: a TypeScript full-stack agent-coordination workspace where a user
  submits a high-level goal, an orchestrator decomposes it into role-matched sub-tasks
  executed autonomously by simulated specialized agents (Researcher, Coder, Reviewer), a
  real-time React kanban dashboard visualizes execution live over WebSocket, and every task
  outcome deposits a "lesson learned" into a persistent SQLite shared memory.

--- INTENT CHARTER ---
Intent (the user's original request, verbatim): build together MVP, find draft minimal prd file in ./draft-minimal-prd.md
Wow factor (what would delight, not merely satisfy): Run npm run dev, type one sentence — 'launch the marketing site' — and watch a team of agents decompose it, swarm the kanban board live, and bank what they learned into memory: a working digital workforce in one terminal and one browser tab.
Confirmed scope (in / explicitly out): In scope: npm-workspaces TypeScript monorepo with (a) Node backend providing goal decomposition + role-based routing to simulated Researcher/Coder/Reviewer agents, an autonomous task lifecycle loop, SQLite-persisted shared lessons memory, and REST+WebSocket APIs; (b) React kanban dashboard with live agent statuses, goal submission form, and lessons feed; (c) end-to-end smoke script and README. Out of scope: HITL approval flows, real LLM agents, gRPC, vector/semantic memory search, auth/multi-user, Docker, deployment.
Acceptance demo (beats the final walkthrough must show): 1) npm install && npm run dev — open the dashboard, empty board, agents idle. 2) Submit a goal via the form — the orchestrator decomposes it; role-matched task cards appear in Todo. 3) Watch agents pick tasks up — cards slide Todo -> In Progress -> Done live over WebSocket with activity notes ticking on each card. 4) The Lessons feed fills; restart the server, reload — lessons are still there.
Grade against this charter — it records the user's original intent. The plan and criteria below are a refinement of it; where they read narrower than the intent, the intent wins unless the charter's confirmed scope says otherwise.

## Success criteria
  - Scaffold: npm-workspaces TypeScript monorepo (server/, web/) installs, typechecks, and
    lints clean — `npm install`, `npm run typecheck`, `npm run lint` all exit 0
  - Goal routing: POST /goals with a high-level goal decomposes it into >=3 sub-tasks
    assigned to registered specialized agents with matching roles — automated
    API/orchestrator test asserts this
  - Simulated agent execution: orchestrator autonomously drives every task through todo ->
    in_progress -> done (or failed) with structured status events and no manual intervention
    — behavioral lifecycle test asserts the full run on a sample goal
  - Shared memory: task outcomes write lessons to a SQLite store; GET /lessons returns them
    and they survive a server/store restart — test asserts presence after close+reopen
  - Real-time dashboard: React kanban board + agent status panel update live over WebSocket
    without refresh, plus a goal-submission form — `npm --prefix web run build` succeeds,
    store/component tests pass, and an inspected run (npm run dev: submit goal, watch cards
    move) is recorded
  - End-to-end smoke: `node scripts/smoke.mjs` boots the backend, POSTs a goal, polls state
    until all tasks reach done, asserts lessons persisted, exits 0
  - `npm test` (Vitest) passes across server and web workspaces covering decomposition,
    lifecycle, lesson persistence, and dashboard state updates

## Constraints
  - TypeScript full-stack npm-workspaces monorepo: server/ = Node + Express + ws, web/ =
    Vite + React. No other languages or frameworks.
  - Simulated (scripted) agents only — no external LLM API calls, no API keys, deterministic
    and seedable behavior
  - SQLite file-based persistence only (prefer Node 22+ built-in node:sqlite; fallback
    better-sqlite3); no external services or databases
  - Real-time protocol is WebSocket (ws) + JSON REST; gRPC from the PRD is out of scope for
    the MVP
  - Runs locally via npm scripts — no Docker, no cloud deployment, no auth/multi-user
  - Human-in-the-loop approval flows are out of scope for this MVP

## Assumptions
  - The repo is greenfield — only draft-minimal-prd.md exists — so Step 4 deep exploration
    was skipped (no implementation surface to probe). Decisions taken with the user:
    TypeScript full-stack stack, simulated agents, and the 3-capability MVP slice
    (dashboard, goal routing, shared memory
  - HITL deferred). Defaults chosen without asking: npm workspaces (not pnpm/turbo) for
    simplicity
  - Vite + React 18 for the web app
  - Express + ws for the server
  - node:sqlite (Node >=22) as the zero-dependency persistence choice with better-sqlite3 as
    fallback if the runtime lacks it
  - plain reducer/zustand-free client store to keep web deps minimal
  - Vitest as the single test runner in both packages
  - Vitest verifies run from repo root via npm --prefix. Test determinism comes from an
    injectable clock/tick and seeded task outcomes in the simulated agents. The user's
    phrase "build together" is interpreted as: this plan is executed chunk by chunk with
    verifiable results, not pair-programming interactivity.

## Scope decisions (vs the literal request)
- Human-in-the-loop handoffs (a PRD key feature) deferred — user selected 3 of 4 offered capabilities; agents run to completion without approval pauses
- Real LLM-backed agents replaced with simulated/scripted agents (user choice) — the MVP proves the coordination infrastructure, not model quality
- Persistent vector-based knowledge graph reduced to a SQLite lessons store with recency/exact-match retrieval — no embeddings or semantic search in MVP
- gRPC dropped; the MVP uses WebSocket + JSON REST only (PRD names WebSockets as the example protocol)
- Multi-user/enterprise concerns (auth, roles of human operators, tenancy) out of scope — single-operator local workspace
- PRD's 'thought-chain progress' approximated by agent activity/status events on task cards rather than real model reasoning traces

## Constraint costs
- Simulated (scripted) agents only — no external LLM API calls — costs: Agents do not produce real research/code/review artifacts; they demonstrate coordination, status flow, and memory sharing with canned outputs
- SQLite lessons store instead of a vector knowledge graph — costs: Lessons can be listed and matched exactly, not semantically searched; agents can't fuzzy-recall similar past problems
- Human-in-the-loop handoffs out of scope — costs: No approval gates — tasks (including simulated failures) proceed without any human checkpoint
- No auth / single operator — costs: Workspace cannot distinguish human users or protect the dashboard; suitable only for local single-user demo

## Quality dimensions
- Contract coherence: WS/REST payload shapes must be identical between server emitters and web consumers — owned by Phase 1 (types.ts single source) and enforced by Phase 2 api.test.ts + Phase 3 store.test.ts
- Determinism: simulated agents/tick loop must be seedable and clock-injectable so tests, smoke, and demo behave predictably — owned by Phase 2 lifecycle step
- End-to-end live-update feel (server emit -> store apply -> board re-render) spans Phases 2-3 with no single-step owner — covered by Phase 4 smoke script and the inspected-run criterion (owner gap acknowledged)
- Operator-console aesthetic consistency (status colors, activity badges, dark theme) — owned by Phase 3 styling step, validated by build + inspected run

## Self-critique (meh-test)
Reading only the goal/criteria, a user could react 'meh, the agents don't actually do anything' — that gap is deliberate and user-chosen (simulated over real LLM) and is priced in constraint_costs. Three PRD qualities cannot be auto-verified: (1) the dashboard's visual polish — mitigated by the inspected-run criterion in the demo script, not by tests alone; (2) the 'thought-chain' feel — approximated by activity events, an approximation the user has not explicitly seen demoed; (3) end-to-end live-update snappiness spanning server emit → store → render — no single step owns it, so Phase 4's smoke + inspected run carries it (owner gap recorded in quality_dimensions). Everything else maps to a concrete testable criterion the user confirmed.

## Phases
---

### Phase 1: Phase 1 — Monorepo scaffold & contracts
**Goal:** Green npm-workspaces TypeScript monorepo with server/ and web/ packages, shared
          domain/event types, and all tooling scripts wired
**Steps:**
- Create root package.json (workspaces: server, web; scripts: dev, build, test,
  typecheck, lint), .gitignore (node_modules, dist, *.db), tsconfig.base.json
  (strict), and package.json + tsconfig for server/ (Express, ws, tsx, vitest) and
  web/ (Vite, React, vitest) with dependencies pinned
- Define shared domain contracts in server/src/types.ts: Agent {id,name,role,status},
  Task {id,goalId,title,role,status,assigneeId,result?}, Goal {id,text,status}, Lesson
  {id,content,sourceTaskId,createdAt}, and the WsEvent discriminated union
  (task.updated, agent.status, lesson.created, goal.status); export a types-only
  surface the web package also consumes
- Wire tooling end-to-end: vitest configs in both packages, minimal eslint flat
  config, dev scripts (tsx watch for server, vite for web), and placeholder
  src/index.ts entry points so every script runs

### Phase 2: Phase 2 — Backend: orchestrator, agents, persistence, API
**Goal:** A bootable backend that accepts goals via REST, decomposes and assigns them to
          simulated agents, drives the full task lifecycle autonomously, persists lessons to
          SQLite, and broadcasts everything over WebSocket
**Steps:**
- Implement server/src/db.ts: node:sqlite schema (goals, agents, tasks, lessons) +
  typed CRUD functions, plus server/src/db.test.ts covering roundtrip writes and reads
- Implement server/src/orchestrator.ts: goal decomposition (goal text -> >=3
  role-matched sub-task templates across Researcher/Coder/Reviewer), role-based
  assignment to registered agents, goal status aggregation; with orchestrator.test.ts
  asserting count, role matching, and assignment
- Implement server/src/agents.ts + tick loop: simulated agents autonomously transition
  assigned tasks todo -> in_progress -> done/failed with seeded outcomes and realistic
  activity messages (the PRD's thought-chain stand-in), generating a Lesson on every
  completion and every failure (failures shared as pitfalls to avoid);
  lifecycle.test.ts runs a full sample goal to completion deterministically
- Implement server/src/api.ts + ws.ts + index.ts: REST endpoints POST /goals (400 on
  empty text), GET /state, GET /goals/:id, GET /agents, GET /lessons (404 for unknown
  goal), WS hub broadcasting every state mutation, boot wiring of orchestrator loop;
  api.test.ts starts the server on an ephemeral port, exercises all endpoints, and
  asserts a WS client receives task.updated events after POST /goals
- Restart persistence: lessons.test.ts boots the store, completes a task so a lesson
  is written, closes and reopens the SQLite file/server, and asserts GET /lessons
  still returns the entry

### Phase 3: Phase 3 — React real-time dashboard
**Goal:** A Vite+React dashboard that renders the kanban board, agent status panel, goal
          submission form, and lessons feed, all driven live from the backend over WebSocket
          without page refresh
**Steps:**
- Implement web/src/api.ts (REST client + WS client with reconnect/backoff) and
  web/src/store.ts (reducer store applying WsEvents: task.updated, agent.status,
  lesson.created, goal.status) with store.test.ts feeding scripted event sequences and
  asserting resulting state
- Implement kanban Board (Todo/In Progress/Done columns of task cards with role +
  activity badge) and AgentPanel (per-agent role, status, current task) rendering from
  the store, with a component render test against a seeded store
- Implement GoalForm (POSTs to /goals, disables on empty input, shows 400 errors) and
  LessonsFeed (live-appended lesson entries), wired through the store/api layer with a
  test asserting submit issues POST /goals
- Layout & styling pass: dark operator-console aesthetic, responsive grid (board |
  agents | lessons), status color coding, activity log strip per card for the
  thought-chain feel

### Phase 4: Phase 4 — End-to-end smoke & docs
**Goal:** Prove the whole loop works from a cold start and document it: boot, submit goal, watch
          tasks complete, lessons persisted
**Steps:**
- Implement scripts/smoke.mjs: boots the backend on an ephemeral port, registers
  sample agents, POSTs a goal via fetch, connects a WS client asserting live events
  arrive, polls GET /state until every task is done (timeout + fail on stuck tasks),
  then asserts GET /lessons is non-empty; exit 0 on success, non-zero otherwise
- Write README.md: what Togezer MVP is, prerequisites (Node >=22), exact run commands
  (npm install, npm run dev, npm test, node scripts/smoke.mjs), architecture sketch,
  and the deferred items (HITL, real LLM agents, gRPC, vector search)

---