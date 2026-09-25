/**
 * Live feed of banked lessons, newest-first (the store already prepends on
 * lesson.created). Entries whose content starts with 'Pitfall from' get a
 * distinct pitfall badge; other lessons get the plain lesson badge.
 */
import type { Lesson } from '../types';

interface LessonsFeedProps {
  /** Ordered lessons, newest first. */
  lessons: Lesson[];
}

const PITFALL_PREFIX = 'Pitfall from';

function badgeClass(content: string): string {
  return content.startsWith(PITFALL_PREFIX)
    ? 'badge badge-pitfall'
    : 'badge badge-lesson';
}

/** Stable, deterministic timestamp rendering (ISO 8601 when parseable). */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString();
}

export function LessonsFeed({ lessons }: LessonsFeedProps) {
  return (
    <section data-testid="lessons-feed" className="lessons-feed">
      <h2 className="lessons-feed-header">Lessons</h2>
      {lessons.length === 0 ? (
        <p className="lessons-feed-empty">No lessons banked yet.</p>
      ) : (
        <ul className="lesson-list">
          {lessons.map((lesson) => (
            <li
              key={lesson.id}
              data-testid="lesson-entry"
              className="lesson-entry"
            >
              <span className={badgeClass(lesson.content)}>
                {lesson.content}
              </span>
              <time className="lesson-time" dateTime={lesson.createdAt}>
                {formatTimestamp(lesson.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
