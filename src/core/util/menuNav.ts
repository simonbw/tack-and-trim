/**
 * Menu navigation helpers that use real DOM focus as the selection model.
 *
 * Menus built on this approach get:
 * - Click and keyboard Enter/Space unified (browser fires click on focused
 *   button for Enter/Space automatically — no separate code path).
 * - Selection highlight via `:focus-visible` CSS (no `--selected` class state).
 * - A single source of truth: whichever element has focus is the selection.
 *
 * Arrow key navigation still needs to be wired up manually because the
 * browser doesn't move focus between sibling buttons on its own.
 */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}

/**
 * Moves focus to the next (delta=+1) or previous (delta=-1) focusable
 * element inside `container`, wrapping at the ends. If nothing inside
 * the container is currently focused, focuses the first (delta>0) or
 * last (delta<0) element.
 */
export function moveFocus(container: HTMLElement, delta: number): void {
  const items = getFocusable(container);
  if (items.length === 0) return;
  const current = document.activeElement as HTMLElement | null;
  const idx = current ? items.indexOf(current) : -1;
  const next =
    idx < 0
      ? delta > 0
        ? 0
        : items.length - 1
      : (idx + delta + items.length) % items.length;
  items[next]?.focus();
}

/** Focus the first focusable element inside `container`, if any. */
export function focusFirst(container: HTMLElement): void {
  getFocusable(container)[0]?.focus();
}

/** Returns the index of the currently focused focusable child of `container`, or -1. */
export function getFocusedIndex(container: HTMLElement): number {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return -1;
  return getFocusable(container).indexOf(active);
}
