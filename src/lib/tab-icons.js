// The Inspector's tab strip and the two fill pickers, as SVG markup strings.
//
// Strings rather than components because they are rendered with `{@html}` into
// buttons that already carry their own state classes - a component per glyph
// would be nine files and a wrapper element each, for line art that never takes
// a prop. Every icon is a 20x20 viewBox drawn in `currentColor`, so a button
// colours its icon by colouring itself.
const wrap = (body) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// A serif "A" with a baseline under it: the letter itself is the tab.
export const iconText = wrap('<path d="M4 15L10 4l6 11"/><path d="M6.4 11.4h7.2"/><path d="M3 17.5h14"/>');

// A paint drop: fill is what the glyph is made of.
export const iconFill = wrap('<path d="M10 3.2c2.6 3 4.6 5.3 4.6 7.6a4.6 4.6 0 1 1-9.2 0c0-2.3 2-4.6 4.6-7.6Z"/>');

// Sparkle: strokes, shadows and roughen are what is done to the glyph after.
export const iconEffects = wrap(
  '<path d="M7 3.5 8.1 6.6 11.2 7.7 8.1 8.8 7 11.9 5.9 8.8 2.8 7.7 5.9 6.6Z"/><path d="M14 10.5 14.8 12.7 17 13.5 14.8 14.3 14 16.5 13.2 14.3 11 13.5 13.2 12.7Z"/>',
);

// A frame with its measure marks: position, size, spacing.
export const iconLayout = wrap('<rect x="3" y="4.5" width="14" height="11" rx="1.5"/><path d="M3 9h14"/><path d="M8 9v6.5"/>');

// The rotation control's own glyph: an arc with an arrowhead.
export const iconRotate = wrap(
  '<path d="M16.5 10a6.5 6.5 0 1 1-2.4-5"/><path d="M16.6 2.2v3.3h-3.3"/>',
);

// Linear gradient: a swatch with a diagonal ramp through it.
export const iconGradientLinear = wrap(
  '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M4.5 15.5 15.5 4.5" stroke-width="1.2"/><path d="M7.5 16.5 16.5 7.5" stroke-width="1.2"/><path d="M3.5 12.5 12.5 3.5" stroke-width="1.2"/>',
);

// No fill: an empty swatch struck through, the mark every paint program uses.
export const iconNoFill = wrap(
  '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M4.2 15.8 15.8 4.2"/>',
);

// Radial gradient: rings out from a centre.
export const iconGradientRadial = wrap(
  '<rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="10" cy="10" r="1.4"/><circle cx="10" cy="10" r="4.4" stroke-width="1.2"/>',
);

// Pattern: a tile of dots.
export const iconPattern = wrap(
  '<rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="7.2" cy="7.2" r="1.1"/><circle cx="12.8" cy="7.2" r="1.1"/><circle cx="7.2" cy="12.8" r="1.1"/><circle cx="12.8" cy="12.8" r="1.1"/>',
);

// An arrow pointing UP, which the direction pad rotates for the other seven.
export const iconArrowUp = wrap('<path d="M10 16V4.6"/><path d="M5.6 9 10 4.4 14.4 9"/>');

export const tabIcons = {
  text: iconText,
  fill: iconFill,
  effects: iconEffects,
  layout: iconLayout,
};

// Double ring (outer circle and inner circle): an outlined glyph.
export const iconEffectStroke = wrap('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="3.5"/>');

// Two overlapping rounded rects offset diagonally: shadow cast behind.
export const iconEffectShadow = wrap(
  '<rect x="7" y="7" width="9" height="9" rx="1.5" stroke-dasharray="2 2"/><rect x="4" y="4" width="9" height="9" rx="1.5"/>',
);

// S-curve path with control anchor dots at the ends.
export const iconEffectWarp = wrap(
  '<path d="M3 13c3.5-6 6-6 8.5-3s5 3 5.5-3"/><circle cx="3" cy="13" r="1" fill="currentColor"/><circle cx="17" cy="7" r="1" fill="currentColor"/>',
);

// A quad pulled out of square with a dot on each corner: the free-transform
// mesh and its handles. Deliberately unlike the S-curve above - `warp` is the
// arc/circle/path group and `transform` is the mesh, and the two icons sit next
// to each other in the strip.
export const iconEffectTransform = wrap(
  '<path d="M4 6.5 16 4l1 10.5L6 16.5Z"/><circle cx="4" cy="6.5" r="1.4" fill="currentColor"/><circle cx="16" cy="4" r="1.4" fill="currentColor"/><circle cx="17" cy="14.5" r="1.4" fill="currentColor"/><circle cx="6" cy="16.5" r="1.4" fill="currentColor"/>',
);

// A circle with a bent line through it: the round liquify tool over a mesh.
export const iconEffectLiquify = wrap(
  '<circle cx="10" cy="10" r="6.5" stroke-dasharray="2.5 2"/><path d="M3.5 12c2.5-4 4.5-4 6.5 0s4 4 6.5 0"/>',
);

// Three horizontal speed lines of varying lengths: motion smear / blur.
export const iconEffectBlur = wrap('<path d="M3 7h9"/><path d="M5 10.5h11"/><path d="M3 14h7"/>');

// A jagged zigzag stroke: rough / distressed edge.
export const iconEffectEdges = wrap('<path d="M3 12l2.5-3 2 3 2.5-4 2 4 2.5-3 2 3"/>');

// A circle partly overlapping a rect: balloon / mask clip.
export const iconEffectMask = wrap('<rect x="3" y="5" width="10" height="10" rx="1.5"/><circle cx="13" cy="9" r="4.5"/>');

// Three letters-like bars, each one higher than the last: lettering whose
// letters step up the line.
export const iconEffectSfx = wrap('<path d="M4.5 16v-3.5"/><path d="M10 16V9.5"/><path d="M15.5 16V5"/>');

export const effectsSubTabIcons = {
  sfx: iconEffectSfx,
  stroke: iconEffectStroke,
  shadow: iconEffectShadow,
  warp: iconEffectWarp,
  transform: iconEffectTransform,
  liquify: iconEffectLiquify,
  blur: iconEffectBlur,
  edges: iconEffectEdges,
  mask: iconEffectMask,
};


// ---- the brush panel's tabs ----
//
// Icon-only, the whole reason the panel can afford five: a label per tab
// truncated to "DYNA..." at the panel's width, and an icon does not.

// A sheet with a stroke on it: the board.
export const iconBrushBoard = wrap(
  '<rect x="3" y="3.5" width="14" height="13" rx="1.5"/><path d="M6 12.5c1.5-3.5 3-4.5 4.5-2.5s2.5 1.5 3.5-2"/>',
);

// A brush: handle, ferrule, tip.
export const iconBrushTip = wrap(
  '<path d="M16.5 3.5 9 11"/><path d="M11 9l-1.8 3.2a2.4 2.4 0 1 1-3.4-3.4L9 7"/><path d="M4 16.5c1.5 0 2.5-.6 3-1.7"/>',
);

// A tip seen head-on, with its angle: shape.
export const iconBrushShape = wrap(
  '<ellipse cx="10" cy="10" rx="6.5" ry="4" transform="rotate(-30 10 10)"/><path d="M10 10l5-3"/>',
);

// A stroke that thins: dynamics.
export const iconBrushDynamics = wrap(
  '<path d="M3 13.5c2.5-.5 3.5-5 6.5-5.5" stroke-width="2.8"/><path d="M9.5 8c2.5-.4 4.5 3.5 7.5 3" stroke-width="1.1"/>',
);

// A shaky line beside a straight one: correction.
export const iconBrushCorrection = wrap(
  '<path d="M4 14.5c1-1.5 1.5 1 2.5-.5s1.5 1 2.5-.5 1.5 1 2.5-.5"/><path d="M4 8h12"/><path d="M13 5.5 16 8l-3 2.5"/>',
);

// A dot with a ring around it: the finish, an outline around the whole.
export const iconBrushFinish = wrap(
  '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3.2" fill="currentColor" stroke="none"/>',
);

export const brushTabIcons = {
  board: iconBrushBoard,
  brush: iconBrushTip,
  shape: iconBrushShape,
  dynamics: iconBrushDynamics,
  correction: iconBrushCorrection,
  finish: iconBrushFinish,
};
