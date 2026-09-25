/**
 * Simulated multi-agent execution layer for togezer.
 *
 * Owns the agent side of the simulation: a tick loop that moves each agent's
 * assigned task todo -> in_progress -> done/failed with seeded, deterministic
 * outcomes, role-flavoured activity messages, and a Lesson (or a shared
 * Pitfall) generated on every terminal transition. Deliberately transport
 * free: no express, no ws, no HTTP — the API layer wires the `onEvent` sink
 * into the WebSocket broadcast (and `start()` into the server lifecycle).
 *
 * Determinism: the same `seed` reproduces the identical sequence of statuses,
 * activity messages, results, and lesson contents. All randomness (per-task
 * progress budgets, success/failure rolls) flows from one mulberry32 PRNG
 * seeded once per simulation, and agents/tasks are iterated in stable DB
 * creation order. Timestamps and UUIDs are NOT part of that contract.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  appendTaskActivity,
  createLesson,
  getAgent,
  getGoal,
  getTask,
  listAgents,
  listTasks,
  updateAgentStatus,
  updateTaskStatus,
} from './db.js';
import { aggregateGoalStatus, retryUnassigned } from './orchestrator.js';
import type { AgentRole, Task, WsEvent } from './types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default PRNG seed (createSimulation option `seed`). */
const DEFAULT_SEED = 42;
/** Default probability that a task finishes 'failed' instead of 'done'. */
const DEFAULT_FAILURE_RATE = 0.08;
/** A started task needs 2-4 progress ticks before its terminal outcome. */
const MIN_PROGRESS_TICKS = 2;
const PROGRESS_TICK_CHOICES = 3; // budgets: 2, 3 or 4
/** Default interval used by Simulation.start. */
const DEFAULT_INTERVAL_MS = 600;

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Role voices: the activity/result/lesson copy each role speaks.
// ---------------------------------------------------------------------------

interface RoleVoice {
  start: (topic: string) => string;
  progress: ReadonlyArray<(topic: string) => string>;
  done: (topic: string) => string;
  failed: (topic: string) => string;
  lessonNote: (topic: string) => string;
  pitfallNote: (topic: string) => string;
}

const VOICES: Record<AgentRole, RoleVoice> = {
  researcher: {
    start: (topic) => `Scanning sources for "${topic}"…`,
    progress: [
      (topic) => `Reading through the material on "${topic}" and noting key constraints…`,
      (topic) => `Cross-checking findings on "${topic}" against earlier notes…`,
      (topic) => `Summarising the most relevant sources for "${topic}"…`,
      (topic) => `Listing the open questions "${topic}" still needs answered…`,
    ],
    done: (topic) => `Research for "${topic}" is consolidated — key findings and constraints documented.`,
    failed: (topic) => `Research for "${topic}" stalled: sources were contradictory and inconclusive.`,
    lessonNote: (topic) =>
      `triangulate at least two independent sources on "${topic}" before drawing conclusions.`,
    pitfallNote: (topic) =>
      `do not lean on a single stale source on "${topic}" — verify freshness and consistency first.`,
  },
  coder: {
    start: (topic) => `Reading the brief and sketching an approach for "${topic}"…`,
    progress: [
      (topic) => `Laying out the main building blocks for "${topic}"…`,
      (topic) => `Wiring the core flow for "${topic}" step by step…`,
      (topic) => `Smoothing over edge cases around "${topic}"…`,
      (topic) => `Re-reading the brief to keep "${topic}" on track…`,
    ],
    done: (topic) => `Deliverable for "${topic}" is implemented and self-checked.`,
    failed: (topic) => `Implementation for "${topic}" kept breaking on edge cases and needs another attempt.`,
    lessonNote: (topic) =>
      `sketch the approach and walk the edge cases for "${topic}" before writing the final code.`,
    pitfallNote: (topic) =>
      `do not skip the edge-case pass for "${topic}" — test the tricky paths early, not last.`,
  },
  reviewer: {
    start: (topic) => `Setting up the review checklist for "${topic}"…`,
    progress: [
      (topic) => `Working through the review checklist for "${topic}"…`,
      (topic) => `Exercising the happy path for "${topic}" end to end…`,
      (topic) => `Probing edge cases and failure modes around "${topic}"…`,
      (topic) => `Collecting sign-off notes for "${topic}"…`,
    ],
    done: (topic) => `Review of "${topic}" is complete — checks pass and feedback is filed.`,
    failed: (topic) => `Review of "${topic}" surfaced blockers the current approach cannot resolve.`,
    lessonNote: (topic) =>
      `run the checklist for "${topic}" against the real deliverable, not the plan.`,
    pitfallNote: (topic) =>
      `do not sign off on "${topic}" without an end-to-end run of the deliverable.`,
  },
};

/**
 * Extract the quoted topic embedded in orchestrator-generated titles
 * (`Design the solution approach for "launch the marketing site"`), falling
 * back to the full title for free-form titles without a quoted span.
 */
function topicOf(title: string): string {
  const match = /"([^"]*)"/.exec(title);
  return match === null ? title : match[1];
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimulationOptions {
  /** PRNG seed; identical seeds yield identical runs. Default 42. */
  seed?: number;
  /** Probability a task finishes 'failed' instead of 'done'. Default 0.08. */
  failureRate?: number;
  /** Sink for every domain event produced by the simulation. */
  onEvent?: (event: WsEvent) => void;
}

export interface Simulation {
  /** Advance the simulation by one step over ALL agents (synchronous). */
  tick(): void;
  /**
   * Drive tick() on a background interval. Returns an unsubscribe stop
   * function. The interval is unref'd so tests and short-lived CLIs exit.
   */
  start(intervalMs?: number): () => void;
}

export function createSimulation(db: DatabaseSync, options: SimulationOptions = {}): Simulation {
  const failureRate = options.failureRate ?? DEFAULT_FAILURE_RATE;
  const emit = options.onEvent ?? (() => {});
  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  /** Remaining progress ticks per in-progress task id, chosen at start. */
  const progressBudgets = new Map<string, number>();

  const now = (): string => new Date().toISOString();

  // Events always carry the freshly re-read domain object so `at`, status and
  // activity[] are current at emission time.
  function emitTaskUpdated(taskId: string): void {
    const task = getTask(db, taskId);
    if (task !== null) emit({ type: 'task.updated', at: now(), task });
  }

  function emitAgentStatus(agentId: string): void {
    const agent = getAgent(db, agentId);
    if (agent !== null) emit({ type: 'agent.status', at: now(), agent });
  }

  function emitGoalStatus(goalId: string): void {
    const goal = getGoal(db, goalId);
    if (goal !== null) emit({ type: 'goal.status', at: now(), goal });
  }

  /** todo -> in_progress: claim the task, log the kickoff message. */
  function startTask(agentId: string, task: Task): void {
    updateTaskStatus(db, task.id, 'in_progress');
    updateAgentStatus(db, agentId, 'working', task.id);
    progressBudgets.set(
      task.id,
      MIN_PROGRESS_TICKS + Math.floor(random() * PROGRESS_TICK_CHOICES),
    );
    appendTaskActivity(db, task.id, VOICES[task.role].start(topicOf(task.title)));
    emitTaskUpdated(task.id);
    emitAgentStatus(agentId);
  }

  /** in_progress: spend a progress tick, or settle the terminal outcome. */
  function workTask(agentId: string, task: Task): void {
    const remaining = progressBudgets.get(task.id) ?? 0;
    if (remaining > 0) {
      progressBudgets.set(task.id, remaining - 1);
      const voice = VOICES[task.role];
      const variant = voice.progress[(task.activity.length - 1) % voice.progress.length];
      appendTaskActivity(db, task.id, variant(topicOf(task.title)));
      emitTaskUpdated(task.id);
      return;
    }
    finishTask(agentId, task);
  }

  /** in_progress -> done | failed, with a Lesson/Pitfall and agent release. */
  function finishTask(agentId: string, task: Task): void {
    progressBudgets.delete(task.id);
    const failed = random() < failureRate;
    const voice = VOICES[task.role];
    const topic = topicOf(task.title);
    const lessonContent = failed
      ? `Pitfall from "${task.title}": ${voice.pitfallNote(topic)}`
      : `Lesson from "${task.title}": ${voice.lessonNote(topic)}`;
    if (failed) {
      updateTaskStatus(db, task.id, 'failed', voice.failed(topic));
    } else {
      updateTaskStatus(db, task.id, 'done', voice.done(topic));
    }
    const lesson = createLesson(db, { content: lessonContent, sourceTaskId: task.id });
    updateAgentStatus(db, agentId, 'idle', null);
    aggregateGoalStatus(db, task.goalId);
    // Emission order: task, agent, lesson, goal. The goal event reflects the
    // fresh aggregate, so the last emission of a tick that completes a goal
    // always carries its final 'done'/'failed' status.
    emitTaskUpdated(task.id);
    emitAgentStatus(agentId);
    emit({ type: 'lesson.created', at: now(), lesson });
    emitGoalStatus(task.goalId);
  }

  function tick(): void {
    // Late-registered agents may claim tasks that were waiting for their role.
    retryUnassigned(db);
    const open = listTasks(db).filter(
      (task): task is Task & { assigneeId: string } =>
        task.assigneeId !== null && (task.status === 'todo' || task.status === 'in_progress'),
    );
    if (open.length === 0) return; // nothing to do: covers idempotent terminal goals
    const byAssignee = new Map<string, Task[]>();
    for (const task of open) {
      const queue = byAssignee.get(task.assigneeId);
      if (queue === undefined) byAssignee.set(task.assigneeId, [task]);
      else queue.push(task);
    }
    // Each agent advances its earliest assigned non-terminal task one step;
    // listAgents yields stable creation order, keeping runs deterministic.
    for (const agent of listAgents(db)) {
      const queue = byAssignee.get(agent.id);
      if (queue === undefined || queue.length === 0) continue;
      const task = queue[0];
      if (task.status === 'todo') startTask(agent.id, task);
      else workTask(agent.id, task);
    }
  }

  function start(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
    const interval = setInterval(tick, intervalMs);
    // Do not keep the event loop alive just for the simulation.
    interval.unref?.();
    return () => clearInterval(interval);
  }

  return { tick, start };
}
