import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ColorPicker from './ColorPicker.svelte';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

/** Run `fn` as the Tauri app on a platform whose `navigator.platform` is `platform`. */
async function asTauriOn(platform, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform');
  Object.defineProperty(globalThis.navigator, 'platform', { value: platform, configurable: true });
  window.__TAURI_INTERNALS__ = {};
  try {
    await fn();
  } finally {
    delete window.__TAURI_INTERNALS__;
    if (saved) Object.defineProperty(globalThis.navigator, 'platform', saved);
    else delete (/** @type {any} */ (globalThis.navigator)).platform;
  }
}

it('places a portaled picker above a low trigger and keeps panel controls active', async () => {
  const onchange = vi.fn();
  const view = render(ColorPicker, { props: { value: '#ffffff', label: 'Fill colour', unclipped: true, onchange } });
  const trigger = view.getByRole('button', { name: 'Fill colour' });
  const anchor = trigger.parentElement;
  const oldRect = anchor.getBoundingClientRect;
  anchor.getBoundingClientRect = () =>
    /** @type {DOMRect} */ ({ left: 600, right: 626, top: 430, bottom: 456, width: 26, height: 26, x: 600, y: 430, toJSON() {} });
  const previous = { w: globalThis.innerWidth, h: globalThis.innerHeight };
  globalThis.innerWidth = 640;
  globalThis.innerHeight = 480;
  try {
    await fireEvent.click(trigger);
    await tick();
    const panel = screen.getByRole('dialog', { name: 'Fill colour' });
    expect(panel.parentElement).toBe(document.body);
    // jsdom lays nothing out, so the panel is placed from its fallback size
    // (236 x 330): pushed left off the right edge, and above the trigger
    // because there is no room below it.
    expect(panel.style.left).toBe('396px');
    expect(panel.style.top).toBe('92px');
    await fireEvent.pointerDown(panel);
    expect(screen.getByRole('dialog', { name: 'Fill colour' })).toBe(panel);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Hex' }), { target: { value: '#123456' } });
    expect(onchange).toHaveBeenCalledWith('#123456');
    await view.rerender({ value: '#123456', label: 'Fill colour', unclipped: false, onchange });
    expect(anchor.contains(panel)).toBe(true);
    await view.rerender({ value: '#123456', label: 'Fill colour', unclipped: true, onchange });
    expect(panel.parentElement).toBe(document.body);
  } finally {
    anchor.getBoundingClientRect = oldRect;
    globalThis.innerWidth = previous.w;
    globalThis.innerHeight = previous.h;
  }
});

it('closes on an outside press and on Escape, and a WebKit focusout with no target does not close it', async () => {
  const view = render(ColorPicker, { props: { value: '#336699', label: 'Fill colour', unclipped: true, onchange: vi.fn() } });
  const trigger = view.getByRole('button', { name: 'Fill colour' });

  await fireEvent.click(trigger);
  const panel = screen.getByRole('dialog', { name: 'Fill colour' });
  await fireEvent.focusOut(panel, { relatedTarget: null });
  expect(screen.queryByRole('dialog')).not.toBeNull();
  await fireEvent.keyDown(panel, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();

  await fireEvent.click(trigger);
  await fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('steps the square with the arrows without letting the key reach the editor', async () => {
  const onchange = vi.fn();
  const onWindowKey = vi.fn();
  window.addEventListener('keydown', onWindowKey);
  try {
    const view = render(ColorPicker, { props: { value: '#ff0000', label: 'Fill colour', unclipped: true, onchange } });
    await fireEvent.click(view.getByRole('button', { name: 'Fill colour' }));
    const square = screen.getByRole('slider', { name: 'Saturation and brightness' });
    await fireEvent.keyDown(square, { key: 'ArrowDown', shiftKey: true });
    expect(onchange).toHaveBeenLastCalledWith('#e60000');
    await fireEvent.keyDown(screen.getByRole('slider', { name: 'Hue' }), { key: 'ArrowDown' });
    expect(onchange).toHaveBeenCalledTimes(2);
    expect(onWindowKey).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', onWindowKey);
  }
});

it('samples the screen through the native command in the macOS app, where there is no EyeDropper', async () => {
  invoke.mockResolvedValue('#1A2B3C');
  await asTauriOn('MacIntel', async () => {
    const onchange = vi.fn();
    const view = render(ColorPicker, { props: { value: '#ffffff', label: 'Fill colour', onchange } });
    await fireEvent.click(view.getByRole('button', { name: 'Fill colour' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Pick a colour from the screen' }));
    await vi.waitFor(() => expect(onchange).toHaveBeenCalledWith('#1a2b3c'));
    expect(invoke).toHaveBeenCalledWith('pick_screen_color');
  });
});

it('leaves the value alone when the sampler is dismissed with Escape', async () => {
  invoke.mockResolvedValue(null);
  await asTauriOn('MacIntel', async () => {
    const onchange = vi.fn();
    const view = render(ColorPicker, { props: { value: '#ffffff', label: 'Fill colour', onchange } });
    await fireEvent.click(view.getByRole('button', { name: 'Fill colour' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Pick a colour from the screen' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    await tick();
    expect(onchange).not.toHaveBeenCalled();
  });
});

it('draws no eyedropper where the screen cannot be sampled', async () => {
  // jsdom has no EyeDropper, and outside Tauri there is no native command -
  // which is also the Linux app's case, where the command is never offered.
  expect(globalThis.EyeDropper).toBeUndefined();
  const view = render(ColorPicker, { props: { value: '#ffffff', label: 'Fill colour', onchange: vi.fn() } });
  await fireEvent.click(view.getByRole('button', { name: 'Fill colour' }));
  expect(screen.getByRole('dialog', { name: 'Fill colour' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pick a colour from the screen' })).toBeNull();
});

it('draws no eyedropper in the Linux app', async () => {
  await asTauriOn('Linux x86_64', async () => {
    const view = render(ColorPicker, { props: { value: '#ffffff', label: 'Fill colour', onchange: vi.fn() } });
    await fireEvent.click(view.getByRole('button', { name: 'Fill colour' }));
    expect(screen.queryByRole('button', { name: 'Pick a colour from the screen' })).toBeNull();
  });
});
