/**
 * Integration tests for the togezer HTTP + WebSocket API (./api.js + ./ws.js).
 *
 * A single fixture boots the full server stack on an ephemeral port
 * (`listen(0)` against 127.0.0.1 — never a fixed port): an in-memory
 * database with the default three-agent team, an express app, a WebSocket
 * hub, and a seed-42 simulation. The simulation is never start()-ed; every
 * test drives tick() synchronously (the WS test pumps ticks inside a
 * timeout-guarded wait loop) so all state transitions are deterministic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createSimulation } from './agents.js';
import type { Simulation } from './agents.js';
import { createApp } from './api.js';
import {
  closeDb,
  createAgent,
  listAgents,
  listLessons,
  listTasks,
  openDb,
} from './db.js';
import { createWsHub } from './ws.js';
import type { WsHub } from './ws.js';
import type { Agent, Goal, Lesson, StateSnapshot, Task, WsEvent } from './types.js';

const GOAL_TEXT = 'launch the marketing site';
const SECOND_GOAL_TEXT = 'ship the onboarding flow';
/** Tick bound for driving the simulation to completion (lifecycle contract). */
const MAX_TICKS = 30;
/** Timeout for the WS event wait loop. */
const EVENT_TIMEOUT_MS = 5000;
/** The seeded team served by GET /agents and used for assignment. */
const SEEDED_TEAM: ReadonlyArray<{ name: string; role: Agent['role'] }> = [
  { name: 'Researcher Rex', role: 'researcher' },
  { name: 'Coder Ada', role: 'coder' },
  { name: 'Reviewer Ravi', role: 'reviewer' },
];

// ---------------------------------------------------------------------------
// Fixture: one ephemeral server for the whole file.
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let server: http.Server;
let hub: WsHub;
let sim: Simulation;
let base: string;
let goalId: string;

beforeAll(async () => {
  db = openDb(':memory:');
  for (const agent of SEEDED_TEAM) createAgent(db, agent);

  // The hub needs the http server, the server needs the app, and both the
  // app and the simulation need the hub's broadcast — late-bind the sink.
  let emit: (event: WsEvent) => void = () => {};
  sim = createSimulation(db, { seed: 42, onEvent: (event) => emit(event) });
  const app = createApp(db, (event) => emit(event));
  server = http.createServer(app);
  hub = createWsHub(server);
  emit = hub.broadcast;

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${serverPort(server)}`;
});

afterAll(async () => {
  hub.close();
  // undici (global fetch) keeps idle keep-alive sockets open; destroy them
  // so server.close() can complete and the test process can exit.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb(db);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  body: unknown;
}

async function request(method: string, path: string, jsonBody?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: jsonBody === undefined ? undefined : { 'content-type': 'application/json' },
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  });
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

function allTasksTerminal(): boolean {
  return listTasks(db).every((task) => task.status === 'done' || task.status === 'failed');
}

/** Resolve the ephemeral port the fixture server is listening on. */
function serverPort(srv: http.Server): number {
  const address = srv.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return address.port;
}

/** Drive the simulation synchronously until every task is terminal. */
function driveToTerminal(maxTicks: number = MAX_TICKS): void {
  for (let i = 0; i < maxTicks && !allTasksTerminal(); i += 1) {
    sim.tick();
  }
}

function goalTasks(snapshot: StateSnapshot, id: string): Task[] {
  return snapshot.tasks.filter((task) => task.goalId === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('api + ws integration', () => {
  it('answers GET /health with {ok:true}', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects POST /goals with missing text: 400 and exact error text', async () => {
    const res = await request('POST', '/goals', {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'goal text is required' });
  });

  it('rejects POST /goals with whitespace-only text: 400', async () => {
    const res = await request('POST', '/goals', { text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'goal text is required' });
  });

  it('rejects a malformed JSON body with a 400 JSON error', async () => {
    const response = await fetch(`${base}/goals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('decomposes and assigns a goal over POST /goals: 4 role-matched assigned tasks', async () => {
    const res = await request('POST', '/goals', { text: GOAL_TEXT });
    expect(res.status).toBe(201);
    const { goal, tasks } = res.body as { goal: Goal; tasks: Task[] };

    expect(typeof goal.id).toBe('string');
    expect(goal.text).toBe(GOAL_TEXT);
    expect(goal.status).toBe('running');
    expect(tasks).toHaveLength(4);

    const agentsById = new Map(listAgents(db).map((agent) => [agent.id, agent]));
    for (const task of tasks) {
      expect(['researcher', 'coder', 'reviewer']).toContain(task.role);
      expect(task.assigneeId).not.toBeNull();
      expect(agentsById.get(task.assigneeId as string)?.role).toBe(task.role);
    }
    goalId = goal.id;
  });

  it('serves a goal with its tasks (GET /goals/:id) and 404s unknown ids', async () => {
    const ok = await request('GET', `/goals/${goalId}`);
    expect(ok.status).toBe(200);
    const { goal, tasks } = ok.body as { goal: Goal; tasks: Task[] };
    expect(goal.id).toBe(goalId);
    expect(goal.text).toBe(GOAL_TEXT);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((task) => task.goalId === goalId)).toBe(true);

    const missing = await request('GET', '/goals/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'goal not found' });
  });

  it('lists exactly the three seeded agents (GET /agents)', async () => {
    const res = await request('GET', '/agents');
    expect(res.status).toBe(200);
    const { agents } = res.body as { agents: Agent[] };
    expect(agents.map((agent) => [agent.name, agent.role])).toEqual(
      SEEDED_TEAM.map((agent) => [agent.name, agent.role]),
    );
  });

  it('serves no lessons before any task ran, then lessons after completion (GET /lessons)', async () => {
    const empty = await request('GET', '/lessons');
    expect(empty.status).toBe(200);
    expect((empty.body as { lessons: Lesson[] }).lessons).toEqual([]);

    driveToTerminal();

    const after = await request('GET', '/lessons');
    expect(after.status).toBe(200);
    const { lessons } = after.body as { lessons: Lesson[] };
    expect(lessons.length).toBeGreaterThan(0);
    for (const lesson of lessons) {
      expect(
        lesson.content.startsWith('Lesson from') || lesson.content.startsWith('Pitfall from'),
      ).toBe(true);
      expect(typeof lesson.sourceTaskId).toBe('string');
    }
  });

  it('honors and clamps the ?limit query (GET /lessons)', async () => {
    const clamped = await request('GET', '/lessons?limit=2');
    expect(clamped.status).toBe(200);
    expect((clamped.body as { lessons: Lesson[] }).lessons).toHaveLength(2);

    const floor = await request('GET', '/lessons?limit=0');
    expect((floor.body as { lessons: Lesson[] }).lessons).toHaveLength(1);

    const ceiling = await request('GET', '/lessons?limit=500');
    expect((ceiling.body as { lessons: Lesson[] }).lessons).toHaveLength(
      listLessons(db, 200).length,
    );
  });

  it('serves the full snapshot with the goal complete (GET /state)', async () => {
    driveToTerminal(); // no-op when already terminal

    const res = await request('GET', '/state');
    expect(res.status).toBe(200);
    const snapshot = res.body as StateSnapshot;
    expect(Array.isArray(snapshot.agents)).toBe(true);
    expect(Array.isArray(snapshot.goals)).toBe(true);
    expect(Array.isArray(snapshot.tasks)).toBe(true);
    expect(Array.isArray(snapshot.lessons)).toBe(true);
    expect(snapshot.agents).toHaveLength(3);
    expect(snapshot.goals).toHaveLength(1);
    expect(goalTasks(snapshot, goalId)).toHaveLength(4);
    expect(snapshot.lessons.length).toBeGreaterThan(0);
    expect(snapshot.goals[0]?.id).toBe(goalId);
    expect(snapshot.goals[0]?.status).toBe('done');
  });

  it('broadcasts task.updated events to a WS client after POST /goals', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${serverPort(server)}/ws`);
    const received: WsEvent[] = [];
    client.on('message', (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString()) as WsEvent);
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    const res = await request('POST', '/goals', { text: SECOND_GOAL_TEXT });
    expect(res.status).toBe(201);
    const { goal: secondGoal } = res.body as { goal: Goal; tasks: Task[] };

    // Drive the simulation synchronously until the client sees a
    // task.updated event (timeout-guarded wait loop).
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    for (;;) {
      if (received.some((event) => event.type === 'task.updated')) break;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${EVENT_TIMEOUT_MS}ms waiting for a task.updated event`);
      }
      sim.tick();
      // Give the event loop a turn so the hub can deliver buffered messages.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }

    // POST /goals emits the goal.status 'running' transition.
    const goalEvents = received.filter(
      (event): event is Extract<WsEvent, { type: 'goal.status' }> => event.type === 'goal.status',
    );
    expect(
      goalEvents.some((event) => event.goal.id === secondGoal.id && event.goal.status === 'running'),
    ).toBe(true);

    // At least one task.updated with a well-formed task payload, and every
    // streamed task belongs to the just-created goal.
    const updates = received.filter(
      (event): event is Extract<WsEvent, { type: 'task.updated' }> => event.type === 'task.updated',
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const event of updates) {
      const { task } = event;
      expect(typeof task.id).toBe('string');
      expect(task.goalId).toBe(secondGoal.id);
      expect(typeof task.title).toBe('string');
      expect(['todo', 'in_progress', 'done', 'failed']).toContain(task.status);
      expect(Array.isArray(task.activity)).toBe(true);
    }

    client.close();
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve());
    });
  });

  it('404s unknown routes with a JSON body', async () => {
    const res = await request('GET', '/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
