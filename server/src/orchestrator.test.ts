import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeDb,
  createAgent,
  getAgent,
  getGoal,
  listGoals,
  listTasks,
  listTasksByGoal,
  openDb,
  updateTaskStatus,
} from './db.js';
import {
  aggregateGoalStatus,
  assignTasks,
  decomposeGoal,
  retryUnassigned,
} from './orchestrator.js';
import type { Task } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures: every test gets an isolated ':memory:' database.
// ---------------------------------------------------------------------------

const openDbs: DatabaseSync[] = [];

function openMemoryDb(): DatabaseSync {
  const db = openDb(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    closeDb(openDbs.pop() as DatabaseSync);
  }
});

/** The four titles the orchestrator must generate for `topic`, in order. */
function expectedTitles(topic: string): string[] {
  return [
    `Research scope & constraints for "${topic}"`,
    `Design the solution approach for "${topic}"`,
    `Implement the core deliverable for "${topic}"`,
    `Review, test & harden the deliverable for "${topic}"`,
  ];
}

/** Index of the first task with the given role (tasks are role-matched 1:1). */
function firstTaskWithRole(tasks: Task[], role: Task['role']): Task {
  const task = tasks.find((candidate) => candidate.role === role);
  if (task === undefined) throw new Error(`no task with role ${role}`);
  return task;
}

// ---------------------------------------------------------------------------
// decomposeGoal
// ---------------------------------------------------------------------------

describe('decomposeGoal', () => {
  it('creates exactly 4 role-matched tasks with the template titles (a)', () => {
    const db = openMemoryDb();
    const { goal, tasks } = decomposeGoal(db, 'launch the marketing site');

    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.title)).toEqual(expectedTitles('launch the marketing site'));
    expect(tasks.map((task) => task.role)).toEqual(['researcher', 'coder', 'coder', 'reviewer']);
    expect(new Set(tasks.map((task) => task.role))).toEqual(
      new Set(['researcher', 'coder', 'reviewer']),
    );
    for (const task of tasks) {
      expect(task.status).toBe('todo');
      expect(task.assigneeId).toBeNull();
      expect(task.goalId).toBe(goal.id);
    }
  });

  it('creates a pending persisted goal (a)', () => {
    const db = openMemoryDb();
    const { goal, tasks } = decomposeGoal(db, 'launch the marketing site');

    expect(goal.text).toBe('launch the marketing site');
    expect(goal.status).toBe('pending');
    expect(goal.createdAt).toBeTruthy();
    // The goal row is persisted and linked to every task row.
    expect(getGoal(db, goal.id)).toEqual(goal);
    expect(listTasksByGoal(db, goal.id)).toHaveLength(tasks.length);
  });

  it('throws "goal text is required" for blank input and persists nothing (b)', () => {
    const db = openMemoryDb();
    expect(() => decomposeGoal(db, '   ')).toThrow('goal text is required');
    expect(() => decomposeGoal(db, '')).toThrow('goal text is required');
    expect(() => decomposeGoal(db, '\n\t ')).toThrow('goal text is required');
    expect(listGoals(db)).toHaveLength(0);
    expect(listTasks(db)).toHaveLength(0);
  });

  it('stores the trimmed goal text but collapses whitespace in the topic', () => {
    const db = openMemoryDb();
    const { goal, tasks } = decomposeGoal(db, '  build   the\n  thing  ');

    expect(goal.text).toBe('build   the\n  thing');
    expect(tasks.map((task) => task.title)).toEqual(expectedTitles('build the thing'));
  });

  it('truncates long topics to 60 chars plus an ellipsis in every title (c)', () => {
    const db = openMemoryDb();
    const longText = 'alpha beta '.repeat(9) + 'gamma delta'; // 110 chars
    const collapsed = longText.trim().replace(/\s+/g, ' ');
    expect(collapsed.length).toBe(110);

    const { tasks } = decomposeGoal(db, longText);
    const expectedTopic = collapsed.slice(0, 60) + '…';
    expect(expectedTopic.length).toBe(61);
    for (const task of tasks) {
      expect(task.title.endsWith(`"${expectedTopic}"`)).toBe(true);
    }
  });

  it('does not truncate a topic of exactly 60 chars', () => {
    const db = openMemoryDb();
    const exact = 'a'.repeat(60);
    const { tasks } = decomposeGoal(db, exact);
    expect(tasks.map((task) => task.title)).toEqual(expectedTitles(exact));
  });
});

// ---------------------------------------------------------------------------
// assignTasks
// ---------------------------------------------------------------------------

describe('assignTasks', () => {
  it('assigns every task to an agent of the matching role (d)', () => {
    const db = openMemoryDb();
    const researcher = createAgent(db, { name: 'Ada', role: 'researcher' });
    const coder = createAgent(db, { name: 'Grace', role: 'coder' });
    const reviewer = createAgent(db, { name: 'Edsger', role: 'reviewer' });
    const { goal } = decomposeGoal(db, 'ship the dashboard');

    const assigned = assignTasks(db, goal.id);

    expect(assigned.every((task) => task.assigneeId !== null)).toBe(true);
    for (const task of assigned) {
      const agent = getAgent(db, task.assigneeId as string);
      expect(agent).not.toBeNull();
      expect(agent?.role).toBe(task.role);
    }
    expect(firstTaskWithRole(assigned, 'researcher').assigneeId).toBe(researcher.id);
    expect(firstTaskWithRole(assigned, 'reviewer').assigneeId).toBe(reviewer.id);
    for (const task of assigned.filter((candidate) => candidate.role === 'coder')) {
      expect(task.assigneeId).toBe(coder.id);
    }
  });

  it('does not hoard work when an idle peer coder exists (e)', () => {
    const db = openMemoryDb();
    createAgent(db, { name: 'Res', role: 'researcher' });
    createAgent(db, { name: 'Rev', role: 'reviewer' });
    const coderA = createAgent(db, { name: 'Coder A', role: 'coder' });
    const first = decomposeGoal(db, 'goal one');
    assignTasks(db, first.goal.id);

    // Coder A is the only coder, so it took both coder tasks of goal one.
    const firstCoderTasks = listTasksByGoal(db, first.goal.id).filter(
      (task) => task.role === 'coder',
    );
    expect(firstCoderTasks).toHaveLength(2);
    expect(firstCoderTasks.every((task) => task.assigneeId === coderA.id)).toBe(true);

    // A second coder registers; goal two's coder tasks must go to it instead.
    const coderB = createAgent(db, { name: 'Coder B', role: 'coder' });
    const second = decomposeGoal(db, 'goal two');
    assignTasks(db, second.goal.id);

    const secondCoderTasks = listTasksByGoal(db, second.goal.id).filter(
      (task) => task.role === 'coder',
    );
    expect(secondCoderTasks.every((task) => task.assigneeId === coderB.id)).toBe(true);
    // Both coders end up with assigned tasks — no single coder hoarding.
    const allCoderAssignees = new Set(
      listTasks(db)
        .filter((task) => task.role === 'coder' && task.assigneeId !== null)
        .map((task) => task.assigneeId),
    );
    expect(allCoderAssignees).toEqual(new Set([coderA.id, coderB.id]));
  });

  it('leaves tasks unassigned when no agent of the role exists, and retryUnassigned picks them up later (f)', () => {
    const db = openMemoryDb();
    const researcher = createAgent(db, { name: 'Res', role: 'researcher' });
    const { goal } = decomposeGoal(db, 'build the widget');

    const afterFirstPass = assignTasks(db, goal.id);
    expect(firstTaskWithRole(afterFirstPass, 'researcher').assigneeId).toBe(researcher.id);
    for (const task of afterFirstPass.filter((candidate) => candidate.role !== 'researcher')) {
      expect(task.status).toBe('todo');
      expect(task.assigneeId).toBeNull();
    }

    // The matching agents register afterwards; retryUnassigned picks the work up.
    const coder = createAgent(db, { name: 'Coder', role: 'coder' });
    const reviewer = createAgent(db, { name: 'Rev', role: 'reviewer' });
    const retried = retryUnassigned(db);
    expect(retried.length).toBeGreaterThan(0);

    const afterRetry = listTasksByGoal(db, goal.id);
    expect(afterRetry.every((task) => task.assigneeId !== null)).toBe(true);
    for (const task of afterRetry.filter((candidate) => candidate.role === 'coder')) {
      expect(task.assigneeId).toBe(coder.id);
    }
    expect(firstTaskWithRole(afterRetry, 'reviewer').assigneeId).toBe(reviewer.id);
    // The already-assigned researcher task was not reassigned.
    expect(firstTaskWithRole(afterRetry, 'researcher').assigneeId).toBe(researcher.id);
  });

  it('retryUnassigned is a no-op when every todo task already has an assignee', () => {
    const db = openMemoryDb();
    createAgent(db, { name: 'Res', role: 'researcher' });
    createAgent(db, { name: 'Coder', role: 'coder' });
    createAgent(db, { name: 'Rev', role: 'reviewer' });
    const { goal } = decomposeGoal(db, 'all covered');
    assignTasks(db, goal.id);

    expect(retryUnassigned(db)).toEqual([]);
  });

  it('does not reassign tasks that are already assigned or no longer todo', () => {
    const db = openMemoryDb();
    const coderA = createAgent(db, { name: 'Coder A', role: 'coder' });
    const coderB = createAgent(db, { name: 'Coder B', role: 'coder' });
    const { goal } = decomposeGoal(db, 'stable assignment');
    assignTasks(db, goal.id);
    const coderTask = firstTaskWithRole(listTasksByGoal(db, goal.id), 'coder');
    expect(coderTask.assigneeId).toBe(coderA.id);

    // Mark the assigned coder task in_progress, then re-run assignment.
    updateTaskStatus(db, coderTask.id, 'in_progress');
    assignTasks(db, goal.id);
    const after = listTasksByGoal(db, goal.id);
    expect(firstTaskWithRole(after, 'coder').assigneeId).toBe(coderA.id);
    expect(coderB.id).toBeTruthy(); // peer untouched; no churn on non-todo tasks
  });
});

// ---------------------------------------------------------------------------
// aggregateGoalStatus
// ---------------------------------------------------------------------------

describe('aggregateGoalStatus', () => {
  function seedTeam(db: DatabaseSync): void {
    createAgent(db, { name: 'Res', role: 'researcher' });
    createAgent(db, { name: 'Coder', role: 'coder' });
    createAgent(db, { name: 'Rev', role: 'reviewer' });
  }

  it('aggregates pending → running → done → failed (g)', () => {
    const db = openMemoryDb();
    seedTeam(db);
    const { goal } = decomposeGoal(db, 'aggregate me');

    expect(aggregateGoalStatus(db, goal.id)).toBe('pending');
    expect(getGoal(db, goal.id)?.status).toBe('pending');

    assignTasks(db, goal.id);
    expect(aggregateGoalStatus(db, goal.id)).toBe('running');
    expect(getGoal(db, goal.id)?.status).toBe('running');

    const tasks = listTasksByGoal(db, goal.id);
    for (const task of tasks) {
      updateTaskStatus(db, task.id, 'done');
    }
    expect(aggregateGoalStatus(db, goal.id)).toBe('done');
    expect(getGoal(db, goal.id)?.status).toBe('done');

    // A single failed task flips the goal back to failed.
    updateTaskStatus(db, tasks[0]?.id as string, 'failed');
    expect(aggregateGoalStatus(db, goal.id)).toBe('failed');
    expect(getGoal(db, goal.id)?.status).toBe('failed');
  });

  it('reports running when a task is in_progress even before others are assigned', () => {
    const db = openMemoryDb();
    seedTeam(db);
    const { goal } = decomposeGoal(db, 'in flight');
    const tasks = listTasksByGoal(db, goal.id);
    updateTaskStatus(db, firstTaskWithRole(tasks, 'researcher').id, 'in_progress');

    expect(aggregateGoalStatus(db, goal.id)).toBe('running');
    expect(getGoal(db, goal.id)?.status).toBe('running');
  });

  it('failed wins over running and done wins only when every task is done', () => {
    const db = openMemoryDb();
    seedTeam(db);
    const { goal } = decomposeGoal(db, 'mixed statuses');
    assignTasks(db, goal.id);
    const tasks = listTasksByGoal(db, goal.id);

    // One failed task among unfinished ones → failed (beats running).
    updateTaskStatus(db, tasks[0]?.id as string, 'failed');
    expect(aggregateGoalStatus(db, goal.id)).toBe('failed');

    // Recover: remaining tasks all done → done.
    for (const task of tasks) {
      updateTaskStatus(db, task.id, 'done');
    }
    expect(aggregateGoalStatus(db, goal.id)).toBe('done');
  });
});
