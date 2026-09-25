import { describe, expect, it } from 'vitest';
import { WS_EVENT_TYPES } from './types.js';
import type { TaskStatus } from './types.js';

// Compile-time exhaustive map: adding, removing, or renaming a TaskStatus
// variant breaks this record, keeping the runtime assertion honest.
const TASK_STATUSES: Record<TaskStatus, true> = {
  todo: true,
  in_progress: true,
  done: true,
  failed: true,
};

describe('domain contract', () => {
  it('exposes exactly four WS event types', () => {
    expect(WS_EVENT_TYPES).toHaveLength(4);
    expect([...WS_EVENT_TYPES]).toEqual([
      'task.updated',
      'agent.status',
      'lesson.created',
      'goal.status',
    ]);
  });

  it('covers the full TaskStatus union (4 variants)', () => {
    expect(Object.keys(TASK_STATUSES)).toHaveLength(4);
  });
});
