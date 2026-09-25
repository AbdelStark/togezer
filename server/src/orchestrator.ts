/**
 * Pure goal-orchestration layer for togezer.
 *
 * Sits on top of the persistence factory in ./db.js and contains no express,
 * WebSocket, or timer code — the tick loop (and the HTTP/WS API) consume these
 * functions; this module never drives itself. All behaviour is deterministic:
 * the task template is fixed, the topic is derived from the goal text only,
 * and assignment tie-breaks follow stable creation order.
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  assignTask,
  createGoal,
  createTask,
  listAgents,
  listGoals,
  listTasks,
  listTasksByGoal,
  updateGoalStatus,
} from './db.js';
import type { Agent, AgentRole, Goal, GoalStatus, Task } from './types.js';

/** Maximum length of the topic embedded in generated task titles. */
const TOPIC_MAX_LENGTH = 60;
/** Appended to the topic when it had to be truncated. */
const TOPIC_ELLIPSIS = '…';

/**
 * Fixed deterministic task template. Every entry maps to exactly one role, so
 * each decomposed goal always spawns a researcher task, two coder tasks, and
 * a reviewer task (>= 3 role-matched sub-tasks per the orchestrator contract).
 */
const TASK_TEMPLATES: ReadonlyArray<{ role: AgentRole; title: (topic: string) => string }> = [
  { role: 'researcher', title: (topic) => `Research scope & constraints for "${topic}"` },
  { role: 'coder', title: (topic) => `Design the solution approach for "${topic}"` },
  { role: 'coder', title: (topic) => `Implement the core deliverable for "${topic}"` },
  { role: 'reviewer', title: (topic) => `Review, test & harden the deliverable for "${topic}"` },
];

/**
 * Derive the display topic for task titles: trim the goal text, collapse all
 * internal whitespace runs to single spaces, then truncate to
 * {@link TOPIC_MAX_LENGTH} characters, appending an ellipsis when truncated.
 */
function computeTopic(goalText: string): string {
  const collapsed = goalText.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= TOPIC_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, TOPIC_MAX_LENGTH) + TOPIC_ELLIPSIS;
}

/**
 * Decompose a goal into the fixed role-matched task template.
 *
 * Trims `goalText` and throws when nothing remains (the API layer maps this
 * to an HTTP 400). Persists the goal row (status 'pending') followed by one
 * task row per template entry (each status 'todo', unassigned), and returns
 * both.
 */
export function decomposeGoal(
  db: DatabaseSync,
  goalText: string,
): { goal: Goal; tasks: Task[] } {
  const text = goalText.trim();
  if (text.length === 0) {
    throw new Error('goal text is required');
  }
  const goal = createGoal(db, { text });
  const topic = computeTopic(text);
  const tasks = TASK_TEMPLATES.map((template) =>
    createTask(db, { goalId: goal.id, title: template.title(topic), role: template.role }),
  );
  return { goal, tasks };
}

/**
 * Number of non-terminal tasks (`todo` or `in_progress`) currently assigned
 * to the agent, counted across ALL goals.
 */
function openTaskCount(tasks: Task[], agentId: string): number {
  let count = 0;
  for (const task of tasks) {
    if (task.assigneeId === agentId && (task.status === 'todo' || task.status === 'in_progress')) {
      count += 1;
    }
  }
  return count;
}

/**
 * Pick the best matching-role agent for an unassigned task.
 *
 * Candidates are the registered agents whose role matches the task. Idle
 * agents are preferred over working ones; among the preferred candidates the
 * one with the fewest currently-assigned non-terminal tasks wins, and ties
 * are broken by agent creation order (the stable `listAgents` row order).
 * Returns null when no agent of the role exists.
 */
function pickAgent(agents: Agent[], tasks: Task[], role: AgentRole): Agent | null {
  const candidates = agents.filter((agent) => agent.role === role);
  if (candidates.length === 0) return null;
  const idle = candidates.filter((agent) => agent.status === 'idle');
  const pool = idle.length > 0 ? idle : candidates;
  let best: Agent | null = null;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (const agent of pool) {
    const load = openTaskCount(tasks, agent.id);
    // Strict `<` keeps the earliest candidate (creation order) on ties.
    if (load < bestLoad) {
      best = agent;
      bestLoad = load;
    }
  }
  return best;
}

/**
 * Assign every still-unassigned 'todo' task of the goal to the best
 * matching-role agent (see {@link pickAgent} for the selection rule).
 *
 * Tasks with no agent of their role registered stay 'todo' and unassigned;
 * the tick loop can call {@link retryUnassigned} once matching agents
 * register. Re-reads and returns the goal's task list afterwards so callers
 * observe persisted state.
 */
export function assignTasks(db: DatabaseSync, goalId: string): Task[] {
  const agents = listAgents(db);
  // Live snapshot of all tasks: assignment made for this goal must count
  // towards an agent's load for subsequent picks in the same pass.
  const snapshot = listTasks(db);
  for (const task of listTasksByGoal(db, goalId)) {
    if (task.status !== 'todo' || task.assigneeId !== null) continue;
    const agent = pickAgent(agents, snapshot, task.role);
    if (agent === null) continue;
    assignTask(db, task.id, agent.id);
    const index = snapshot.findIndex((candidate) => candidate.id === task.id);
    if (index !== -1) {
      snapshot[index] = { ...task, assigneeId: agent.id };
    }
  }
  return listTasksByGoal(db, goalId);
}

/**
 * Retry assignment for every goal that still has unassigned 'todo' tasks.
 *
 * Called by the tick loop whenever new agents may have registered. Returns
 * the re-read task lists of the goals that were revisited (in goal creation
 * order); goals with nothing to assign are not touched.
 */
export function retryUnassigned(db: DatabaseSync): Task[] {
  const goalIds = new Set(
    listTasks(db)
      .filter((task) => task.status === 'todo' && task.assigneeId === null)
      .map((task) => task.goalId),
  );
  const result: Task[] = [];
  for (const goal of listGoals(db)) {
    if (goalIds.has(goal.id)) {
      result.push(...assignTasks(db, goal.id));
    }
  }
  return result;
}

/**
 * Aggregate the task statuses of a goal into the goal's status.
 *
 * All tasks 'done' → 'done'; any 'failed' → 'failed'; any 'in_progress' or
 * any task with an assignee → 'running'; otherwise 'pending' (a goal with no
 * tasks at all is also 'pending'). The status is persisted via
 * `updateGoalStatus` and returned.
 */
export function aggregateGoalStatus(db: DatabaseSync, goalId: string): GoalStatus {
  const tasks = listTasksByGoal(db, goalId);
  let status: GoalStatus;
  if (tasks.length === 0) {
    status = 'pending';
  } else if (tasks.every((task) => task.status === 'done')) {
    status = 'done';
  } else if (tasks.some((task) => task.status === 'failed')) {
    status = 'failed';
  } else if (
    tasks.some((task) => task.status === 'in_progress') ||
    tasks.some((task) => task.assigneeId !== null)
  ) {
    status = 'running';
  } else {
    status = 'pending';
  }
  updateGoalStatus(db, goalId, status);
  return status;
}
