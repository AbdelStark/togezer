/**
 * Dashboard composition: hydrates domain state over REST once on mount,
 * then keeps it live via the server's WebSocket event stream. Both feed a
 * module-scope store bound to React through useSyncExternalStore.
 *
 * The mount effect is StrictMode-safe: cleanup closes the socket (no
 * reconnects afterwards) and a repeated getState dispatch is idempotent.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { connectWs, getState, postGoal } from './api';
import { createStore } from './store';
import { AgentPanel } from './components/AgentPanel';
import { Board } from './components/Board';
import { GoalForm } from './components/GoalForm';
import { LessonsFeed } from './components/LessonsFeed';

/** Module-scope singleton so the live state survives HMR remounts. */
const store = createStore();

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    void getState().then((snapshot) => {
      store.dispatch({ type: 'snapshot', snapshot });
    });
    const ws = connectWs({
      onEvent: (event) => {
        store.dispatch({ type: 'event', event });
      },
      onStatusChange: (connected) => {
        store.dispatch({ type: 'ws.status', connected });
      },
    });
    return () => {
      ws.close();
    };
  }, []);

  // The 201 response body is intentionally ignored: the created goal and its
  // tasks arrive immediately afterwards as WebSocket events (goal.status +
  // task.updated), which is the single source of truth for the UI.
  const handleSubmitGoal = (text: string): Promise<unknown> => postGoal(text);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Togezer</h1>
        <span
          data-testid="conn-indicator"
          className={
            state.connected
              ? 'conn conn-connected'
              : 'conn conn-reconnecting'
          }
        >
          {state.connected ? 'connected' : 'reconnecting'}
        </span>
      </header>
      <main className="app-main">
        <div className="app-primary">
          <GoalForm onSubmit={handleSubmitGoal} />
          <Board tasks={state.tasks} agents={state.agents} />
        </div>
        <div className="app-rail">
          <AgentPanel agents={state.agents} tasks={state.tasks} />
          <LessonsFeed lessons={state.lessons} />
        </div>
      </main>
    </div>
  );
}
