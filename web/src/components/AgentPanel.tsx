/**
 * Agent roster: one row per agent with role, status, and the title of the
 * task the agent is currently working on.
 *
 * Prop-driven (the App wires the store in a later step).
 */
import type { Agent, Task } from '../types';

interface AgentPanelProps {
  agents: Agent[];
  /** Used to resolve agent.currentTaskId to a task title. */
  tasks: Task[];
}

const NO_CURRENT_TASK = 'no current task';

export function AgentPanel({ agents, tasks }: AgentPanelProps) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return (
    <aside data-testid="agent-panel" className="agent-panel">
      <h2 className="agent-panel-header">Agents</h2>
      {agents.length === 0 ? (
        <p className="agent-panel-empty">No agents connected</p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => {
            const currentTask = agent.currentTaskId
              ? (taskById.get(agent.currentTaskId) ?? null)
              : null;
            return (
              <li key={agent.id} data-testid="agent-row" className="agent-row">
                <span className="agent-name">{agent.name}</span>
                <span className={`badge badge-role badge-role-${agent.role}`}>
                  {agent.role}
                </span>
                <span className={`pill pill-${agent.status}`}>
                  {agent.status}
                </span>
                <span className="agent-current-task">
                  {currentTask ? currentTask.title : NO_CURRENT_TASK}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
