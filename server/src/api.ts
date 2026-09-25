/**
 * REST API for the togezer orchestrator.
 *
 * `createApp` composes the transport-free domain code into an express
 * application: persistence (./db.js), orchestration (./orchestrator.js), and
 * an injected `emit` sink. The sink is the WebSocket hub's broadcast in
 * production — the simulation routes its own lifecycle events (task, agent,
 * lesson, goal) through the same sink via its `onEvent` option, so this
 * module only emits the `goal.status` transition that happens as a direct
 * consequence of creating a goal over HTTP (pending -> running).
 *
 * No auth and no CORS: the web dev server proxies `/api`/`/ws` in dev, and
 * the API is local-first.
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_LESSON_LIMIT,
  getGoal,
  listAgents,
  listGoals,
  listLessons,
  listTasks,
  listTasksByGoal,
} from './db.js';
import { aggregateGoalStatus, assignTasks, decomposeGoal } from './orchestrator.js';
import type { StateSnapshot, WsEvent } from './types.js';

/** Maximum accepted `?limit=` value for GET /lessons. */
const MAX_LESSON_LIMIT = 200;

/**
 * Parse the `?limit=` query parameter for GET /lessons: non-integer values
 * fall back to the database default; anything integer is clamped to 1..200.
 */
function parseLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(parsed)) return DEFAULT_LESSON_LIMIT;
  return Math.min(MAX_LESSON_LIMIT, Math.max(1, parsed));
}

export function createApp(
  db: DatabaseSync,
  emit: (event: WsEvent) => void,
): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/goals', (req: Request, res: Response) => {
    const rawText = (req.body as { text?: unknown } | undefined)?.text;
    const text = typeof rawText === 'string' ? rawText : '';
    if (text.trim().length === 0) {
      res.status(400).json({ error: 'goal text is required' });
      return;
    }
    const { goal } = decomposeGoal(db, text);
    assignTasks(db, goal.id);
    aggregateGoalStatus(db, goal.id);
    const freshGoal = getGoal(db, goal.id) ?? goal;
    emit({ type: 'goal.status', at: new Date().toISOString(), goal: freshGoal });
    res.status(201).json({ goal: freshGoal, tasks: listTasksByGoal(db, goal.id) });
  });

  app.get('/goals/:id', (req: Request, res: Response) => {
    // @types/express types repeated params as string[]; a repeated param is
    // not a goal id, so it falls through to the 404 below.
    const rawId = req.params.id;
    const goal = getGoal(db, typeof rawId === 'string' ? rawId : '');
    if (goal === null) {
      res.status(404).json({ error: 'goal not found' });
      return;
    }
    res.json({ goal, tasks: listTasksByGoal(db, goal.id) });
  });

  app.get('/agents', (_req: Request, res: Response) => {
    res.json({ agents: listAgents(db) });
  });

  app.get('/lessons', (req: Request, res: Response) => {
    res.json({ lessons: listLessons(db, parseLimit(req.query.limit)) });
  });

  app.get('/state', (_req: Request, res: Response) => {
    const snapshot: StateSnapshot = {
      agents: listAgents(db),
      goals: listGoals(db),
      tasks: listTasks(db),
      lessons: listLessons(db),
    };
    res.json(snapshot);
  });

  // JSON 404 fallback for unknown routes.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // Malformed JSON bodies surface as SyntaxError from express.json(); map
  // them to a 400 JSON error instead of the default HTML error page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    next(err);
  });

  return app;
}
