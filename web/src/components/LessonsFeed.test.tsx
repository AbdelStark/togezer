/**
 * LessonsFeed: order preservation (newest-first as passed), badge classes
 * distinguishing pitfalls from lessons, timestamps, and the empty state.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Lesson } from '../types';
import { LessonsFeed } from './LessonsFeed';

const AT = '2025-01-01T00:00:00.000Z';

function makeLesson(id: string, content: string, createdAt = AT): Lesson {
  return { id, content, sourceTaskId: 't1', createdAt };
}

describe('LessonsFeed', () => {
  it('renders entries in the given (newest-first) order with timestamps', () => {
    const lessons = [
      makeLesson('l2', 'Lesson from t9: cache the parsed snapshot', '2025-01-02T00:00:00.000Z'),
      makeLesson('l1', 'Lesson from t4: seed stores keep reference equality'),
    ];
    render(<LessonsFeed lessons={lessons} />);

    const entries = screen.getAllByTestId('lesson-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent(
      'Lesson from t9: cache the parsed snapshot',
    );
    expect(entries[1]).toHaveTextContent(
      'Lesson from t4: seed stores keep reference equality',
    );
    expect(
      within(entries[0]).getByText('2025-01-02T00:00:00.000Z'),
    ).toBeInTheDocument();
  });

  it('badges "Pitfall from" entries with badge-pitfall and others with badge-lesson', () => {
    const lessons = [
      makeLesson('l3', 'Pitfall from t7: never trust unvalidated input'),
      makeLesson('l4', 'Lesson from t6: prefer structural equality'),
    ];
    render(<LessonsFeed lessons={lessons} />);

    const entries = screen.getAllByTestId('lesson-entry');
    expect(entries[0].querySelector('.badge-pitfall')).not.toBeNull();
    expect(
      entries[0].querySelector('.badge-pitfall')?.textContent,
    ).toContain('Pitfall from t7');
    expect(entries[0].querySelector('.badge-lesson')).toBeNull();

    expect(entries[1].querySelector('.badge-lesson')).not.toBeNull();
    expect(entries[1].querySelector('.badge-pitfall')).toBeNull();
  });

  it('renders the empty state with no entries', () => {
    render(<LessonsFeed lessons={[]} />);

    expect(screen.getByTestId('lessons-feed')).toBeInTheDocument();
    expect(screen.getByText('No lessons banked yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('lesson-entry')).not.toBeInTheDocument();
  });
});
