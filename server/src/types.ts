/**
 * Canonical domain contract for togezer.
 *
 * This module is the single source of truth for the shared types used by the
 * server (WebSocket + REST API) and the web dashboard. Both packages must
 * consume these declarations; the web package re-exports them type-only via
 * web/src/types.ts. Do not duplicate these types elsewhere.
 */

export type AgentRole = 'researcher' | 'coder' | 'reviewer';

export type AgentStatus = 'idle' | 'working';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'failed';

export type GoalStatus = 'pending' | 'running' | 'done' | 'failed';

/** A simulated agent that executes tasks for a goal. */
export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  /** Task currently being worked on, if any. */
  currentTaskId: string | null;
}

/** A unit of work belonging to a goal, executed by an agent of the given role. */
export interface Task {
  id: string;
  goalId: string;
  title: string;
  role: AgentRole;
  status: TaskStatus;
  /** Agent assigned to this task, if any. */
  assigneeId: string | null;
  /** Final result text once the task is done or failed; null while pending. */
  result: string | null;
  /** Timestamped human-readable status lines (the dashboard's activity strip). */
  activity: string[];
}

/** A high-level objective the multi-agent team works toward. */
export interface Goal {
  id: string;
  text: string;
  status: GoalStatus;
  createdAt: string;
}

/** A reusable insight extracted from a completed/failed task. */
export interface Lesson {
  id: string;
  content: string;
  sourceTaskId: string;
  createdAt: string;
}

/** Discriminant values of {@link WsEvent}. */
export const WS_EVENT_TYPES = [
  'task.updated',
  'agent.status',
  'lesson.created',
  'goal.status',
] as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[number];

/**
 * Server-pushed events over the WebSocket connection, discriminated by
 * `type`. `at` is an ISO 8601 timestamp on every variant.
 */
export type WsEvent =
  | { type: 'task.updated'; at: string; task: Task }
  | { type: 'agent.status'; at: string; agent: Agent }
  | { type: 'lesson.created'; at: string; lesson: Lesson }
  | { type: 'goal.status'; at: string; goal: Goal };

/** Full domain state; the payload of GET /state. */
export interface StateSnapshot {
  agents: Agent[];
  goals: Goal[];
  tasks: Task[];
  lessons: Lesson[];
}

// Compile-time exhaustiveness check: every WsEvent variant's discriminant
// must be listed in WS_EVENT_TYPES.
type _WsEventExhaustive = WsEvent extends { type: infer T extends WsEventType } ? (T extends WsEventType ? true : never) : never;
const _wsEventExhaustive: _WsEventExhaustive = true;
void _wsEventExhaustive;
