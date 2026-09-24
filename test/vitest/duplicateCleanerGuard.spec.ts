// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DuplicateCleanerModal } from '../../src/renderer/src/components/DuplicateCleanerModal';

// Regression: the Photos toolbar's "Clean Duplicates" button was wired as
// onClick={onOpenDuplicateCleaner}, so the click EVENT arrived as the `cluster`
// argument, got stored as the initial cluster, and the modal crashed the whole
// app reading `c.photos.length` (TypeError ... reading 'length').
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('DuplicateCleanerModal tolerates a bogus initialCluster (e.g. a click event)', () => {
  const render = (initialCluster: any) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(DuplicateCleanerModal, { photos: [], onClose: () => {}, initialCluster } as any));
    });
    return { container, root };
  };

  it('does not throw for a MouseEvent-like object and shows the normal empty/scan state', () => {
    const fakeEvent = { type: 'click', target: {}, nativeEvent: {}, isTrusted: true };
    let r: ReturnType<typeof render> | undefined;
    expect(() => { r = render(fakeEvent); }).not.toThrow();
    expect(r!.container.textContent!.length).toBeGreaterThan(0);
    act(() => r!.root.unmount());
  });

  it('still accepts a real cluster', () => {
    const photo: any = { id: 'a', filePath: 'C:\a.jpg', fileName: 'a.jpg', fileSize: 10, dateTaken: '2026-01-01T00:00:00Z', year: 2026, month: 1, day: 1 };
    const cluster: any = { id: 'c1', clusterType: 'similar', photos: [photo, { ...photo, id: 'b', fileName: 'b.jpg' }], bestPhotoId: 'a', bestReason: 'test', scores: {} };
    let r: ReturnType<typeof render> | undefined;
    expect(() => { r = render(cluster); }).not.toThrow();
    expect(r!.container.textContent).toContain('2');
    act(() => r!.root.unmount());
  });
});
