/**
 * Restart-persistence integration tests for the full togezer server stack
 * (./api.js + ./db.js + ./agents.js).
 *
 * Unlike the db-layer file-reopen test in ./db.test.ts, these boot the FULL
 * HTTP stack on a FILE-backed SQLite database, complete a goal so lessons are
 * written, tear the HTTP server and the database handle down, and reopen the
 * same file through a brand-new stack. ':memory:' is forbidden in this suite:
 * the point under test is surviving a close/reopen cycle across handles.
 *
 * Conventions follow ./api.test.ts: ephemeral port (`listen(0)` against
 * 127.0.0.1 — never a fixed port), synchronous tick() driving (the
 * simulation is never start()-ed), and full teardown
 * (closeAllConnections + server.close + closeDb) so the vitest process can
 * exit. A zero failure rate guarantees every terminal task is 'done' and
 * writes a 'Lesson from …' entry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createSimulation } from './agents.js';
import type { Simulation } from './agents.js';
import { createApp } from './api.js';
import { closeDb, createAgent, listAgents, openDb } from './db.js';
import type { Agent, Goal, Lesson, StateSnapshot, Task } from './types.js';

const GOAL_TEXT = 'launch the marketing site';
const SECOND_GOAL_TEXT = 'prototype the pricing page';
/** Tick bound for driving a goal to completion (lifecycle contract). */
const MAX_TICKS = 30;
/** The seeded team served by GET /agents and used for assignment. */
const SEEDED_TEAM: ReadonlyArray<{ name: string; role: Agent['role'] }> = [
  { name: 'Researcher Rex', role: 'researcher' },
  { name: 'Coder Ada', role: 'coder' },
  { name: 'Reviewer Ravi', role: 'reviewer' },
];

// ---------------------------------------------------------------------------
// Fixture: file-backed boot/shutdown of the whole stack, per restart.
// ---------------------------------------------------------------------------

interface BootedStack {
  db: DatabaseSync;
  sim: Simulation;
  app: Express;
  server: http.Server;
  port: number;
}

const tempDirs: string[] = [];
/** The currently-open stack, so afterEach can tear down whatever a test left. */
let openStack: BootedStack | null = null;

/** File-backed db path inside a fresh mkdtemp dir (never ':memory:'). */
function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'togezer-lessons-'));
  tempDirs.push(dir);
  return join(dir, 'togezer-test.db');
}

/**
 * Boot the full stack (db + sim + app + http server) on a file path.
 * The default three-agent team is seeded ONLY when the store is empty, so
 * reopening an existing database never duplicates agents. No WebSocket hub
 * is attached: ./api.test.ts already covers the WS layer.
 */
async function bootStack(dbPath: string): Promise<BootedStack> {
  const db = openDb(dbPath);
  if (listAgents(db).length === 0) {
    for (const agent of SEEDED_TEAM) createAgent(db, agent);
  }

  const sim = createSimulation(db, { seed: 42, failureRate: 0 });
  const app = createApp(db, () => {});
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  const stack: BootedStack = { db, sim, app, server, port: address.port };
  openStack = stack;
  return stack;
}

/** Full teardown in the api.test.ts order; idempotent via openStack. */
async function shutdownStack(stack: BootedStack): Promise<void> {
  // undici (global fetch) keeps idle keep-alive sockets open; destroy them
  // so server.close() can complete and the database file can be released.
  stack.server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    stack.server.close(() => resolve());
  });
  closeDb(stack.db);
  if (openStack === stack) openStack = null;
}

afterEach(async () => {
  if (openStack !== null) await shutdownStack(openStack);
  while (tempDirs.length > 0) {
    // Unlinks the temp dir and the db file inside it.
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  body: unknown;
}

async function request(
  base: string,
  method: string,
  path: string,
  jsonBody?: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: jsonBody === undefined ? undefined : { 'content-type': 'application/json' },
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  });
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

function baseOf(stack: BootedStack): string {
  return `http://127.0.0.1:${stack.port}`;
}

async function getState(base: string): Promise<StateSnapshot> {
  const res = await request(base, 'GET', '/state');
  expect(res.status).toBe(200);
  return res.body as StateSnapshot;
}

/**
 * Drive the simulation synchronously until the goal reads 'done' over
 * GET /state; fails fast (with the last observed status) as soon as the
 * tick bound is exceeded instead of looping forever.
 */
async function driveGoalToDone(stack: BootedStack, goalId: string): Promise<void> {
  const base = baseOf(stack);
  let lastStatus = 'missing';
  for (let ticks = 0; ticks < MAX_TICKS; ticks += 1) {
    const goal = (await getState(base)).goals.find((candidate) => candidate.id === goalId);
    if (goal !== undefined) lastStatus = goal.status;
    if (goal?.status === 'done') return;
    stack.sim.tick();
  }
  throw new Error(`goal ${goalId} still '${lastStatus}' after ${MAX_TICKS} ticks (expected 'done')`);
}

/** Create a goal over HTTP (asserting 201 + 4 tasks) and drive it to 'done'. */
async function runGoalToDone(stack: BootedStack, text: string): Promise<Goal> {
  const res = await request(baseOf(stack), 'POST', '/goals', { text });
  expect(res.status).toBe(201);
  const { goal, tasks } = res.body as { goal: Goal; tasks: Task[] };
  expect(tasks).toHaveLength(4);
  await driveGoalToDone(stack, goal.id);
  return goal;
}

/** Deterministic order for comparing lesson lists across restarts. */
function byId(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('restart persistence (file-backed SQLite + full HTTP stack)', () => {
  it('lessons survive a full server/store restart', async () => {
    const dbPath = makeTempDbPath();

    // (1) Boot, complete a goal over the API, capture the lessons.
    const first = await bootStack(dbPath);
    const goal = await runGoalToDone(first, GOAL_TEXT);

    const firstRes = await request(baseOf(first), 'GET', '/lessons');
    expect(firstRes.status).toBe(200);
    const lessons = (firstRes.body as { lessons: Lesson[] }).lessons;
    expect(lessons).toHaveLength(4);
    for (const lesson of lessons) {
      expect(lesson.content.startsWith('Lesson from')).toBe(true);
      expect(lesson.sourceTaskId).not.toBe('');
    }
    const captured = byId(lessons);

    // (2) Full shutdown: HTTP server (and its sockets), then the database.
    await shutdownStack(first);

    // (3) Boot a brand-new stack on the SAME file. The seed guard must not
    // duplicate the team on the populated database.
    const second = await bootStack(dbPath);
    const agentsRes = await request(baseOf(second), 'GET', '/agents');
    expect(agentsRes.status).toBe(200);
    const agents = (agentsRes.body as { agents: Agent[] }).agents;
    expect(agents).toHaveLength(3);
    expect(agents.map((agent) => [agent.name, agent.role])).toEqual(
      SEEDED_TEAM.map((agent) => [agent.name, agent.role]),
    );

    // (4) The lessons come back identical: same ids and contents, and the
    // hydrated objects match the pre-restart capture field by field.
    const restartedRes = await request(baseOf(second), 'GET', '/lessons');
    expect(restartedRes.status).toBe(200);
    const restarted = (restartedRes.body as { lessons: Lesson[] }).lessons;
    expect(restarted).toHaveLength(4);
    expect(byId(restarted)).toEqual(captured);
    const capturedById = new Map(captured.map((lesson) => [lesson.id, lesson]));
    for (const lesson of restarted) {
      const before = capturedById.get(lesson.id);
      expect(before).toBeDefined();
      expect(lesson.content).toBe(before?.content);
      expect(lesson.sourceTaskId).toBe(before?.sourceTaskId);
      expect(lesson.createdAt).toBe(before?.createdAt);
    }

    // (5) Persistence reaches beyond lessons: the restarted state snapshot
    // still shows the done goal and its 4 done tasks.
    const snapshot = await getState(baseOf(second));
    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]?.id).toBe(goal.id);
    expect(snapshot.goals[0]?.status).toBe('done');
    expect(snapshot.tasks).toHaveLength(4);
    expect(snapshot.tasks.every((task) => task.goalId === goal.id)).toBe(true);
    expect(snapshot.tasks.every((task) => task.status === 'done')).toBe(true);
  });

  it('restarted server continues autonomous work on the same database', async () => {
    const dbPath = makeTempDbPath();

    // First lifetime: one goal to 'done' writes 4 lessons, then a restart.
    const first = await bootStack(dbPath);
    const firstGoal = await runGoalToDone(first, GOAL_TEXT);
    const preRes = await request(baseOf(first), 'GET', '/lessons');
    expect(preRes.status).toBe(200);
    const pre = (preRes.body as { lessons: Lesson[] }).lessons;
    expect(pre).toHaveLength(4);
    await shutdownStack(first);

    // Second lifetime on the same file: the restarted server seeds no
    // duplicate agents, accepts new work, and keeps the simulation running.
    const second = await bootStack(dbPath);
    const agentsRes = await request(baseOf(second), 'GET', '/agents');
    expect(agentsRes.status).toBe(200);
    expect((agentsRes.body as { agents: Agent[] }).agents).toHaveLength(3);

    const secondGoal = await runGoalToDone(second, SECOND_GOAL_TEXT);

    const finalRes = await request(baseOf(second), 'GET', '/lessons');
    expect(finalRes.status).toBe(200);
    const final = (finalRes.body as { lessons: Lesson[] }).lessons;
    expect(final).toHaveLength(8);

    // The four pre-restart lessons are still there, unchanged.
    const finalById = new Map(final.map((lesson) => [lesson.id, lesson]));
    for (const old of pre) {
      expect(finalById.get(old.id)).toEqual(old);
    }

    // The four new lessons reference the new goal's tasks.
    const state = await getState(baseOf(second));
    const secondTaskIds = new Set(
      state.tasks.filter((task) => task.goalId === secondGoal.id).map((task) => task.id),
    );
    expect(secondTaskIds.size).toBe(4);
    const newLessons = final.filter((lesson) => !pre.some((old) => old.id === lesson.id));
    expect(newLessons).toHaveLength(4);
    for (const lesson of newLessons) {
      expect(lesson.content.startsWith('Lesson from')).toBe(true);
      expect(secondTaskIds.has(lesson.sourceTaskId)).toBe(true);
    }

    // Both goals are terminal in the snapshot: the pre-restart goal is
    // untouched, the post-restart goal was driven to 'done' after the boot.
    const goalById = new Map(state.goals.map((candidate) => [candidate.id, candidate]));
    expect(goalById.get(firstGoal.id)?.status).toBe('done');
    expect(goalById.get(secondGoal.id)?.status).toBe('done');
    expect(state.tasks.every((task) => task.status === 'done')).toBe(true);
  });
});
