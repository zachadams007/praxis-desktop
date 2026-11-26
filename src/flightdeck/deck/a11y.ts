import type { KeyboardEvent } from 'react';

/** Preserve card layout while giving its button role native keyboard activation.
 * Ignore bubbled keys from nested controls; click uses the very same mouse handler. */
export function activateDeckControl(event: KeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat && event.currentTarget.getAttribute('aria-disabled') !== 'true') {
    event.currentTarget.click();
  }
}
