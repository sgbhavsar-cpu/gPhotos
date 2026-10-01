// The Escape key's "go back to the previous screen" logic, pulled out of App.tsx so the actual
// stack math — not just "does App.tsx render" — has its own test (mounting the whole App is its
// own much bigger undertaking, with no existing harness for it).

/**
 * Given the tab-visit history stack and the tab currently showing, returns which tab Escape
 * should go back to, and the stack with that pop applied.
 *
 * Dedupes trailing entries equal to the current tab first — switching tabs pushes onto the stack
 * only when it actually changes (see App.tsx's effect that maintains it), but a tab can still end
 * up repeated at the top if something else (e.g. a library switch) set `activeTab` back to a tab
 * that was already the top of the stack. Falls back to `fallback` once the stack is empty, rather
 * than returning `undefined` and leaving Escape with nowhere to go.
 */
export function popTabHistory<T>(history: T[], currentTab: T, fallback: T): { previousTab: T; nextHistory: T[] } {
  const next = [...history];
  while (next.length > 0 && next[next.length - 1] === currentTab) next.pop();
  const previousTab = next.length > 0 ? next.pop()! : fallback;
  return { previousTab, nextHistory: next };
}
