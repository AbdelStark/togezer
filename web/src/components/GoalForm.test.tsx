/**
 * GoalForm behaviour: empty/whitespace gating, trimmed submission, server
 * error surfacing via role="alert", and the in-flight disabled state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GoalForm } from './GoalForm';

describe('GoalForm', () => {
  it('disables submit while the input is empty or whitespace only', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<GoalForm onSubmit={onSubmit} />);

    const input = screen.getByTestId('goal-input');
    const submit = screen.getByTestId('goal-submit');

    expect(submit).toBeDisabled();

    await user.type(input, '   ');
    expect(submit).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('enables submit with text and passes the trimmed text, clearing the input on success', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<GoalForm onSubmit={onSubmit} />);

    const input = screen.getByTestId('goal-input');
    const submit = screen.getByTestId('goal-submit');

    await user.type(input, '  ship the realtime dashboard  ');
    expect(submit).toBeEnabled();

    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('ship the realtime dashboard');
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByTestId('goal-error')).not.toBeInTheDocument();
    // No longer in flight (label restored); disabled again because the input
    // was reset to empty.
    expect(submit).toHaveTextContent('Submit goal');
    expect(submit).toBeDisabled();
  });

  it('submits on Enter keypress in the input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<GoalForm onSubmit={onSubmit} />);

    const input = screen.getByTestId('goal-input');
    await user.type(input, 'enter-submitted goal');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('enter-submitted goal');
  });

  it('renders a rejected submit error message verbatim in a role=alert element', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() =>
      Promise.reject(new Error('goal text is required')),
    );
    render(<GoalForm onSubmit={onSubmit} />);

    const input = screen.getByTestId('goal-input');
    await user.type(input, 'a goal that will be rejected');
    await user.click(screen.getByTestId('goal-submit'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('goal text is required');
    expect(screen.getByTestId('goal-error')).toBeInTheDocument();
    // A failed submit keeps the user's text so it can be corrected.
    expect(input).toHaveValue('a goal that will be rejected');
  });

  it('shows the in-flight disabled state while the submit promise is pending', async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: unknown) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<GoalForm onSubmit={onSubmit} />);

    await user.type(screen.getByTestId('goal-input'), 'pending goal');
    await user.click(screen.getByTestId('goal-submit'));

    const submit = screen.getByTestId('goal-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    // The in-flight state is visible on the button itself.
    expect(submit).toHaveTextContent('Submitting...');

    resolveSubmit(undefined);
    await waitFor(() => expect(submit).toHaveTextContent('Submit goal'));
    expect(screen.getByTestId('goal-input')).toHaveValue('');
    // With the input cleared, the empty-input gate keeps it disabled.
    expect(submit).toBeDisabled();
  });
});
