#!/usr/bin/env node
/**
 * End-to-end smoke test for the togezer backend.
 *
 * Single command from the repo root (no flags, no build step):
 *
 *   node scripts/smoke.mjs
 *
 * What it does:
 *   1. Registers the tsx ESM loader so the TypeScript server sources can be
 *      imported directly by plain Node (server code ships as .ts only).
 *   2. Boots the full backend composition by hand — temp SQLite database in
 *      os.tmpdir(), the same seed-if-empty three-agent team as production
 *      (server/src/index.ts), express app + http.Server + WS hub — and binds
 *      to an ephemeral port, reading the ACTUAL bound port back from
 *      server.address().
 *   3. Exercises the loop: POST /goals, live WebSocket event collection,
 *      GET /state polling until every task is terminal, GET /lessons.
 *   4. Tears everything down (simulation, WS clients, http server, db, temp
 *      dir — undici keep-alive sockets are force-closed via
 *      closeAllConnections) and prints a short PASS transcript.
 *
 * Exit codes: 0 on success, 1 on boot/assertion failure, 2 when tasks are
 * stuck non-terminal when the 20s poll timeout expires. SIGINT/SIGTERM run
 * the same best-effort cleanup.
 *
 * Node >= 22 required (node:sqlite; engines already pin >= 22).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { register } from 'tsx/esm/api';
import { WebSocket } from 'ws';

// Global fetch (undici-backed) is a Node runtime global, not an ES built-in,
// so bind it explicitly — plain .mjs gets no Node globals from the linter.
const { fetch } = globalThis;

// --- Bootstrap TypeScript support -------------------------------------------
// tsx is a devDependency of the server workspace (hoisted to the root
// node_modules). Registering its ESM loader lets every subsequent dynamic
// import resolve .ts files — including the './db.js' style specifiers used
// inside the server sources, which tsx rewrites to the .ts files.
//
// tsx 4.x REJECTS the raw `node:module.register('tsx/esm', ...)` form ("tsx
// must be loaded with --import instead of --loader"), so we go through its
// own programmatic API (`tsx/esm/api`), which wraps node:module.register with
// the correct initialization. The returned unregister fn is torn down below.
const unregisterTsx = register();

const { createSimulation } = await import('../server/src/agents.ts');
const { createApp } = await import('../server/src/api.ts');
const { closeDb, createAgent, listAgents, openDb } = await import('../server/src/db.ts');
const { createWsHub } = await import('../server/src/ws.ts');

const GOAL_TEXT = 'launch the marketing site';
const TICK_MS = 25; // fast, still deterministic (seed fixed below)
const SEED = 42;
const POLL_INTERVAL_MS = 100;
const STATE_TIMEOUT_MS = 20_000;
const WS_SETTLE_MS = 150; // grace for in-flight WS frames after terminal state

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed']);
const AGENT_ROLES = new Set(['researcher', 'coder', 'reviewer']);

// --- Cleanup state -----------------------------------------------------------
/** Everything best-effort-cleanable; populated as resources come up. */
const cleanup = {
  tempDir: null,
  stopSim: null,
  server: null,
  hub: null,
  ws: null,
  db: null,
  unregisterTsx,
};
let exiting = false;

function fail(code, message) {
  if (exiting) return;
  exiting = true;
  console.error(`SMOKE FAIL (${code}): ${message}`);
  teardown();
  process.exit(code);
}

function teardown() {
  try {
    cleanup.stopSim?.();
  } catch { /* best effort */ }
  try {
    cleanup.unregisterTsx?.();
  } catch { /* best effort */ }
  try {
    cleanup.ws?.close();
  } catch { /* best effort */ }
  try {
    cleanup.hub?.close();
  } catch { /* best effort */ }
  try {
    // Undici's keep-alive sockets would keep server.close() pending forever;
    // force-close every connection before closing the listener.
    cleanup.server?.closeAllConnections();
    cleanup.server?.close();
  } catch { /* best effort */ }
  try {
    if (cleanup.db) closeDb(cleanup.db);
  } catch { /* best effort */ }
  try {
    if (cleanup.tempDir !== null) rmSync(cleanup.tempDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

process.on('SIGINT', () => {
  console.error('SMOKE FAIL: interrupted (SIGINT)');
  teardown();
  process.exit(1);
});
process.on('SIGTERM', () => {
  console.error('SMOKE FAIL: terminated (SIGTERM)');
  teardown();
  process.exit(1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onceWithTimeout(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
    emitter.once(event, (arg) => {
      clearTimeout(timer);
      resolve(arg);
    });
    emitter.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Boot the backend composition (mirrors server/src/index.ts) --------------
async function boot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'togezer-smoke-'));
  cleanup.tempDir = tempDir;
  const db = openDb(join(tempDir, 'togezer.db'));
  cleanup.db = db;

  // Seed the default three-agent team when the database is fresh — identical
  // to production boot.
  if (listAgents(db).length === 0) {
    createAgent(db, { name: 'Researcher Rex', role: 'researcher' });
    createAgent(db, { name: 'Coder Ada', role: 'coder' });
    createAgent(db, { name: 'Reviewer Ravi', role: 'reviewer' });
  }
  const agents = listAgents(db);
  if (agents.length !== 3 || new Set(agents.map((a) => a.role)).size !== 3) {
    throw new Error(`expected 3 agents with distinct roles, got ${JSON.stringify(agents)}`);
  }

  // Late-bound event sink: becomes hub.broadcast once the hub exists.
  let emit = () => {};
  const sim = createSimulation(db, { seed: SEED, onEvent: (event) => emit(event) });
  const app = createApp(db, (event) => emit(event));
  const server = http.createServer(app);
  const hub = createWsHub(server);
  emit = hub.broadcast;
  cleanup.server = server;
  cleanup.hub = hub;

  // Bind to an ephemeral port and read the ACTUAL bound port back.
  server.listen(0, '127.0.0.1');
  await onceWithTimeout(server, 'listening', 5000, 'the server to listen');
  const port = server.address().port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`failed to read bound port from server.address(): ${JSON.stringify(server.address())}`);
  }

  cleanup.stopSim = sim.start(TICK_MS);
  return { db, port };
}

// --- Exercise the loop ---------------------------------------------------------
async function run() {
  const { port } = await boot();
  const base = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();

  // Collect live WebSocket events from connect until teardown.
  const seenEventTypes = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanup.ws = ws;
  ws.on('message', (data) => {
    try {
      seenEventTypes.add(JSON.parse(String(data)).type);
    } catch { /* ignore malformed frames — assertions below catch gaps */ }
  });
  await onceWithTimeout(ws, 'open', 5000, 'the WebSocket to open');

  // POST the goal.
  const postRes = await fetch(`${base}/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: GOAL_TEXT }),
  });
  if (postRes.status !== 201) {
    throw new Error(`POST /goals expected 201, got ${postRes.status}: ${await postRes.text()}`);
  }
  const postBody = await postRes.json();
  const goalId = postBody.goal?.id;
  const postedTasks = postBody.tasks ?? [];
  if (typeof goalId !== 'string' || goalId.length === 0) {
    throw new Error(`POST /goals returned no goal id: ${JSON.stringify(postBody)}`);
  }
  if (postedTasks.length < 3) {
    throw new Error(`POST /goals returned ${postedTasks.length} tasks, expected >= 3`);
  }
  for (const task of postedTasks) {
    if (!AGENT_ROLES.has(task.role)) {
      throw new Error(`task "${task.title}" has role "${task.role}", which no agent covers`);
    }
  }
  const postedRoleCounts = {};
  for (const task of postedTasks) postedRoleCounts[task.role] = (postedRoleCounts[task.role] ?? 0) + 1;
  console.log(`goal ${goalId} created: ${postedTasks.length} tasks ${JSON.stringify(postedRoleCounts)}`);

  // Poll GET /state until every task is terminal, or fail distinctly.
  let snapshot;
  const pollDeadline = Date.now() + STATE_TIMEOUT_MS;
  for (;;) {
    const stateRes = await fetch(`${base}/state`);
    if (stateRes.status !== 200) {
      throw new Error(`GET /state expected 200, got ${stateRes.status}`);
    }
    snapshot = await stateRes.json();
    const tasks = snapshot.tasks ?? [];
    if (tasks.length < postedTasks.length) {
      throw new Error(`GET /state returned ${tasks.length} tasks, expected >= ${postedTasks.length}`);
    }
    const stuck = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(task.status));
    if (stuck.length === 0) break;
    if (Date.now() > pollDeadline) {
      const stuckReport = stuck
        .map((task) => `${task.id} (${task.role}, "${task.title}") -> ${task.status}`)
        .join('; ');
      fail(2, `stuck tasks after ${STATE_TIMEOUT_MS}ms: ${stuckReport}`);
      return; // unreachable (fail exits) — keeps the linter happy about flow
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Give in-flight WS frames a beat to land, then assert live-event proof.
  await sleep(WS_SETTLE_MS);
  for (const required of ['task.updated', 'lesson.created']) {
    if (!seenEventTypes.has(required)) {
      throw new Error(`no live "${required}" WebSocket event arrived (saw: ${[...seenEventTypes].join(', ') || 'none'})`);
    }
  }

  // Every terminal transition produced a lesson; GET /lessons must show them.
  const lessonsRes = await fetch(`${base}/lessons`);
  if (lessonsRes.status !== 200) {
    throw new Error(`GET /lessons expected 200, got ${lessonsRes.status}`);
  }
  const lessons = (await lessonsRes.json()).lessons ?? [];
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('GET /lessons returned an empty lesson list');
  }
  for (const lesson of lessons) {
    if (typeof lesson.content !== 'string' || lesson.content.trim().length === 0) {
      throw new Error(`lesson ${lesson.id} has empty content`);
    }
  }

  const terminalCount = snapshot.tasks.length;
  const goalStatus = (snapshot.goals ?? []).find((goal) => goal.id === goalId)?.status ?? 'unknown';
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `SMOKE PASS: goal ${goalStatus}, ${terminalCount} tasks terminal, ${lessons.length} lessons persisted ` +
      `(${seenEventTypes.size} live event types: ${[...seenEventTypes].sort().join(', ')}; ${elapsedMs}ms)`,
  );
}

try {
  await run();
  teardown();
  process.exit(0);
} catch (error) {
  fail(1, error instanceof Error ? error.stack : String(error));
}
