import { describe, it, expect } from 'vitest';
import { popTabHistory } from '../../src/renderer/src/services/tabHistory';

describe('popTabHistory (Escape key: "go back to the previous screen")', () => {
  it('pops straight to the previous tab', () => {
    // 'people' (the current tab) and then 'albums' (the previous tab) both come off the stack —
    // the previous tab is returned separately so the caller can navigate to it; App.tsx's own
    // effect pushes it back on once `activeTab` actually changes to match.
    const { previousTab, nextHistory } = popTabHistory(['photos', 'albums', 'people'], 'people', 'photos');
    expect(previousTab).toBe('albums');
    expect(nextHistory).toEqual(['photos']);
  });

  it('dedupes a run of the current tab at the top before popping to the real previous one', () => {
    // can happen when something other than a tab click set activeTab back to a tab that was
    // already the top of the stack (e.g. a library switch landing back on "photos")
    const { previousTab, nextHistory } = popTabHistory(['photos', 'albums', 'photos', 'photos'], 'photos', 'photos');
    expect(previousTab).toBe('albums');
    expect(nextHistory).toEqual(['photos']);
  });

  it('falls back when the stack only ever had the current tab in it', () => {
    const { previousTab, nextHistory } = popTabHistory(['settings', 'settings'], 'settings', 'photos');
    expect(previousTab).toBe('photos');
    expect(nextHistory).toEqual([]);
  });

  it('falls back on a genuinely empty stack without throwing', () => {
    const { previousTab, nextHistory } = popTabHistory([], 'settings', 'photos');
    expect(previousTab).toBe('photos');
    expect(nextHistory).toEqual([]);
  });

  it('does not mutate the array it was given', () => {
    const history = ['photos', 'albums', 'people'];
    popTabHistory(history, 'people', 'photos');
    expect(history).toEqual(['photos', 'albums', 'people']);
  });

  it('a longer back-and-forth history pops one tab at a time, most-recent first', () => {
    let history = ['photos', 'albums', 'people', 'settings'];
    let r = popTabHistory(history, 'settings', 'photos');
    expect(r.previousTab).toBe('people');
    history = r.nextHistory;
    r = popTabHistory(history, 'people', 'photos');
    expect(r.previousTab).toBe('albums');
    history = r.nextHistory;
    r = popTabHistory(history, 'albums', 'photos');
    expect(r.previousTab).toBe('photos');
  });
});
