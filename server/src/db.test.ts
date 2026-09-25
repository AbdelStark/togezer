import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  appendTaskActivity,
  assignTask,
  closeDb,
  createAgent,
  createGoal,
  createLesson,
  createTask,
  getAgent,
  getGoal,
  getTask,
  listAgents,
  listGoals,
  listLessons,
  listTasks,
  listTasksByGoal,
  openDb,
  updateAgentStatus,
  updateGoalStatus,
  updateTaskStatus,
} from './db.js';
import type { AgentRole, GoalStatus, TaskStatus } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures: every test gets isolated handles; temp files are always removed.
// ---------------------------------------------------------------------------

const ALL_GOAL_STATUSES: GoalStatus[] = ['pending', 'running', 'done', 'failed'];
const ALL_AGENT_ROLES: AgentRole[] = ['researcher', 'coder', 'reviewer'];
const ALL_TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'failed'];

const openDbs: DatabaseSync[] = [];
const tempDirs: string[] = [];

function openMemoryDb(): DatabaseSync {
  const db = openDb(':memory:');
  openDbs.push(db);
  return db;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'togezer-db-'));
  tempDirs.push(dir);
  return dir;
}

/** Goals A and B with three tasks: two on A, one on B. */
function seedGoalsAndTasks(db: DatabaseSync): void {
  createGoal(db, { id: 'goal-a', text: 'Goal A' });
  createGoal(db, { id: 'goal-b', text: 'Goal B' });
  createTask(db, { id: 'task-a1', goalId: 'goal-a', title: 'Task A1', role: 'researcher' });
  createTask(db, { id: 'task-a2', goalId: 'goal-a', title: 'Task A2', role: 'coder' });
  createTask(db, { id: 'task-b1', goalId: 'goal-b', title: 'Task B1', role: 'reviewer' });
}

afterEach(() => {
  while (openDbs.length > 0) {
    closeDb(openDbs.pop() as DatabaseSync);
  }
  while (tempDirs.length > 0) {
    // Unlinks the temp dir and any db file inside it.
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Schema / openDb
// ---------------------------------------------------------------------------

describe('openDb', () => {
  it('applies the schema idempotently when the same file is opened twice', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'togezer.db');
    const first = openDb(dbPath);
    expect(() => openDb(dbPath)).not.toThrow();

    // The second handle sees the same tables and data; inserting through it
    // still works, proving the re-run DDL did not corrupt anything.
    createGoal(first, { id: 'g-file', text: 'Seen from both handles' });
    const second = openDb(dbPath);
    expect(getGoal(second, 'g-file')).toMatchObject({ id: 'g-file', text: 'Seen from both handles' });
    createGoal(second, { id: 'g-file-2', text: 'Written via second handle' });
    expect(getGoal(first, 'g-file-2')).toMatchObject({ id: 'g-file-2' });
  });

  it('gives independent :memory: databases on repeated opens', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    createGoal(first, { id: 'g1', text: 'Only in first' });
    expect(listGoals(first)).toHaveLength(1);
    expect(listGoals(second)).toHaveLength(0);
  });

  it('is usable immediately after open (all tables queryable)', () => {
    const db = openDb(':memory:');
    expect(listGoals(db)).toEqual([]);
    expect(listAgents(db)).toEqual([]);
    expect(listTasks(db)).toEqual([]);
    expect(listLessons(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe('goals', () => {
  it('roundtrips create → get → list with exact fields', () => {
    const db = openMemoryDb();
    const created = createGoal(db, { id: 'g1', text: 'Ship the release' });

    expect(created).toEqual({ id: 'g1', text: 'Ship the release', status: 'pending', createdAt: created.createdAt });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);

    expect(getGoal(db, 'g1')).toEqual(created);
    expect(listGoals(db)).toEqual([created]);
  });

  it('defaults the id to a random UUID when not provided', () => {
    const db = openMemoryDb();
    const a = createGoal(db, { text: 'Auto id A' });
    const b = createGoal(db, { text: 'Auto id B' });
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b.id).not.toBe(a.id);
    expect(getGoal(db, a.id)?.text).toBe('Auto id A');
  });

  it('returns null for a missing goal', () => {
    const db = openMemoryDb();
    expect(getGoal(db, 'nope')).toBeNull();
  });

  it.each(ALL_GOAL_STATUSES)('persists updateGoalStatus(%s)', (status) => {
    const db = openMemoryDb();
    createGoal(db, { id: 'g1', text: 'Status target' });
    updateGoalStatus(db, 'g1', status);
    const goal = getGoal(db, 'g1');
    expect(goal?.status).toBe(status);
    expect(goal?.text).toBe('Status target');
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('agents', () => {
  it('roundtrips create → get → list with idle defaults', () => {
    const db = openMemoryDb();
    const created = createAgent(db, { id: 'a1', name: 'Ada', role: 'coder' });
    expect(created).toEqual({ id: 'a1', name: 'Ada', role: 'coder', status: 'idle', currentTaskId: null });
    expect(getAgent(db, 'a1')).toEqual(created);
    expect(listAgents(db)).toEqual([created]);
  });

  it.each(ALL_AGENT_ROLES)('persists role %s', (role) => {
    const db = openMemoryDb();
    createAgent(db, { id: `a-${role}`, name: 'Agent', role });
    expect(getAgent(db, `a-${role}`)?.role).toBe(role);
  });

  it('updateAgentStatus sets then clears currentTaskId', () => {
    const db = openMemoryDb();
    createAgent(db, { id: 'a1', name: 'Ada', role: 'researcher' });

    updateAgentStatus(db, 'a1', 'working', 'task-9');
    expect(getAgent(db, 'a1')).toEqual({
      id: 'a1',
      name: 'Ada',
      role: 'researcher',
      status: 'working',
      currentTaskId: 'task-9',
    });

    updateAgentStatus(db, 'a1', 'idle', null);
    expect(getAgent(db, 'a1')).toEqual({
      id: 'a1',
      name: 'Ada',
      role: 'researcher',
      status: 'idle',
      currentTaskId: null,
    });
  });

  it('returns null for a missing agent', () => {
    const db = openMemoryDb();
    expect(getAgent(db, 'nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('tasks', () => {
  it('creates with defaults and roundtrips via get/list', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);

    const task = getTask(db, 'task-a1');
    expect(task).toEqual({
      id: 'task-a1',
      goalId: 'goal-a',
      title: 'Task A1',
      role: 'researcher',
      status: 'todo',
      assigneeId: null,
      result: null,
      activity: [],
    });
    expect(listTasks(db).map((t) => t.id)).toEqual(['task-a1', 'task-a2', 'task-b1']);
    expect(getTask(db, 'nope')).toBeNull();
  });

  it('listTasksByGoal filters by goal without leaking other goals’ tasks', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);

    const goalATasks = listTasksByGoal(db, 'goal-a');
    expect(goalATasks.map((t) => t.id)).toEqual(['task-a1', 'task-a2']);
    expect(goalATasks.map((t) => t.title)).toEqual(['Task A1', 'Task A2']);
    for (const task of goalATasks) {
      expect(task.goalId).toBe('goal-a');
      expect(task.id).not.toBe('task-b1');
    }
    expect(listTasksByGoal(db, 'goal-b').map((t) => t.id)).toEqual(['task-b1']);
    expect(listTasksByGoal(db, 'goal-missing')).toEqual([]);
  });

  it('assignTask persists the assigneeId', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    assignTask(db, 'task-a1', 'agent-1');
    expect(getTask(db, 'task-a1')?.assigneeId).toBe('agent-1');
    // Other tasks untouched.
    expect(getTask(db, 'task-a2')?.assigneeId).toBeNull();
  });

  it.each(ALL_TASK_STATUSES)('updateTaskStatus(%s) with a result persists both', (status) => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    updateTaskStatus(db, 'task-a1', status, 'result text');
    const task = getTask(db, 'task-a1');
    expect(task?.status).toBe(status);
    expect(task?.result).toBe('result text');
  });

  it('updateTaskStatus without a result keeps the stored result; explicit null clears it', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    updateTaskStatus(db, 'task-a1', 'done', 'final output');

    // `undefined` result → leave the stored result alone.
    updateTaskStatus(db, 'task-a1', 'in_progress');
    expect(getTask(db, 'task-a1')).toMatchObject({ status: 'in_progress', result: 'final output' });

    // Explicit `null` → clear it.
    updateTaskStatus(db, 'task-a1', 'todo', null);
    expect(getTask(db, 'task-a1')).toMatchObject({ status: 'todo', result: null });
  });

  it('appendTaskActivity accumulates messages in order', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    appendTaskActivity(db, 'task-a1', 'm1');
    appendTaskActivity(db, 'task-a1', 'm2');
    expect(getTask(db, 'task-a1')?.activity).toEqual(['m1', 'm2']);
    // Unrelated task is untouched.
    expect(getTask(db, 'task-b1')?.activity).toEqual([]);
  });

  it('appendTaskActivity is a no-op for a missing task', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    expect(() => appendTaskActivity(db, 'task-missing', 'm1')).not.toThrow();
    expect(getTask(db, 'task-missing')).toBeNull();
  });

  it('enforces the goals(id) foreign key', () => {
    const db = openMemoryDb();
    expect(() => createTask(db, { goalId: 'goal-missing', title: 'Orphan', role: 'coder' })).toThrow();
    // With the FK active, creating against a real goal succeeds.
    createGoal(db, { id: 'goal-a', text: 'Goal A' });
    expect(() => createTask(db, { goalId: 'goal-a', title: 'Anchored', role: 'coder' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

describe('lessons', () => {
  it('returns lessons newest first with exact contents', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    const first = createLesson(db, { id: 'l1', content: 'first lesson', sourceTaskId: 'task-a1' });
    const second = createLesson(db, { id: 'l2', content: 'second lesson', sourceTaskId: 'task-b1' });

    // Newest first (rowid DESC breaks same-millisecond createdAt ties).
    expect(listLessons(db)).toEqual([second, first]);
    for (const lesson of listLessons(db)) {
      expect(Number.isNaN(Date.parse(lesson.createdAt))).toBe(false);
    }
  });

  it('honours the limit argument and defaults to 50', () => {
    const db = openMemoryDb();
    seedGoalsAndTasks(db);
    for (let i = 1; i <= 3; i++) {
      createLesson(db, { id: `l${i}`, content: `lesson ${i}`, sourceTaskId: 'task-a1' });
    }
    expect(listLessons(db, 1).map((l) => l.content)).toEqual(['lesson 3']);
    expect(listLessons(db, 2)).toHaveLength(2);
    // Default limit covers everything below 50.
    expect(listLessons(db)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

describe('file persistence', () => {
  it('survives closeDb and a reopen of the same path with identical rows', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'togezer.db');

    const db = openDb(dbPath);
    createAgent(db, { id: 'a-file', name: 'Filea', role: 'coder' });
    const goalBefore = createGoal(db, { id: 'g-file', text: 'Persist me' });
    createTask(db, { id: 'task-file', goalId: 'g-file', title: 'Survive reopen', role: 'coder' });
    assignTask(db, 'task-file', 'a-file');
    updateTaskStatus(db, 'task-file', 'done', 'kept on disk');
    appendTaskActivity(db, 'task-file', 'before close');
    const taskBefore = getTask(db, 'task-file');
    createLesson(db, { id: 'l-file', content: 'Learned persistence', sourceTaskId: 'task-file' });
    const agentBefore = getAgent(db, 'a-file');
    closeDb(db);

    // Reopen the SAME path; everything must read back identically.
    const reopened = openDb(dbPath);
    expect(getAgent(reopened, 'a-file')).toEqual(agentBefore);
    expect(getGoal(reopened, 'g-file')).toEqual(goalBefore);

    const task = getTask(reopened, 'task-file');
    expect(task).toEqual(taskBefore);
    expect(task?.status).toBe('done');
    expect(task?.result).toBe('kept on disk');
    expect(task?.assigneeId).toBe('a-file');
    expect(task?.activity).toEqual(['before close']);

    const lessons = listLessons(reopened);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ id: 'l-file', content: 'Learned persistence', sourceTaskId: 'task-file' });

    closeDb(reopened);
  });
});
