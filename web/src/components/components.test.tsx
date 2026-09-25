/**
 * Component render tests for Board and AgentPanel against fixtures that
 * mirror backend semantics, plus a seeded-store binding test exercising the
 * useSyncExternalStore pattern the App glue will use.
 */
import { act, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, it } from 'vitest';
import type { Agent, Goal, Lesson, Task, WsEvent } from '../types';
import { createStore, type Store } from '../store';
import { AgentPanel } from './AgentPanel';
import { Board } from './Board';

// ---------------------------------------------------------------------------
// Fixtures: 3 agents, 5 tasks (todo / 2x in_progress / done / failed),
// 1 goal, 1 lesson — realistic shapes for the seeded store.
// ---------------------------------------------------------------------------

const goal: Goal = {
  id: 'g1',
  text: 'Ship the realtime dashboard',
  status: 'running',
  createdAt: '2025-01-01T00:00:00.000Z',
};

const lessons: Lesson[] = [
  {
    id: 'l1',
    content: 'Seed store snapshots must keep reference equality on no-op dispatches',
    sourceTaskId: 't4',
    createdAt: '2025-01-01T01:00:00.000Z',
  },
];

const agents: Agent[] = [
  {
    id: 'a-rex',
    name: 'Rex',
    role: 'researcher',
    status: 'idle',
    currentTaskId: null,
  },
  {
    id: 'a-ada',
    name: 'Ada',
    role: 'coder',
    status: 'working',
    currentTaskId: 't2',
  },
  {
    id: 'a-ravi',
    name: 'Ravi',
    role: 'reviewer',
    status: 'working',
    currentTaskId: 't3',
  },
];

const tasks: Task[] = [
  {
    id: 't1',
    goalId: goal.id,
    title: 'Draft research notes',
    role: 'researcher',
    status: 'todo',
    assigneeId: 'a-rex',
    result: null,
    activity: [],
  },
  {
    id: 't2',
    goalId: goal.id,
    title: 'Implement Board UI',
    role: 'coder',
    status: 'in_progress',
    assigneeId: 'a-ada',
    result: null,
    activity: [
      'Reading types.ts',
      'Writing Board component',
      'Adding column counts',
    ],
  },
  {
    id: 't3',
    goalId: goal.id,
    title: 'Review store semantics',
    role: 'reviewer',
    status: 'in_progress',
    assigneeId: 'a-ravi',
    result: null,
    activity: ['Checking snapshot equality'],
  },
  {
    id: 't4',
    goalId: goal.id,
    title: 'Set up toolchain',
    role: 'coder',
    status: 'done',
    assigneeId: 'a-ada',
    result: 'Vite + Vitest configured',
    activity: ['Scaffolded configs', 'Build green'],
  },
  {
    id: 't5',
    goalId: goal.id,
    title: 'Fetch flaky mirror',
    role: 'researcher',
    status: 'failed',
    assigneeId: 'a-rex',
    result: 'Network timeout',
    activity: ['Request timed out'],
  },
];

/** Find the single agent row whose text content contains the given name. */
function findAgentRow(name: string): HTMLElement {
  const rows = screen.getAllByTestId('agent-row');
  const row = rows.find((entry) => entry.textContent?.includes(name) ?? false);
  if (!row) {
    throw new Error(`No agent row found for ${name}`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

describe('Board', () => {
  it('renders the three columns with correct counts', () => {
    render(<Board tasks={tasks} agents={agents} />);

    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.getByTestId('column-todo')).toBeInTheDocument();
    expect(screen.getByTestId('column-in_progress')).toBeInTheDocument();
    expect(screen.getByTestId('column-done')).toBeInTheDocument();

    expect(screen.getByText('Todo (1)')).toBeInTheDocument();
    expect(screen.getByText('In Progress (2)')).toBeInTheDocument();
    // Failed tasks are grouped into the Done column.
    expect(screen.getByText('Done (2)')).toBeInTheDocument();
  });

  it('renders each task title in its matching column', () => {
    render(<Board tasks={tasks} agents={agents} />);

    const todo = within(screen.getByTestId('column-todo'));
    expect(todo.getByText('Draft research notes')).toBeInTheDocument();

    const inProgress = within(screen.getByTestId('column-in_progress'));
    expect(inProgress.getByText('Implement Board UI')).toBeInTheDocument();
    expect(inProgress.getByText('Review store semantics')).toBeInTheDocument();

    const done = within(screen.getByTestId('column-done'));
    expect(done.getByText('Set up toolchain')).toBeInTheDocument();
    expect(done.getByText('Fetch flaky mirror')).toBeInTheDocument();
  });

  it('renders cards with role, status, assignee name, and the last activity entries', () => {
    render(<Board tasks={tasks} agents={agents} />);

    const inProgress = within(screen.getByTestId('column-in_progress'));
    const adaCard = inProgress
      .getAllByTestId('task-card')
      .find((card) => card.textContent?.includes('Implement Board UI'));
    expect(adaCard).toBeDefined();
    if (!adaCard) return;

    const card = within(adaCard);
    expect(card.getByText('coder')).toBeInTheDocument();
    expect(card.getByText('in_progress')).toBeInTheDocument();
    expect(card.getByText('Ada')).toBeInTheDocument();
    // Only the last two activity entries are shown (t2 has three).
    expect(card.getByText('Writing Board component')).toBeInTheDocument();
    expect(card.getByText('Adding column counts')).toBeInTheDocument();
    expect(
      card.queryByText('Reading types.ts'),
    ).not.toBeInTheDocument();
  });

  it('flags failed tasks with a distinct failed badge inside the Done column', () => {
    render(<Board tasks={tasks} agents={agents} />);

    const done = within(screen.getByTestId('column-done'));
    expect(done.getByText('failed')).toBeInTheDocument();
    const failedCard = done
      .getAllByTestId('task-card')
      .find((card) => card.textContent?.includes('Fetch flaky mirror'));
    expect(failedCard).toBeDefined();
    if (!failedCard) return;
    expect(
      failedCard.querySelector('.badge-failed'),
    ).toBeInTheDocument();
  });

  it('renders empty-state hints for columns without tasks', () => {
    render(<Board tasks={[]} agents={[]} />);

    expect(screen.getByTestId('board')).toBeInTheDocument();
    for (const columnId of ['column-todo', 'column-in_progress', 'column-done']) {
      const column = screen.getByTestId(columnId);
      expect(within(column).getByText('No tasks yet')).toBeInTheDocument();
      expect(within(column).queryByTestId('task-card')).not.toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// AgentPanel
// ---------------------------------------------------------------------------

describe('AgentPanel', () => {
  it('renders every agent with name, role, and status pill', () => {
    render(<AgentPanel agents={agents} tasks={tasks} />);

    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-row')).toHaveLength(3);

    const rexRow = within(findAgentRow('Rex'));
    expect(rexRow.getByText('Rex')).toBeInTheDocument();
    expect(rexRow.getByText('researcher')).toBeInTheDocument();
    expect(rexRow.getByText('idle')).toBeInTheDocument();

    const adaRow = within(findAgentRow('Ada'));
    expect(adaRow.getByText('Ada')).toBeInTheDocument();
    expect(adaRow.getByText('coder')).toBeInTheDocument();
    expect(adaRow.getByText('working')).toBeInTheDocument();

    const raviRow = within(findAgentRow('Ravi'));
    expect(raviRow.getByText('Ravi')).toBeInTheDocument();
    expect(raviRow.getByText('reviewer')).toBeInTheDocument();
    expect(raviRow.getByText('working')).toBeInTheDocument();
  });

  it('resolves current tasks by currentTaskId and shows an idle hint otherwise', () => {
    render(<AgentPanel agents={agents} tasks={tasks} />);

    expect(
      within(findAgentRow('Ada')).getByText('Implement Board UI'),
    ).toBeInTheDocument();
    expect(
      within(findAgentRow('Ravi')).getByText('Review store semantics'),
    ).toBeInTheDocument();
    expect(
      within(findAgentRow('Rex')).getByText('no current task'),
    ).toBeInTheDocument();
  });

  it('renders an empty-state hint with no agents', () => {
    render(<AgentPanel agents={[]} tasks={[]} />);

    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByText('No agents connected')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-row')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Seeded store binding: useSyncExternalStore over createStore
// ---------------------------------------------------------------------------

function StoreHarness({ store }: { store: Store }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div>
      <Board tasks={state.tasks} agents={state.agents} />
      <AgentPanel agents={state.agents} tasks={state.tasks} />
    </div>
  );
}

describe('store binding', () => {
  it('renders components from a seeded store and re-renders on dispatch', () => {
    const store = createStore({
      agents,
      tasks,
      goals: [goal],
      lessons,
      connected: true,
    });
    render(<StoreHarness store={store} />);

    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByText('Todo (1)')).toBeInTheDocument();

    const updatedTask: Task = { ...tasks[0], title: 'Draft research notes v2' };
    const event: WsEvent = { type: 'task.updated', at: '2025-01-01T02:00:00.000Z', task: updatedTask };
    act(() => {
      store.dispatch({ type: 'event', event });
    });

    const todo = within(screen.getByTestId('column-todo'));
    expect(todo.getByText('Draft research notes v2')).toBeInTheDocument();
    expect(todo.queryByText('Draft research notes')).not.toBeInTheDocument();
  });
});
