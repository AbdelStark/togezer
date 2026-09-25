/**
 * Kanban board over the task list: Todo / In Progress / Done columns.
 *
 * Prop-driven (the App wires the store in a later step). Failed tasks are
 * grouped into the Done column and flagged with a distinct failed badge.
 */
import type { Agent, Task, TaskStatus } from '../types';

interface BoardProps {
  tasks: Task[];
  /** Used to resolve assignee display names. */
  agents: Agent[];
}

/** Column id and the task statuses it groups. */
interface ColumnDef {
  id: 'todo' | 'in_progress' | 'done';
  label: string;
  statuses: TaskStatus[];
}

const COLUMNS: ColumnDef[] = [
  { id: 'todo', label: 'Todo', statuses: ['todo'] },
  { id: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
  { id: 'done', label: 'Done', statuses: ['done', 'failed'] },
];

const ACTIVITY_TAIL_LENGTH = 2;

export function Board({ tasks, agents }: BoardProps) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  return (
    <section data-testid="board" className="board">
      {COLUMNS.map((column) => {
        const columnTasks = tasks.filter((task) =>
          column.statuses.includes(task.status),
        );
        return (
          <div
            key={column.id}
            data-testid={`column-${column.id}`}
            className={`column column-${column.id}`}
          >
            <h2 className="column-header">
              {column.label} ({columnTasks.length})
            </h2>
            {columnTasks.length === 0 ? (
              <p className="column-empty">No tasks yet</p>
            ) : (
              columnTasks.map((task) => {
                const assignee = task.assigneeId
                  ? agentById.get(task.assigneeId)
                  : undefined;
                return (
                  <article
                    key={task.id}
                    data-testid="task-card"
                    className={`card card-${task.status}`}
                  >
                    <h3 className="card-title">{task.title}</h3>
                    <div className="card-meta">
                      <span
                        className={`badge badge-role badge-role-${task.role}`}
                      >
                        {task.role}
                      </span>
                      <span
                        className={`badge badge-status badge-status-${task.status}${
                          task.status === 'failed' ? ' badge-failed' : ''
                        }`}
                      >
                        {task.status}
                      </span>
                      {assignee && (
                        <span className="badge badge-assignee">
                          {assignee.name}
                        </span>
                      )}
                    </div>
                    {task.activity.length > 0 && (
                      <ul className="card-activity">
                        {task.activity
                          .slice(-ACTIVITY_TAIL_LENGTH)
                          .map((entry, index) => (
                            <li
                              key={`${task.id}-activity-${index}`}
                              className="card-activity-entry"
                            >
                              {entry}
                            </li>
                          ))}
                      </ul>
                    )}
                  </article>
                );
              })
            )}
          </div>
        );
      })}
    </section>
  );
}
