/**
 * Controlled form for submitting a goal: one text input plus a submit
 * button. Submitting is disabled while the trimmed input is empty or a
 * request is in flight. Server rejections (e.g. a 400 "goal text is
 * required") surface verbatim in a role="alert" element.
 */
import { useState, type FormEvent } from 'react';

interface GoalFormProps {
  /** Async submit handler (App wires postGoal here). Rejects surface as errors. */
  onSubmit: (text: string) => Promise<unknown>;
}

export function GoalForm({ onSubmit }: GoalFormProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const disabled = submitting || trimmed === '';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      // Success: reset the form and clear any prior error.
      setText('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form data-testid="goal-form" className="goal-form" onSubmit={handleSubmit}>
      <h2 className="goal-form-header">New goal</h2>
      <input
        data-testid="goal-input"
        className="goal-input"
        type="text"
        value={text}
        aria-label="Goal text"
        placeholder="Describe a goal for the team..."
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="submit"
        data-testid="goal-submit"
        className="goal-submit"
        disabled={disabled}
      >
        {submitting ? 'Submitting...' : 'Submit goal'}
      </button>
      {error !== null && (
        <p role="alert" data-testid="goal-error" className="goal-error">
          {error}
        </p>
      )}
    </form>
  );
}
