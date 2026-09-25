import { describe, expect, it } from 'vitest';
import { WS_EVENT_TYPES } from '../../server/src/types';
import type { WsEventType } from './types';

// Compile-time bridge: the web package's type-only re-export must accept the
// exact runtime contract shipped by the server.
const SERVER_EVENT_TYPES: readonly WsEventType[] = WS_EVENT_TYPES;

// Reverse bridge: every WsEventType variant re-exported by the web package
// must exist in the server's runtime list (excess or missing keys are a
// compile error).
const RUNTIME_EVENT_TYPE_COVERAGE: Record<WsEventType, true> = {
  'task.updated': true,
  'agent.status': true,
  'lesson.created': true,
  'goal.status': true,
};

describe('shared contract re-export', () => {
  it('mirrors the server WS_EVENT_TYPES contract', () => {
    expect(SERVER_EVENT_TYPES).toHaveLength(4);
    expect([...SERVER_EVENT_TYPES]).toEqual([
      'task.updated',
      'agent.status',
      'lesson.created',
      'goal.status',
    ]);
    expect(Object.keys(RUNTIME_EVENT_TYPE_COVERAGE).sort()).toEqual(
      [...SERVER_EVENT_TYPES].sort(),
    );
  });
});
