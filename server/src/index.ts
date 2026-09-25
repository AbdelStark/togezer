/**
 * Production boot for the togezer server.
 *
 * Wiring (all synchronous):
 *   1. open the SQLite database — env TOGEZER_DB, or server/data/togezer.db
 *      under the server package (its parent directory is created on demand);
 *   2. seed the default three-agent team when the database is fresh;
 *   3. create the simulation — its `onEvent` and the app's `emit` are
 *      late-bound to the hub's broadcast, because the hub needs the HTTP
 *      server and the server needs the express app;
 *   4. create the express app, wrap it in an http.Server, attach the WS hub;
 *   5. listen, then start the simulation tick loop.
 *
 * SIGINT/SIGTERM stop the simulation, tear down hub/server/db and exit 0.
 */

import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulation } from './agents.js';
import { createApp } from './api.js';
import { closeDb, createAgent, listAgents, openDb } from './db.js';
import type { WsEvent } from './types.js';
import { createWsHub } from './ws.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = resolve(here, '../data/togezer.db');
const dbPath = process.env.TOGEZER_DB || defaultDbPath;

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

if (listAgents(db).length === 0) {
  createAgent(db, { name: 'Researcher Rex', role: 'researcher' });
  createAgent(db, { name: 'Coder Ada', role: 'coder' });
  createAgent(db, { name: 'Reviewer Ravi', role: 'reviewer' });
}

// Late-bound event sink: becomes hub.broadcast once the hub exists below.
let emit: (event: WsEvent) => void = () => {};

const sim = createSimulation(db, {
  seed: Number(process.env.TOGEZER_SEED ?? 42),
  onEvent: (event) => emit(event),
});

const app = createApp(db, (event) => emit(event));
const server = http.createServer(app);
const hub = createWsHub(server);
emit = hub.broadcast;

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => {
  console.log(`togezer server listening on http://localhost:${port}`);
});

const stopSimulation = sim.start(Number(process.env.TOGEZER_TICK_MS ?? 600));

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSimulation();
  hub.close();
  server.close();
  closeDb(db);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
