// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Same Leaflet stand-in as locationPickerGoogleMapsUrl.spec.ts — this test exercises the
// BulkEditModal <-> LocationPickerModal integration, not Leaflet's own rendering.
const fakeMap = { on: vi.fn(), remove: vi.fn(), flyTo: vi.fn() };
const fakeMarker: any = { setLatLng: vi.fn(), on: vi.fn(), getLatLng: () => ({ lat: 0, lng: 0 }) };
fakeMarker.addTo = vi.fn(() => fakeMarker);
vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => fakeMap),
    control: { zoom: vi.fn(() => ({ addTo: vi.fn() })) },
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    marker: vi.fn(() => fakeMarker),
    divIcon: vi.fn(() => ({})),
  },
}));

import { BulkEditModal } from '../../src/renderer/src/components/BulkEditModal';

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

// Reported bug: pin a location on the map, type a name there, click "Use This Location" — the name
// typed in the map's own popup never made it back into this (the "previous") popup's text box, and
// "Apply" stayed enabled regardless. Fixed by requiring a name before the map popup's own confirm
// button is even clickable (see locationPickerGoogleMapsUrl.spec.ts) — which, as a side effect, also
// guarantees the name this popup receives back is never empty.
describe('BulkEditModal: the location name picked on the map comes back into this popup', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mount = () => {
    act(() => root.render(React.createElement(BulkEditModal, { photos: [photo(1), photo(2)], onClose: vi.fn() })));
  };
  const byText = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const locationInput = () => host.querySelector('input[placeholder*="Paris"]') as HTMLInputElement;
  const applyButton = () => byText('Apply to');
  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('pinning a location on the map and naming it there fills this popup\'s own location box, and enables Apply', async () => {
    mount();

    // Turn on "Set Location" (its checkbox, found by the label text it sits in).
    const setLocationLabel = Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.includes('Set Location'))!;
    const setLocationCheckbox = setLocationLabel.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { setLocationCheckbox.click(); });

    expect(locationInput().value).toBe(''); // nothing typed yet, so Apply must not be live
    expect(applyButton().disabled).toBe(true);

    await act(async () => { byText('Pin on Map').click(); });

    const urlInput = host.querySelector('[data-testid="maps-url-input"]') as HTMLInputElement;
    const useLinkBtn = host.querySelector('[data-testid="maps-url-use"]') as HTMLButtonElement;
    const mapLabelInput = host.querySelector('[data-testid="location-label-input"]') as HTMLInputElement;
    const confirmBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Use This Location')) as HTMLButtonElement;

    typeInto(urlInput, 'https://www.google.com/maps/@24.5713934,73.6905743,15z');
    await act(async () => { useLinkBtn.click(); });
    expect(confirmBtn.disabled).toBe(true); // pinned, but not named yet

    typeInto(mapLabelInput, "Lake Palace");
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => { confirmBtn.click(); });

    // The map popup is gone, and the name typed there is now in THIS popup's own text box.
    expect(host.querySelector('[data-testid="location-label-input"]')).toBeNull();
    expect(locationInput().value).toBe('Lake Palace');
    expect(host.textContent).toContain('Pinned at 24.57139');
    expect(applyButton().disabled).toBe(false);
  });
});
