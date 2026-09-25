/**
 * Lifecycle tests for the agent simulation (./agents.js).
 *
 * Every scenario runs synchronously against an isolated ':memory:' database
 * and drives the simulation exclusively through tick() calls — start() is
 * never used here. Timestamps and UUIDs are excluded from comparisons, so all
 * assertions hold deterministically for a fixed seed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeDb,
  createAgent,
  getGoal,
  listAgents,
  listGoals,
  listLessons,
  listTasks,
  listTasksByGoal,
  openDb,
} from './db.js';
import { assignTasks, decomposeGoal } from './orchestrator.js';
import { createSimulation } from './agents.js';
import type { Goal, TaskStatus, WsEvent } from './types.js';

type AgentStatusEvent = Extract<WsEvent, { type: 'agent.status' }>;
type LessonCreatedEvent = Extract<WsEvent, { type: 'lesson.created' }>;
type GoalStatusEvent = Extract<WsEvent, { type: 'goal.status' }>;

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

const GOAL_TEXT = 'launch the marketing site';
const SECOND_GOAL_TEXT = 'ship the onboarding flow';
/** Tick bound for a single goal (4 tasks, worst case 12 ticks). */
const MAX_TICKS = 30;
/** Tick bound for the multi-goal scenario (8 tasks, worst case 24 ticks). */
const MAX_TICKS_MULTI_GOAL = 60;

/** Register one agent per role, in stable creation order. */
function registerTeam(db: DatabaseSync): void {
  createAgent(db, { name: 'Ada', role: 'researcher' });
  createAgent(db, { name: 'Grace', role: 'coder' });
  createAgent(db, { name: 'Linus', role: 'reviewer' });
}

/** True when every task in the database has reached a terminal status. */
function allTerminal(db: DatabaseSync): boolean {
  return listTasks(db).every((task) => task.status === 'done' || task.status === 'failed');
}

/** Deterministic projection of a task: ids and timestamps stripped. */
interface TaskFingerprint {
  title: string;
  status: TaskStatus;
  activity: number;
  result: string | null;
}

function fingerprintTasks(db: DatabaseSync): TaskFingerprint[] {
  return listTasks(db)
    .map((task) => ({
      title: task.title,
      status: task.status,
      activity: task.activity.length,
      result: task.result,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Sorted lesson contents: the deterministic projection of the lesson log. */
function lessonContents(db: DatabaseSync): string[] {
  return listLessons(db, 1000)
    .map((lesson) => lesson.content)
    .sort();
}

/**
 * Tick until every task is terminal (or the bound is exhausted), invoking
 * `onTick` after each tick. Returns the number of ticks performed.
 */
function runToTerminal(
  db: DatabaseSync,
  sim: { tick(): void },
  maxTicks: number,
  onTick?: () => void,
): number {
  let ticks = 0;
  for (let i = 0; i < maxTicks; i += 1) {
    sim.tick();
    ticks += 1;
    onTick?.();
    if (allTerminal(db)) return ticks;
  }
  return ticks;
}

interface SampleRun {
  goal: Goal;
  events: WsEvent[];
  ticks: number;
}

/** Seed the sample goal scenario and drive it to completion. */
function runSampleGoal(
  db: DatabaseSync,
  options: { seed?: number; failureRate?: number } = {},
): SampleRun {
  registerTeam(db);
  const { goal } = decomposeGoal(db, GOAL_TEXT);
  assignTasks(db, goal.id);
  const events: WsEvent[] = [];
  const sim = createSimulation(db, { ...options, onEvent: (event) => events.push(event) });
  const ticks = runToTerminal(db, sim, MAX_TICKS);
  return { goal, events, ticks };
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('agents simulation lifecycle', () => {
  it('drives a sample goal to completion within the tick bound (a)', () => {
    const db = openMemoryDb();
    const { goal, ticks } = runSampleGoal(db, { seed: 42, failureRate: 0 });

    expect(ticks).toBeLessThanOrEqual(MAX_TICKS);
    const tasks = listTasks(db);
    expect(tasks.length).toBe(4);
    for (const task of tasks) {
      expect(task.status).toBe('done');
      expect(task.result).not.toBeNull();
      expect(task.result?.length).toBeGreaterThan(0);
    }
    expect(getGoal(db, goal.id)?.status).toBe('done');
    for (const agent of listAgents(db)) {
      expect(agent.status).toBe('idle');
      expect(agent.currentTaskId).toBeNull();
    }
  });

  it('walks every task through todo -> in_progress -> done with activity and results (b)', () => {
    const db = openMemoryDb();
    registerTeam(db);
    const { goal } = decomposeGoal(db, GOAL_TEXT);
    assignTasks(db, goal.id);
    const sim = createSimulation(db, { seed: 42, failureRate: 0 });

    // Per-task observed statuses, sampled before the first tick and after
    // every tick. Concurrent agents make cross-task ordering meaningless, so
    // only per-task invariants are asserted.
    const seen = new Map<string, Set<TaskStatus>>();
    const sampleStatuses = (): void => {
      for (const task of listTasks(db)) {
        let statuses = seen.get(task.id);
        if (statuses === undefined) {
          statuses = new Set<TaskStatus>();
          seen.set(task.id, statuses);
        }
        statuses.add(task.status);
      }
    };
    sampleStatuses(); // initial state: every task is 'todo'
    runToTerminal(db, sim, MAX_TICKS, sampleStatuses);

    const tasks = listTasksByGoal(db, goal.id);
    expect(tasks).toHaveLength(4);
    for (const task of tasks) {
      expect(seen.get(task.id)).toEqual(new Set<TaskStatus>(['todo', 'in_progress', 'done']));
      expect(task.activity.length).toBeGreaterThanOrEqual(2);
      expect(task.result).not.toBeNull();
      expect(task.result?.length).toBeGreaterThan(0);
    }
  });

  it('emits a legal event stream: transitions, lessons, final goal status (c)', () => {
    const db = openMemoryDb();
    const { goal, events } = runSampleGoal(db, { seed: 42, failureRate: 0 });
    expect(events.length).toBeGreaterThan(0);

    // Every event carries a parseable ISO timestamp.
    for (const event of events) {
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }

    // task.updated: first event per task is the kickoff state (in_progress
    // with the start message already included), statuses only move forward
    // along the legal chain, and a terminal task never emits again.
    const updates = new Map<string, Array<{ status: TaskStatus; activity: number }>>();
    for (const event of events) {
      if (event.type !== 'task.updated') continue;
      const timeline = updates.get(event.task.id) ?? [];
      timeline.push({ status: event.task.status, activity: event.task.activity.length });
      updates.set(event.task.id, timeline);
    }
    expect(updates.size).toBe(listTasks(db).length);
    for (const timeline of updates.values()) {
      expect(timeline[0]?.status).toBe('in_progress');
      expect(timeline[0]?.activity).toBeGreaterThanOrEqual(1);
      let previousRank = 1; // in_progress
      let previousActivity = 0;
      let terminal = false;
      for (const entry of timeline) {
        expect(terminal).toBe(false); // no updates after a terminal transition
        expect(entry.status === 'in_progress' || entry.status === 'done').toBe(true);
        const rank = entry.status === 'done' ? 2 : 1;
        expect(rank).toBeGreaterThanOrEqual(previousRank);
        expect(entry.activity).toBeGreaterThanOrEqual(previousActivity);
        previousRank = rank;
        previousActivity = entry.activity;
        if (entry.status === 'done') terminal = true;
      }
      expect(timeline[timeline.length - 1]?.status).toBe('done');
    }

    // lesson.created: exactly one per task, all success-flavoured, each tied
    // to a real task of the goal.
    const lessons = events.filter(
      (event): event is LessonCreatedEvent => event.type === 'lesson.created',
    );
    expect(lessons).toHaveLength(listTasks(db).length);
    const taskIds = new Set(listTasks(db).map((task) => task.id));
    for (const lesson of lessons) {
      expect(lesson.lesson.content.startsWith('Lesson from')).toBe(true);
      expect(taskIds.has(lesson.lesson.sourceTaskId)).toBe(true);
    }

    // goal.status: emitted at least once with the final aggregate 'done', and
    // the last goal event for the goal reflects it.
    const goalEvents = events.filter(
      (event): event is GoalStatusEvent => event.type === 'goal.status',
    );
    expect(goalEvents.some((event) => event.goal.id === goal.id && event.goal.status === 'done'))
      .toBe(true);
    expect(goalEvents[goalEvents.length - 1]?.goal.status).toBe('done');

    // agent.status: every agent's final event releases it (idle, no task).
    const agentEvents = new Map<string, AgentStatusEvent>();
    for (const event of events) {
      if (event.type !== 'agent.status') continue;
      agentEvents.set(event.agent.id, event);
    }
    expect(agentEvents.size).toBe(3);
    for (const event of agentEvents.values()) {
      expect(event.agent.status).toBe('idle');
      expect(event.agent.currentTaskId).toBeNull();
    }
  });

  it('routes failures into shared pitfalls when failureRate is 1 (d)', () => {
    const db = openMemoryDb();
    const { goal, events } = runSampleGoal(db, { seed: 42, failureRate: 1 });

    const tasks = listTasks(db);
    expect(tasks.length).toBe(4);
    for (const task of tasks) {
      expect(task.status).toBe('failed');
      expect(task.result).not.toBeNull();
      expect(task.result?.length).toBeGreaterThan(0);
    }
    expect(getGoal(db, goal.id)?.status).toBe('failed');

    const lessons = events.filter(
      (event): event is LessonCreatedEvent => event.type === 'lesson.created',
    );
    expect(lessons).toHaveLength(tasks.length);
    for (const lesson of lessons) {
      expect(lesson.lesson.content.startsWith('Pitfall from')).toBe(true);
    }
    const goalEvents = events.filter(
      (event): event is GoalStatusEvent => event.type === 'goal.status',
    );
    expect(goalEvents.length).toBeGreaterThan(0);
    expect(goalEvents[goalEvents.length - 1]?.goal.status).toBe('failed');

    for (const agent of listAgents(db)) {
      expect(agent.status).toBe('idle');
      expect(agent.currentTaskId).toBeNull();
    }
  });

  it('is deterministic for a fixed seed (e)', () => {
    const run = (): { fingerprints: TaskFingerprint[][]; contents: string[] } => {
      const db = openMemoryDb();
      registerTeam(db);
      const { goal } = decomposeGoal(db, GOAL_TEXT);
      assignTasks(db, goal.id);
      const fingerprints: TaskFingerprint[][] = [];
      const sim = createSimulation(db, { seed: 123, failureRate: 0 });
      runToTerminal(db, sim, MAX_TICKS, () => fingerprints.push(fingerprintTasks(db)));
      // afterEach closes every opened db; no explicit close here.
      return { fingerprints, contents: lessonContents(db) };
    };

    const first = run();
    const second = run();
    expect(second.fingerprints).toEqual(first.fingerprints);
    expect(second.contents).toEqual(first.contents);
  });

  it('treats an already-terminal goal as a no-op (f)', () => {
    const db = openMemoryDb();
    runSampleGoal(db, { seed: 42, failureRate: 0 });

    const tasksBefore = JSON.stringify(listTasks(db));
    const lessonsBefore = JSON.stringify(lessonContents(db));
    const goalsBefore = JSON.stringify(listGoals(db));
    const agentsBefore = JSON.stringify(listAgents(db));

    const extraEvents: WsEvent[] = [];
    const sim = createSimulation(db, {
      seed: 42,
      failureRate: 0,
      onEvent: (event) => extraEvents.push(event),
    });
    sim.tick();
    sim.tick();

    expect(JSON.stringify(listTasks(db))).toBe(tasksBefore);
    expect(JSON.stringify(lessonContents(db))).toBe(lessonsBefore);
    expect(JSON.stringify(listGoals(db))).toBe(goalsBefore);
    expect(JSON.stringify(listAgents(db))).toBe(agentsBefore);
    expect(extraEvents).toHaveLength(0);
  });

  it('runs two goals through the same team without cross-goal contamination (g)', () => {
    const db = openMemoryDb();
    registerTeam(db);
    const first = decomposeGoal(db, GOAL_TEXT);
    const second = decomposeGoal(db, SECOND_GOAL_TEXT);
    assignTasks(db, first.goal.id);
    assignTasks(db, second.goal.id);

    const events: WsEvent[] = [];
    const sim = createSimulation(db, {
      seed: 42,
      failureRate: 0,
      onEvent: (event) => events.push(event),
    });
    const ticks = runToTerminal(db, sim, MAX_TICKS_MULTI_GOAL);

    expect(ticks).toBeLessThanOrEqual(MAX_TICKS_MULTI_GOAL);
    const goalIds = new Set([first.goal.id, second.goal.id]);
    const agentsById = new Map(listAgents(db).map((agent) => [agent.id, agent]));
    const tasks = listTasks(db);
    expect(tasks).toHaveLength(8);
    for (const task of tasks) {
      // Every task belongs to exactly one goal and to exactly one role-matched
      // assignee — no cross-goal or cross-role assignment.
      expect(goalIds.has(task.goalId)).toBe(true);
      expect(task.status).toBe('done');
      expect(task.assigneeId).not.toBeNull();
      expect(agentsById.get(task.assigneeId as string)?.role).toBe(task.role);
    }
    expect(listTasksByGoal(db, first.goal.id)).toHaveLength(4);
    expect(listTasksByGoal(db, second.goal.id)).toHaveLength(4);
    expect(getGoal(db, first.goal.id)?.status).toBe('done');
    expect(getGoal(db, second.goal.id)?.status).toBe('done');
    expect(
      events.some(
        (event) =>
          event.type === 'goal.status' &&
          event.goal.id === second.goal.id &&
          event.goal.status === 'done',
      ),
    ).toBe(true);
  });
});
