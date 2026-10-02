// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Leaflet does real DOM measurement/tile loading that jsdom can't do — stand in for just what the
// component calls, so the test exercises the new Maps-URL/label behaviour, not Leaflet's own rendering.
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

import { LocationPickerModal } from '../../src/renderer/src/components/LocationPickerModal';

describe('LocationPickerModal: paste a Google Maps link for exact coordinates', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mount = (props: Partial<React.ComponentProps<typeof LocationPickerModal>> = {}) => {
    act(() => root.render(React.createElement(LocationPickerModal, { onConfirm: vi.fn(), onClose: vi.fn(), ...props })));
  };
  const urlInput = () => host.querySelector('[data-testid="maps-url-input"]') as HTMLInputElement;
  const useLinkBtn = () => host.querySelector('[data-testid="maps-url-use"]') as HTMLButtonElement;
  const searchOnGoogleMapsBtn = () => host.querySelector('[data-testid="open-google-maps"]') as HTMLButtonElement;
  const labelInput = () => host.querySelector('[data-testid="location-label-input"]') as HTMLInputElement;
  const confirmBtn = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Use This Location')) as HTMLButtonElement;
  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('a full Google Maps link places the pin at its exact coordinates, but confirm needs a name too', async () => {
    mount();
    typeInto(urlInput(), 'https://www.google.com/maps/@24.5713934,73.6905743,15z');
    await act(async () => { useLinkBtn().click(); });
    expect(host.textContent).toContain('24.57139');
    expect(host.textContent).toContain('73.69057');
    expect(confirmBtn().disabled).toBe(true); // a pin alone isn't enough — no name yet
    expect(fakeMap.flyTo).toHaveBeenCalledWith([24.5713934, 73.6905743], 16, expect.any(Object));
    typeInto(labelInput(), 'Lake Palace');
    expect(confirmBtn().disabled).toBe(false);
  });

  it('prefers the precise place marker (!3d!4d) over the map\'s own pan/zoom center', async () => {
    mount();
    typeInto(urlInput(), 'https://www.google.com/maps/place/Lake+Palace/@24.5757,73.6802,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d24.575699!4d73.680278');
    await act(async () => { useLinkBtn().click(); });
    expect(host.textContent).toContain('24.57570'); // the !3d value, not the @24.5757 center
  });

  it('a non-Google URL is rejected with a clear message and no pin is placed', async () => {
    mount();
    typeInto(urlInput(), 'https://www.bing.com/maps?q=24.57,73.69');
    await act(async () => { useLinkBtn().click(); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Maps link');
    expect(confirmBtn().disabled).toBe(true);
  });

  it('a Google Maps link with no coordinates in it gives a clear, actionable error', async () => {
    mount();
    typeInto(urlInput(), 'https://www.google.com/maps/place/Somewhere/');
    await act(async () => { useLinkBtn().click(); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Could not find coordinates');
  });

  it('a shortened link is resolved through the desktop app, then parsed', async () => {
    (window as any).electronAPI = {
      resolveMapsUrl: vi.fn(async () => ({ ok: true, resolvedUrl: 'https://www.google.com/maps/@12.34,56.78,10z' })),
    };
    mount();
    typeInto(urlInput(), 'https://maps.app.goo.gl/abc123');
    await act(async () => { useLinkBtn().click(); });
    expect((window as any).electronAPI.resolveMapsUrl).toHaveBeenCalledWith('https://maps.app.goo.gl/abc123');
    expect(host.textContent).toContain('12.34000');
  });

  it('a shortened link with no desktop bridge available explains why it can\'t be used', async () => {
    mount(); // no window.electronAPI at all
    typeInto(urlInput(), 'https://maps.app.goo.gl/abc123');
    await act(async () => { useLinkBtn().click(); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('desktop app');
  });

  it('a failed resolution (bad/expired link) shows the reason instead of silently doing nothing', async () => {
    (window as any).electronAPI = { resolveMapsUrl: vi.fn(async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND' })) };
    mount();
    typeInto(urlInput(), 'https://maps.app.goo.gl/dead');
    await act(async () => { useLinkBtn().click(); });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('ENOTFOUND');
  });

  it('Enter in the URL field works the same as clicking "Use Link"', async () => {
    mount();
    typeInto(urlInput(), 'https://www.google.com/maps/@1.5,2.5,15z');
    await act(async () => { urlInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(host.textContent).toContain('1.50000');
  });

  it('the label field is pre-filled from initialLabel, editable, and sent to onConfirm', async () => {
    const onConfirm = vi.fn();
    mount({ initialLat: 24.5, initialLng: 73.6, initialLabel: 'Old Label', onConfirm });
    expect(labelInput().value).toBe('Old Label');
    typeInto(labelInput(), "Grandma's House");
    await act(async () => { confirmBtn().click(); });
    expect(onConfirm).toHaveBeenCalledWith(24.5, 73.6, "Grandma's House");
  });

  it('the label can be set independently of how the pin was placed (via a pasted link)', async () => {
    const onConfirm = vi.fn();
    mount({ onConfirm });
    typeInto(urlInput(), 'https://www.google.com/maps/@24.57,73.69,15z');
    await act(async () => { useLinkBtn().click(); });
    typeInto(labelInput(), 'Lake Palace');
    await act(async () => { confirmBtn().click(); });
    expect(onConfirm).toHaveBeenCalledWith(24.57, 73.69, 'Lake Palace');
  });

  describe('a pin with no name: disabled confirm + a clear indication', () => {
    it('shows a warning once a pin exists but no name has been typed yet, and clears it once one is', async () => {
      mount();
      expect(host.querySelector('[role="alert"]')).toBeNull(); // nothing to warn about before any pin exists
      typeInto(urlInput(), 'https://www.google.com/maps/@24.57,73.69,15z');
      await act(async () => { useLinkBtn().click(); });
      expect(confirmBtn().disabled).toBe(true);
      const warning = host.querySelector('[role="alert"]');
      expect(warning).not.toBeNull();
      expect(warning!.textContent).toMatch(/add a name/i);

      typeInto(labelInput(), 'Lake Palace');
      expect(confirmBtn().disabled).toBe(false);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('clicking the disabled confirm button never calls onConfirm', async () => {
      const onConfirm = vi.fn();
      mount({ onConfirm });
      typeInto(urlInput(), 'https://www.google.com/maps/@24.57,73.69,15z');
      await act(async () => { useLinkBtn().click(); });
      await act(async () => { confirmBtn().click(); });
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('whitespace-only text does not count as a name', async () => {
      mount();
      typeInto(urlInput(), 'https://www.google.com/maps/@24.57,73.69,15z');
      await act(async () => { useLinkBtn().click(); });
      typeInto(labelInput(), '   ');
      expect(confirmBtn().disabled).toBe(true);
    });

    it('an existing (pre-filled) label already satisfies the requirement — no warning on open', async () => {
      mount({ initialLat: 24.5, initialLng: 73.6, initialLabel: 'Old Label' });
      expect(confirmBtn().disabled).toBe(false);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });

  describe('"Search on Google Maps" — opens a browser search for the current name', () => {
    it('is disabled until a name is typed', async () => {
      mount();
      expect(searchOnGoogleMapsBtn().disabled).toBe(true);
      typeInto(labelInput(), 'Lake Palace');
      expect(searchOnGoogleMapsBtn().disabled).toBe(false);
    });

    it('opens Google Maps search for the current name via the desktop bridge when available', async () => {
      const openExternal = vi.fn(async () => true);
      (window as any).electronAPI = { openExternal };
      mount({ initialLabel: 'Lake Palace' });
      await act(async () => { searchOnGoogleMapsBtn().click(); });
      expect(openExternal).toHaveBeenCalledWith('https://www.google.com/maps/search/?api=1&query=Lake%20Palace');
    });

    it('falls back to window.open when no desktop bridge is available', async () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      mount({ initialLabel: "Grandma's House" });
      await act(async () => { searchOnGoogleMapsBtn().click(); });
      expect(openSpy).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent("Grandma's House")), '_blank');
      openSpy.mockRestore();
    });
  });
});
