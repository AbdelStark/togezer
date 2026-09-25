/**
 * SQLite persistence layer for the togezer orchestrator.
 *
 * Data-access factory pattern: every function takes the live `DatabaseSync`
 * handle as its first argument, so tests run against ':memory:' databases and
 * production opens a file via {@link openDb}. Row objects map 1:1 onto the
 * domain contract in ./types.js — schema column names ARE the domain field
 * names (camelCase), so the only mapping work is narrowing TEXT status/role
 * columns to their domain unions and JSON-encoding/decoding `tasks.activity`.
 *
 * Every statement is a prepared statement with positional `?` placeholders
 * bound at execution time; user-supplied values are never interpolated into
 * SQL text. All timestamps are ISO 8601 strings (`new Date().toISOString()`)
 * and IDs default to `crypto.randomUUID()`, injectable for deterministic
 * tests.
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Agent,
  AgentRole,
  AgentStatus,
  Goal,
  GoalStatus,
  Lesson,
  Task,
  TaskStatus,
} from './types.js';

/** Status of a freshly created goal. */
const INITIAL_GOAL_STATUS: GoalStatus = 'pending';
/** Status of a freshly created agent. */
const INITIAL_AGENT_STATUS: AgentStatus = 'idle';
/** Status of a freshly created task. */
const INITIAL_TASK_STATUS: TaskStatus = 'todo';

/** Default number of lessons returned by {@link listLessons}. */
export const DEFAULT_LESSON_LIMIT = 50;

const GOAL_COLUMNS = 'id, text, status, createdAt';
const AGENT_COLUMNS = 'id, name, role, status, currentTaskId';
const TASK_COLUMNS = 'id, goalId, title, role, status, assigneeId, result, activity';
const LESSON_COLUMNS = 'id, content, sourceTaskId, createdAt';

/**
 * Idempotent DDL for every table; safe to re-run on every open (and on every
 * subsequent open of the same file, where `IF NOT EXISTS` makes it a no-op).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  currentTaskId TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goalId TEXT NOT NULL REFERENCES goals(id),
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  assigneeId TEXT,
  result TEXT,
  activity TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  sourceTaskId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`;

export interface CreateGoalOptions {
  /** Primary key; defaults to a fresh `crypto.randomUUID()`. */
  id?: string;
  text: string;
}

export interface CreateAgentOptions {
  id?: string;
  name: string;
  role: AgentRole;
}

export interface CreateTaskOptions {
  id?: string;
  goalId: string;
  title: string;
  role: AgentRole;
}

export interface CreateLessonOptions {
  id?: string;
  content: string;
  sourceTaskId: string;
}

/**
 * Raw SELECT shapes. Declared as type aliases (not interfaces) so they keep
 * implicit index signatures, which makes the narrowing casts from the
 * `Record<string, SQLOutputValue>` rows returned by node:sqlite legal.
 */
type GoalRow = {
  id: string;
  text: string;
  status: string;
  createdAt: string;
};

type AgentRow = {
  id: string;
  name: string;
  role: string;
  status: string;
  currentTaskId: string | null;
};

type TaskRow = {
  id: string;
  goalId: string;
  title: string;
  role: string;
  status: string;
  assigneeId: string | null;
  result: string | null;
  /** JSON-encoded array of activity strings. */
  activity: string;
};

type LessonRow = {
  id: string;
  content: string;
  sourceTaskId: string;
  createdAt: string;
};

function toGoal(row: GoalRow): Goal {
  return { ...row, status: row.status as GoalStatus };
}

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    role: row.role as AgentRole,
    status: row.status as AgentStatus,
  };
}

function toTask(row: TaskRow): Task {
  return {
    ...row,
    role: row.role as AgentRole,
    status: row.status as TaskStatus,
    activity: parseActivity(row.activity),
  };
}

function toLesson(row: LessonRow): Lesson {
  return { ...row };
}

/** Decode the `tasks.activity` JSON column back into a string array. */
function parseActivity(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/** Open a database (file path or ':memory:'), apply the schema idempotently. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Convenience close wrapper. */
export function closeDb(db: DatabaseSync): void {
  db.close();
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export function createGoal(db: DatabaseSync, options: CreateGoalOptions): Goal {
  const goal: Goal = {
    id: options.id ?? randomUUID(),
    text: options.text,
    status: INITIAL_GOAL_STATUS,
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO goals (id, text, status, createdAt) VALUES (?, ?, ?, ?)').run(
    goal.id,
    goal.text,
    goal.status,
    goal.createdAt,
  );
  return goal;
}

export function getGoal(db: DatabaseSync, id: string): Goal | null {
  const row = db
    .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`)
    .get(id) as GoalRow | undefined;
  return row === undefined ? null : toGoal(row);
}

export function listGoals(db: DatabaseSync): Goal[] {
  const rows = db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals ORDER BY rowid`).all() as GoalRow[];
  return rows.map(toGoal);
}

export function updateGoalStatus(db: DatabaseSync, id: string, status: GoalStatus): void {
  db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, id);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function createAgent(db: DatabaseSync, options: CreateAgentOptions): Agent {
  const agent: Agent = {
    id: options.id ?? randomUUID(),
    name: options.name,
    role: options.role,
    status: INITIAL_AGENT_STATUS,
    currentTaskId: null,
  };
  db.prepare('INSERT INTO agents (id, name, role, status, currentTaskId) VALUES (?, ?, ?, ?, ?)').run(
    agent.id,
    agent.name,
    agent.role,
    agent.status,
    agent.currentTaskId,
  );
  return agent;
}

export function getAgent(db: DatabaseSync, id: string): Agent | null {
  const row = db
    .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  return row === undefined ? null : toAgent(row);
}

export function listAgents(db: DatabaseSync): Agent[] {
  const rows = db.prepare(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY rowid`).all() as AgentRow[];
  return rows.map(toAgent);
}

export function updateAgentStatus(
  db: DatabaseSync,
  id: string,
  status: AgentStatus,
  currentTaskId: string | null,
): void {
  db.prepare('UPDATE agents SET status = ?, currentTaskId = ? WHERE id = ?').run(
    status,
    currentTaskId,
    id,
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function createTask(db: DatabaseSync, options: CreateTaskOptions): Task {
  const task: Task = {
    id: options.id ?? randomUUID(),
    goalId: options.goalId,
    title: options.title,
    role: options.role,
    status: INITIAL_TASK_STATUS,
    assigneeId: null,
    result: null,
    activity: [],
  };
  db.prepare(
    'INSERT INTO tasks (id, goalId, title, role, status, assigneeId, result, activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    task.id,
    task.goalId,
    task.title,
    task.role,
    task.status,
    task.assigneeId,
    task.result,
    JSON.stringify(task.activity),
  );
  return task;
}

export function getTask(db: DatabaseSync, id: string): Task | null {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .get(id) as TaskRow | undefined;
  return row === undefined ? null : toTask(row);
}

export function listTasks(db: DatabaseSync): Task[] {
  const rows = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY rowid`).all() as TaskRow[];
  return rows.map(toTask);
}

export function listTasksByGoal(db: DatabaseSync, goalId: string): Task[] {
  const rows = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE goalId = ? ORDER BY rowid`)
    .all(goalId) as TaskRow[];
  return rows.map(toTask);
}

export function assignTask(db: DatabaseSync, taskId: string, agentId: string): void {
  db.prepare('UPDATE tasks SET assigneeId = ? WHERE id = ?').run(agentId, taskId);
}

/**
 * Update a task's status. When `result` is `undefined` the stored result is
 * left unchanged; pass `null` explicitly to clear it.
 */
export function updateTaskStatus(
  db: DatabaseSync,
  taskId: string,
  status: TaskStatus,
  result?: string | null,
): void {
  if (result === undefined) {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  } else {
    db.prepare('UPDATE tasks SET status = ?, result = ? WHERE id = ?').run(status, result, taskId);
  }
}

/** Append a message to the task's activity log (read JSON, push, write back). */
export function appendTaskActivity(db: DatabaseSync, taskId: string, message: string): void {
  const row = db
    .prepare('SELECT activity FROM tasks WHERE id = ?')
    .get(taskId) as { activity: string } | undefined;
  if (row === undefined) return;
  const activity = parseActivity(row.activity);
  activity.push(message);
  db.prepare('UPDATE tasks SET activity = ? WHERE id = ?').run(JSON.stringify(activity), taskId);
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export function createLesson(db: DatabaseSync, options: CreateLessonOptions): Lesson {
  const lesson: Lesson = {
    id: options.id ?? randomUUID(),
    content: options.content,
    sourceTaskId: options.sourceTaskId,
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO lessons (id, content, sourceTaskId, createdAt) VALUES (?, ?, ?, ?)').run(
    lesson.id,
    lesson.content,
    lesson.sourceTaskId,
    lesson.createdAt,
  );
  return lesson;
}

/** Newest first; `rowid DESC` breaks ties between same-timestamp inserts. */
export function listLessons(db: DatabaseSync, limit: number = DEFAULT_LESSON_LIMIT): Lesson[] {
  const rows = db
    .prepare(`SELECT ${LESSON_COLUMNS} FROM lessons ORDER BY createdAt DESC, rowid DESC LIMIT ?`)
    .all(limit) as LessonRow[];
  return rows.map(toLesson);
}
