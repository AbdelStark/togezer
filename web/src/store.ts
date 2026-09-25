/**
 * Plain-TS reducer store for the dashboard. React-free and
 * useSyncExternalStore-compatible: subscribe() registers listeners, which
 * fire on every dispatch, while getSnapshot() preserves reference equality
 * whenever a dispatch did not actually change state.
 */
import type {
  Agent,
  Goal,
  Lesson,
  StateSnapshot,
  Task,
  WsEvent,
} from './types';

/** Domain state plus the live WebSocket connection flag. */
export interface AppState {
  agents: Agent[];
  goals: Goal[];
  tasks: Task[];
  lessons: Lesson[];
  connected: boolean;
}

/** Actions accepted by the store. */
export type StoreAction =
  | { type: 'snapshot'; snapshot: StateSnapshot }
  | { type: 'event'; event: WsEvent }
  | { type: 'ws.status'; connected: boolean };

/**
 * Structural equality over JSON-compatible values, insensitive to key
 * order. Used to detect no-op upserts so unchanged dispatches preserve
 * snapshot reference equality.
 */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  if (keysA.length !== Object.keys(recordB).length) return false;
  return keysA.every(
    (key) => key in recordB && jsonEquals(recordA[key], recordB[key]),
  );
}

/** Insert-or-replace by id, preserving array order for existing entries. */
function upsertById<T extends { id: string }>(
  list: T[],
  item: T,
): { list: T[]; changed: boolean } {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return { list: [...list, item], changed: true };
  if (jsonEquals(list[index], item)) return { list, changed: false };
  const next = list.slice();
  next[index] = item;
  return { list: next, changed: true };
}

function reducer(state: AppState, action: StoreAction): AppState {
  switch (action.type) {
    case 'snapshot': {
      // Replace all four arrays wholesale, keep the connection flag.
      const { agents, goals, tasks, lessons } = action.snapshot;
      if (
        state.agents === agents &&
        state.goals === goals &&
        state.tasks === tasks &&
        state.lessons === lessons
      ) {
        return state;
      }
      return { agents, goals, tasks, lessons, connected: state.connected };
    }
    case 'event': {
      const { event } = action;
      switch (event.type) {
        case 'task.updated': {
          const { list, changed } = upsertById(state.tasks, event.task);
          return changed ? { ...state, tasks: list } : state;
        }
        case 'agent.status': {
          const { list, changed } = upsertById(state.agents, event.agent);
          return changed ? { ...state, agents: list } : state;
        }
        case 'goal.status': {
          const { list, changed } = upsertById(state.goals, event.goal);
          return changed ? { ...state, goals: list } : state;
        }
        case 'lesson.created': {
          // Newest first: prepend. An identical replay of the current head is
          // a no-op so reference equality is preserved on duplicate pushes.
          if (
            state.lessons.length > 0 &&
            jsonEquals(state.lessons[0], event.lesson)
          ) {
            return state;
          }
          return { ...state, lessons: [event.lesson, ...state.lessons] };
        }
      }
      // Unknown event discriminant at runtime: ignore defensively.
      return state;
    }
    case 'ws.status': {
      if (state.connected === action.connected) return state;
      return { ...state, connected: action.connected };
    }
  }
}

/** A minimal external store, shaped for React's useSyncExternalStore. */
export interface Store {
  getSnapshot(): AppState;
  dispatch(action: StoreAction): void;
  subscribe(listener: () => void): () => void;
}

/** Create a store over the reducer, optionally seeded with partial state. */
export function createStore(initial?: Partial<AppState>): Store {
  let state: AppState = {
    agents: initial?.agents ?? [],
    goals: initial?.goals ?? [],
    tasks: initial?.tasks ?? [],
    lessons: initial?.lessons ?? [],
    connected: initial?.connected ?? false,
  };
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return state;
    },
    dispatch(action: StoreAction) {
      state = reducer(state, action);
      // Listeners fire on every dispatch; useSyncExternalStore re-renders
      // only when getSnapshot() returns a new reference.
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
