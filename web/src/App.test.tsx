/**
 * App integration proof: REST hydration on mount, live WebSocket-driven
 * updates flowing through the store into every panel, goal submission wired
 * to POST /goals, and the connection indicator flipping with socket events.
 *
 * App holds a module-scope singleton store, so each test resets the module
 * registry to mount against a pristine store.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Goal, Task } from './types';

const AT = '2025-01-01T00:00:00.000Z';

function makeAgent(id: string, name: string, role: Agent['role']): Agent {
  return { id, name, role, status: 'idle', currentTaskId: null };
}

const SNAPSHOT = {
  agents: [
    makeAgent('a1', 'Rex', 'researcher'),
    makeAgent('a2', 'Ada', 'coder'),
    makeAgent('a3', 'Ravi', 'reviewer'),
  ],
  goals: [] as Goal[],
  tasks: [],
  lessons: [],
};

/** Minimal WebSocket double recording instances for manual event firing. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, json: async () => body };
}

/** Find the single agent row whose text content contains the given name. */
function findAgentRow(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('agent-row')
    .find((entry) => entry.textContent?.includes(name));
  if (!row) throw new Error(`No agent row found for ${name}`);
  return row;
}

/** Mount a fresh App (new module registry → pristine store) and wait for hydration. */
async function mountApp(): Promise<FakeWebSocket> {
  const { default: App } = await import('./App');
  render(<App />);
  // Hydration marker: the AgentPanel flips from its empty state to the
  // fixture roster once GET /state resolves and dispatches the snapshot.
  await waitFor(() =>
    expect(screen.getAllByTestId('agent-row')).toHaveLength(3),
  );
  const sock = FakeWebSocket.instances[0];
  if (!sock) throw new Error('App did not construct a WebSocket');
  return sock;
}

describe('App', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hydrates the snapshot once over REST and opens exactly one websocket', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      url === '/state'
        ? jsonResponse(SNAPSHOT)
        : jsonResponse({ error: 'unexpected call' }, false, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    await mountApp();

    // Board renders the empty columns from the hydrated snapshot.
    for (const columnId of [
      'column-todo',
      'column-in_progress',
      'column-done',
    ]) {
      expect(
        within(screen.getByTestId(columnId)).getByText('No tasks yet'),
      ).toBeInTheDocument();
    }
    // fetch('/state') exactly once on mount.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/state', undefined);
    // Exactly one websocket opened, pointed at the same-origin /ws endpoint.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toMatch(/^wss?:\/\/[^/]+\/ws$/);
  });

  it('applies websocket events live through the store', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        url === '/state' ? jsonResponse(SNAPSHOT) : jsonResponse({}, false, 404),
      ),
    );

    const sock = await mountApp();

    // Connection indicator starts disconnected until the socket opens.
    expect(screen.getByTestId('conn-indicator')).toHaveTextContent(
      'reconnecting',
    );

    // 1. task.updated: the card appears in In Progress without any prop
    //    changes to App — pure store → WS flow.
    const task: Task = {
      id: 't1',
      goalId: 'g1',
      title: 'In card test',
      role: 'coder',
      status: 'in_progress',
      assigneeId: null,
      result: null,
      activity: [],
    };
    act(() => {
      sock.onmessage?.({
        data: JSON.stringify({ type: 'task.updated', at: AT, task }),
      });
    });
    const inProgress = within(screen.getByTestId('column-in_progress'));
    expect(inProgress.getByText('In card test')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('column-todo')).queryByText('In card test'),
    ).not.toBeInTheDocument();

    // 2. lesson.created twice: entries land newest-first in the feed.
    act(() => {
      sock.onmessage?.({
        data: JSON.stringify({
          type: 'lesson.created',
          at: AT,
          lesson: {
            id: 'l1',
            content: 'Lesson from t1: prefer structural equality',
            sourceTaskId: 't1',
            createdAt: AT,
          },
        }),
      });
    });
    act(() => {
      sock.onmessage?.({
        data: JSON.stringify({
          type: 'lesson.created',
          at: AT,
          lesson: {
            id: 'l2',
            content: 'Pitfall from t2: guard empty goal input',
            sourceTaskId: 't2',
            createdAt: AT,
          },
        }),
      });
    });
    const entries = screen.getAllByTestId('lesson-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Pitfall from t2: guard empty goal input');
    expect(entries[0].querySelector('.badge-pitfall')).not.toBeNull();
    expect(entries[1]).toHaveTextContent(
      'Lesson from t1: prefer structural equality',
    );

    // 3. agent.status: Rex's roster row flips to 'working'.
    const workingAgent: Agent = { ...SNAPSHOT.agents[0], status: 'working' };
    act(() => {
      sock.onmessage?.({
        data: JSON.stringify({ type: 'agent.status', at: AT, agent: workingAgent }),
      });
    });
    expect(within(findAgentRow('Rex')).getByText('working')).toBeInTheDocument();

    // 4. Connection indicator flips with socket lifecycle.
    act(() => {
      sock.onopen?.();
    });
    expect(screen.getByTestId('conn-indicator')).toHaveTextContent('connected');
    act(() => {
      sock.onclose?.();
    });
    expect(screen.getByTestId('conn-indicator')).toHaveTextContent(
      'reconnecting',
    );
  });

  it('submits goal text through the api layer as POST /goals', async () => {
    const user = userEvent.setup();
    const createdGoal: Goal = {
      id: 'g1',
      text: 'ship the realtime dashboard',
      status: 'pending',
      createdAt: AT,
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url === '/goals') {
        expect(init?.method).toBe('POST');
        return jsonResponse({ goal: createdGoal, tasks: [] }, true, 201);
      }
      return jsonResponse(SNAPSHOT);
    });
    vi.stubGlobal('fetch', fetchMock);

    await mountApp();

    await user.type(screen.getByTestId('goal-input'), 'ship the realtime dashboard');
    await user.click(screen.getByTestId('goal-submit'));

    // Success clears the input; the fetch mock saw the exact POST contract.
    await waitFor(() =>
      expect(screen.getByTestId('goal-input')).toHaveValue(''),
    );
    expect(fetchMock).toHaveBeenCalledWith('/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ship the realtime dashboard' }),
    });
    // Submitting does not refetch /state — new tasks arrive via WS events.
    expect(fetchMock.mock.calls.filter(([url]) => url === '/state')).toHaveLength(1);
    expect(screen.queryByTestId('goal-error')).not.toBeInTheDocument();
  });

  it('surfaces server 400 goal errors verbatim from the api layer', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (url === '/goals') {
          expect(init?.method).toBe('POST');
          return jsonResponse({ error: 'goal text is required' }, false, 400);
        }
        return jsonResponse(SNAPSHOT);
      }),
    );

    await mountApp();

    await user.type(screen.getByTestId('goal-input'), 'anything');
    await user.click(screen.getByTestId('goal-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('goal text is required');
  });
});
