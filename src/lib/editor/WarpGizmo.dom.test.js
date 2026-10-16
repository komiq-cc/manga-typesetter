import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import WarpGizmo from './WarpGizmo.svelte';
import { defaultStyle, normalizeStyle } from '../data.js';

// ===========================================================================
// The mesh handles are controls a screen reader can reach
// ===========================================================================
// They are in the tab order, so they must be in the accessibility tree too:
// `aria-hidden` on any ancestor takes a focusable control out of it, whatever
// the control says about itself. Only the drawing - the ghost outline and the
// hairlines - is hidden.

afterEach(() => cleanup());

it('hides the drawing and none of the handles', async () => {
  const box = {
    id: 'b', x: 0, y: 0, w: 200, h: 100,
    style: normalizeStyle({ ...defaultStyle(), warp: { on: true, cols: 1, rows: 1, pts: [] } }),
  };
  const view = render(WarpGizmo, { box, pageId: 1, z: 1, toLocal: () => [0, 0] });
  await tick();
  const handles = [...view.container.querySelectorAll('[data-warp-handle]')];
  expect(handles).toHaveLength(4);
  for (const h of handles) {
    expect(h.closest('[aria-hidden="true"]'), h.getAttribute('aria-label')).toBe(null);
    expect(h.getAttribute('role')).toBe('button');
    expect(h.getAttribute('aria-label')).toMatch(/^Mesh handle column \d, row \d\./);
  }
  const drawing = view.container.querySelectorAll('svg.warp-gizmo > :is(polygon, polyline)');
  expect(drawing.length).toBeGreaterThan(0);
  for (const el of drawing) expect(el.getAttribute('aria-hidden')).toBe('true');
});
