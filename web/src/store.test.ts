import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Goal, Lesson, StateSnapshot, Task, WsEvent } from './types';
import { connectWs, getAgents, getLessons, getState, postGoal } from './api';
import { createStore } from './store';

const AT = '2025-01-01T00:00:00.000Z';

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    role: 'coder',
    status: 'idle',
    currentTaskId: null,
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goalId: 'g1',
    title: `Task ${id}`,
    role: 'coder',
    status: 'todo',
    assigneeId: null,
    result: null,
    activity: [],
    ...overrides,
  };
}

function makeGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    text: `Goal ${id}`,
    status: 'pending',
    createdAt: AT,
    ...overrides,
  };
}

function makeLesson(id: string): Lesson {
  return { id, content: `Lesson ${id}`, sourceTaskId: 't1', createdAt: AT };
}

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return { agents: [], goals: [], tasks: [], lessons: [], ...overrides };
}

const taskUpdated = (task: Task): WsEvent => ({
  type: 'task.updated',
  at: AT,
  task,
});
const agentStatus = (agent: Agent): WsEvent => ({
  type: 'agent.status',
  at: AT,
  agent,
});
const goalStatus = (goal: Goal): WsEvent => ({
  type: 'goal.status',
  at: AT,
  goal,
});
const lessonCreated = (lesson: Lesson): WsEvent => ({
  type: 'lesson.created',
  at: AT,
  lesson,
});

describe('store reducer', () => {
  it('createStore seeds initial state from a partial', () => {
    const store = createStore({ connected: true, goals: [makeGoal('g1')] });
    expect(store.getSnapshot()).toEqual({
      agents: [],
      goals: [makeGoal('g1')],
      tasks: [],
      lessons: [],
      connected: true,
    });
  });

  it('snapshot action replaces arrays and preserves connected', () => {
    const store = createStore({ connected: true });
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({
        agents: [makeAgent('a1')],
        tasks: [makeTask('t1')],
      }),
    });
    const state = store.getSnapshot();
    expect(state.agents).toEqual([makeAgent('a1')]);
    expect(state.tasks).toEqual([makeTask('t1')]);
    expect(state.goals).toEqual([]);
    expect(state.lessons).toEqual([]);
    expect(state.connected).toBe(true);
  });

  it('snapshot action is a no-op when the arrays are already current', () => {
    const snap = makeSnapshot({ agents: [makeAgent('a1')] });
    const store = createStore(snap);
    const before = store.getSnapshot();
    store.dispatch({ type: 'snapshot', snapshot: snap });
    expect(store.getSnapshot()).toBe(before);
    // A fresh (deep-equal but distinct) snapshot object still replaces state.
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({ agents: [makeAgent('a1')] }),
    });
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('task.updated appends new tasks at the tail', () => {
    const store = createStore();
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({ tasks: [makeTask('t1')] }),
    });
    store.dispatch({
      type: 'event',
      event: taskUpdated(makeTask('t2', { status: 'in_progress' })),
    });
    expect(store.getSnapshot().tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('task.updated updates existing tasks in place preserving order', () => {
    const t2 = makeTask('t2');
    const t3 = makeTask('t3');
    const store = createStore();
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({ tasks: [makeTask('t1'), t2, t3] }),
    });
    store.dispatch({
      type: 'event',
      event: taskUpdated(
        makeTask('t1', { status: 'in_progress', assigneeId: 'a1' }),
      ),
    });
    const state = store.getSnapshot();
    expect(state.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(state.tasks[0]).toEqual(
      makeTask('t1', { status: 'in_progress', assigneeId: 'a1' }),
    );
    expect(state.tasks[1]).toBe(t2);
    expect(state.tasks[2]).toBe(t3);
  });

  it('replaying an identical task/agent/goal event preserves the reference', () => {
    const store = createStore();
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({
        agents: [makeAgent('a1')],
        goals: [makeGoal('g1')],
        tasks: [makeTask('t1')],
      }),
    });
    const taskEvent = taskUpdated(makeTask('t1', { status: 'done', result: 'ok' }));
    store.dispatch({ type: 'event', event: taskEvent });
    const afterTask = store.getSnapshot();
    store.dispatch({ type: 'event', event: taskEvent });
    expect(store.getSnapshot()).toBe(afterTask);

    const agentEvent = agentStatus(makeAgent('a1', { status: 'working' }));
    store.dispatch({ type: 'event', event: agentEvent });
    const afterAgent = store.getSnapshot();
    store.dispatch({ type: 'event', event: agentEvent });
    expect(store.getSnapshot()).toBe(afterAgent);

    const goalEvent = goalStatus(makeGoal('g1', { status: 'running' }));
    store.dispatch({ type: 'event', event: goalEvent });
    const afterGoal = store.getSnapshot();
    store.dispatch({ type: 'event', event: goalEvent });
    expect(store.getSnapshot()).toBe(afterGoal);
  });

  it('agent.status and goal.status upsert by id', () => {
    const store = createStore();
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({
        agents: [makeAgent('a1')],
        goals: [makeGoal('g1')],
      }),
    });
    store.dispatch({ type: 'event', event: agentStatus(makeAgent('a1', { status: 'working' })) });
    store.dispatch({ type: 'event', event: agentStatus(makeAgent('a2', { role: 'researcher' })) });
    store.dispatch({ type: 'event', event: goalStatus(makeGoal('g1', { status: 'done' })) });
    store.dispatch({ type: 'event', event: goalStatus(makeGoal('g2', { status: 'failed' })) });
    const state = store.getSnapshot();
    expect(state.agents.map((a) => [a.id, a.status])).toEqual([
      ['a1', 'working'],
      ['a2', 'idle'],
    ]);
    expect(state.agents[1]!.role).toBe('researcher');
    expect(state.goals.map((g) => [g.id, g.status])).toEqual([
      ['g1', 'done'],
      ['g2', 'failed'],
    ]);
  });

  it('lesson.created prepends newest-first', () => {
    const store = createStore();
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l1')) });
    expect(store.getSnapshot().lessons.map((l) => l.id)).toEqual(['l1']);
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l2')) });
    expect(store.getSnapshot().lessons.map((l) => l.id)).toEqual(['l2', 'l1']);
  });

  it('replaying the current head lesson preserves the reference', () => {
    const store = createStore();
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l1')) });
    const after = store.getSnapshot();
    // Fresh, deep-equal lesson object (not the same reference).
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l1')) });
    expect(store.getSnapshot()).toBe(after);
    expect(store.getSnapshot().lessons).toHaveLength(1);
  });

  it('ws.status flips connected and preserves reference when unchanged', () => {
    const store = createStore();
    expect(store.getSnapshot().connected).toBe(false);
    store.dispatch({ type: 'ws.status', connected: true });
    expect(store.getSnapshot().connected).toBe(true);
    const before = store.getSnapshot();
    store.dispatch({ type: 'ws.status', connected: true });
    expect(store.getSnapshot()).toBe(before);
    store.dispatch({ type: 'ws.status', connected: false });
    expect(store.getSnapshot().connected).toBe(false);
  });

  it('ignores events with an unknown type at runtime', () => {
    const store = createStore();
    const before = store.getSnapshot();
    store.dispatch({
      type: 'event',
      event: { type: 'mystery', at: AT } as unknown as WsEvent,
    });
    expect(store.getSnapshot()).toBe(before);
  });

  it('listeners fire on every dispatch and unsubscribe stops them', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: 'ws.status', connected: true });
    store.dispatch({ type: 'ws.status', connected: true }); // no-op dispatch still notifies
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.dispatch({ type: 'ws.status', connected: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('scripted full sequence yields the exact hand-computed state', () => {
    const store = createStore();
    store.dispatch({
      type: 'snapshot',
      snapshot: makeSnapshot({
        agents: [makeAgent('a1')],
        goals: [makeGoal('g1')],
        tasks: [makeTask('t1'), makeTask('t2')],
        lessons: [makeLesson('l0')],
      }),
    });
    store.dispatch({
      type: 'event',
      event: taskUpdated(makeTask('t1', { status: 'in_progress', assigneeId: 'a1' })),
    });
    store.dispatch({ type: 'event', event: taskUpdated(makeTask('t3')) });
    store.dispatch({
      type: 'event',
      event: agentStatus(makeAgent('a1', { status: 'working', currentTaskId: 't1' })),
    });
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l2')) });
    store.dispatch({ type: 'event', event: lessonCreated(makeLesson('l1')) });
    store.dispatch({
      type: 'event',
      event: goalStatus(makeGoal('g1', { status: 'running' })),
    });

    expect(store.getSnapshot()).toEqual({
      agents: [makeAgent('a1', { status: 'working', currentTaskId: 't1' })],
      goals: [makeGoal('g1', { status: 'running' })],
      tasks: [
        makeTask('t1', { status: 'in_progress', assigneeId: 'a1' }),
        makeTask('t2'),
        makeTask('t3'),
      ],
      lessons: [makeLesson('l1'), makeLesson('l2'), makeLesson('l0')],
      connected: false,
    });
  });
});

describe('rest client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getState parses the snapshot', async () => {
    const snap = makeSnapshot({ agents: [makeAgent('a1')] });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => snap,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getState()).resolves.toEqual(snap);
    expect(fetchMock).toHaveBeenCalledWith('/state', undefined);
  });

  it('getAgents unwraps the agents envelope', async () => {
    const agents = [makeAgent('a1'), makeAgent('a2')];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ agents }),
      })),
    );
    await expect(getAgents()).resolves.toEqual(agents);
  });

  it('getLessons defaults to limit 50 and forwards explicit limits', async () => {
    const lessons = [makeLesson('l1')];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ lessons }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getLessons(7)).resolves.toEqual(lessons);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/lessons?limit=7', undefined);
    await getLessons();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/lessons?limit=50', undefined);
  });

  it('postGoal sends the JSON body and unwraps the payload', async () => {
    const payload = { goal: makeGoal('g1'), tasks: [makeTask('t1')] };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => payload,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postGoal('ship it')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ship it' }),
    });
  });

  it('surfaces the server error message on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'goal text is required' }),
      })),
    );
    await expect(postGoal('')).rejects.toThrow('goal text is required');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    await expect(getState()).rejects.toThrow(
      'Request to /state failed with status 500',
    );
  });
});

/** Minimal WebSocket double: records instances and lets tests fire lifecycle callbacks. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('ws client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects to the same-origin /ws url, reports open status, dispatches parsed events', () => {
    const events: WsEvent[] = [];
    const statuses: boolean[] = [];
    const client = connectWs({
      onEvent: (event) => events.push(event),
      onStatusChange: (connected) => statuses.push(connected),
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const sock = FakeWebSocket.instances[0]!;
    const expectedUrl = `${
      location.protocol === 'https:' ? 'wss' : 'ws'
    }://${location.host}/ws`;
    expect(sock.url).toBe(expectedUrl);

    expect(statuses).toEqual([]);
    sock.onopen?.();
    expect(statuses).toEqual([true]);

    const taskEvent = taskUpdated(makeTask('t1', { status: 'done' }));
    sock.onmessage?.({ data: JSON.stringify(taskEvent) });
    sock.onmessage?.({ data: 'not-json' }); // malformed frame is dropped
    expect(events).toEqual([taskEvent]);

    client.close();
  });

  it('reconnects with backoff after an unexpected close', () => {
    const statuses: boolean[] = [];
    connectWs({
      onEvent: () => undefined,
      onStatusChange: (connected) => statuses.push(connected),
    });

    const first = FakeWebSocket.instances[0]!;
    first.onopen?.();
    expect(statuses).toEqual([true]);

    first.onclose?.();
    expect(statuses).toEqual([true, false]);

    // First retry: 500ms base + up to 10% jitter, comfortably under 1000ms.
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1]!;
    second.onopen?.();
    expect(statuses).toEqual([true, false, true]);
  });

  it('keeps retrying with capped backoff until reconnected', () => {
    connectWs({ onEvent: () => undefined });
    let expected = 1;
    // Six consecutive failures: base delays 500, 1000, 2000, 4000, 5000, 5000
    // (capped) plus <=10% jitter; 6000ms of fake time always covers one retry.
    for (let i = 0; i < 6; i += 1) {
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
      latest.onclose?.();
      vi.advanceTimersByTime(6000);
      expected += 1;
      expect(FakeWebSocket.instances).toHaveLength(expected);
    }
  });

  it('close() is intentional: no further reconnects', () => {
    const statuses: boolean[] = [];
    const client = connectWs({
      onEvent: () => undefined,
      onStatusChange: (connected) => statuses.push(connected),
    });
    const sock = FakeWebSocket.instances[0]!;
    sock.onopen?.();
    client.close();
    expect(statuses).toEqual([true, false]);
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() cancels a pending reconnect timer', () => {
    const client = connectWs({ onEvent: () => undefined });
    FakeWebSocket.instances[0]!.onclose?.(); // schedules a retry
    client.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
