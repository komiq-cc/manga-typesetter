<script>
  // ===== The colour picker =====
  //
  // A swatch button that opens a popover: a saturation/brightness square, a
  // vertical hue rail, a preview swatch, an eyedropper where the platform can
  // sample the screen, a hex field, and H/S/B and R/G/B number fields. The
  // square and the rail take the arrow keys (Shift for steps of 10).
  //
  // Controlled: `value` in, `onchange(hex)` out, always lowercase #rrggbb. It
  // fires on every change - a drag, a keystroke in a field - so the caller's
  // text or brush follows live, the way the native <input type=color> it
  // replaced did on `input`.
  //
  // `unclipped` renders the popover into <body> at a fixed position, for a
  // trigger that sits in a panel that clips or scrolls - which is every panel
  // this app has. Everything that panel listens for on its own subtree (the
  // Inspector's capture-phase undo snapshot, say) does not see the popover, so
  // the caller's `onchange` must not rely on it.
  import { anchoredOverlay } from './anchored-overlay.svelte.js';
  import { focusable } from './focus.js';
  import {
    clamp,
    hexInvalid,
    hexOnCommit,
    hexOnInput,
    hexToRgb,
    hsbToHex,
    hsbToRgb,
    rgbToHex,
    rgbToHsb,
  } from './color.js';
  import { screenColorPicker } from './screen-color.js';

  /**
   * @type {{
   *   value?: string,
   *   label?: string,
   *   size?: number,
   *   align?: 'start' | 'end',
   *   unclipped?: boolean,
   *   onchange: (hex: string) => void,
   * }}
   */
  let { value = '#ffffff', label = 'Colour', size = 26, align = 'start', unclipped = false, onchange } = $props();

  /** @type {HTMLElement | undefined} */
  let root = $state();
  /** @type {HTMLElement | undefined} */
  let panel = $state();
  let flippedY = $state(false);
  let floating = $state({ x: 0, y: 0 });

  const panelId = $props.id();
  const overlay = anchoredOverlay(
    () => root,
    () => (unclipped ? panel : undefined),
  );
  const open = $derived(overlay.open);

  // For a caller that opens the picker from somewhere other than its swatch -
  // the Inspector's double-click on a gradient stop.
  export function show() {
    overlay.show();
  }

  /** @param {HTMLElement} node @param {boolean} detached */
  function portal(node, detached) {
    const home = document.createComment('colour picker home');
    node.before(home);
    /** @param {boolean} away */
    const move = (away) => {
      if (away) document.body.appendChild(node);
      else home.after(node);
    };
    move(detached);
    return {
      update: move,
      destroy: () => {
        node.remove();
        home.remove();
      },
    };
  }

  let h = $state(0);
  let s = $state(0);
  let b = $state(100);
  let hexText = $state('#ffffff');
  let isEditingHex = $state(false);

  // Follow the incoming value, except the hex text while it is being typed.
  $effect(() => {
    const committed = hexOnCommit(value) ?? '#ffffff';
    if (!isEditingHex) hexText = committed;
    const rgb = hexToRgb(committed);
    if (rgb) takeHsb(rgbToHsb(rgb.r, rgb.g, rgb.b));
  });

  // Grey, white and black have no hue of their own; keeping the current one
  // stops a drag to the square's edge from snapping the rail back to red.
  /** @param {{ h: number, s: number, b: number }} hsb */
  function takeHsb(hsb) {
    if (hsb.s > 0 && hsb.b > 0) h = hsb.h;
    s = hsb.s;
    b = hsb.b;
  }

  $effect(() => {
    if (!open || !unclipped || !root || !panel) return;
    const position = () => {
      const trigger = root.getBoundingClientRect();
      const width = panel.offsetWidth || 236;
      const height = panel.offsetHeight || 330;
      const vw = globalThis.innerWidth || width + 16;
      const vh = globalThis.innerHeight || height + 16;
      const below = trigger.bottom + 8;
      const above = trigger.top - height - 8;
      floating = {
        x: Math.max(8, Math.min(vw - width - 8, align === 'end' ? trigger.right - width : trigger.left)),
        y: below + height <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - height - 8),
      };
    };
    position();
    globalThis.addEventListener?.('resize', position);
    globalThis.addEventListener?.('scroll', position, true);
    return () => {
      globalThis.removeEventListener?.('resize', position);
      globalThis.removeEventListener?.('scroll', position, true);
    };
  });

  const currentRgb = $derived(hsbToRgb(h, s, b));
  const currentHex = $derived(rgbToHex(currentRgb.r, currentRgb.g, currentRgb.b));

  $effect(() => {
    if (!open) {
      flippedY = false;
      isEditingHex = false;
      return;
    }
    const node = panel;
    if (!node) return;
    focusable(node)[0]?.focus();
    const box = node.getBoundingClientRect();
    const vh = globalThis.innerHeight ?? 0;
    flippedY = !!vh && box.bottom > vh - 8 && box.top - box.height > 0;
  });

  /** @type {HTMLDivElement | undefined} */
  let sbArea = $state();
  /** @type {HTMLDivElement | undefined} */
  let hueRail = $state();
  let dragging = $state(/** @type {'sb' | 'hue' | null} */ (null));

  /** @param {string} hex */
  function emitChange(hex) {
    hexText = hex;
    onchange(hex);
  }
  const emitHsb = () => emitChange(hsbToHex(h, s, b));

  /** @param {PointerEvent} event */
  function sbFromPointer(event) {
    if (!sbArea) return;
    const rect = sbArea.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    s = Math.round((x / rect.width) * 100);
    b = Math.round((1 - y / rect.height) * 100);
    emitHsb();
  }

  /** @param {PointerEvent} event */
  function hueFromPointer(event) {
    if (!hueRail) return;
    const rect = hueRail.getBoundingClientRect();
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    h = Math.round((y / rect.height) * 360) % 360;
    emitHsb();
  }

  /**
   * @param {'sb' | 'hue'} which
   * @param {PointerEvent} event
   */
  function onPointerDown(which, event) {
    if (event.button !== 0) return;
    dragging = which;
    /** @type {HTMLElement} */ (event.currentTarget).setPointerCapture?.(event.pointerId);
    (which === 'sb' ? sbFromPointer : hueFromPointer)(event);
  }

  /** @param {'sb' | 'hue'} which @param {PointerEvent} event */
  function onPointerMove(which, event) {
    if (dragging === which) (which === 'sb' ? sbFromPointer : hueFromPointer)(event);
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!dragging) return;
    dragging = null;
    try {
      /** @type {HTMLElement} */ (event.currentTarget).releasePointerCapture?.(event.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  // A handled arrow stops here. The editor reads a bare arrow on the window as
  // "nudge the selected box", and the square is not a text field, so without
  // this every step of the square would also move the box.
  /** @param {KeyboardEvent} event */
  function onSbKeyDown(event) {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') s = clamp(s - step, 0, 100);
    else if (event.key === 'ArrowRight') s = clamp(s + step, 0, 100);
    else if (event.key === 'ArrowDown') b = clamp(b - step, 0, 100);
    else if (event.key === 'ArrowUp') b = clamp(b + step, 0, 100);
    else return;
    event.preventDefault();
    event.stopPropagation();
    emitHsb();
  }

  /** @param {KeyboardEvent} event */
  function onHueKeyDown(event) {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') h = (((h - step) % 360) + 360) % 360;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') h = (h + step) % 360;
    else return;
    event.preventDefault();
    event.stopPropagation();
    emitHsb();
  }

  /** @param {Event} event @returns {number | null} */
  function readInt(event) {
    const v = Number.parseInt(/** @type {HTMLInputElement} */ (event.currentTarget).value.replace(/[^0-9]/g, ''), 10);
    return Number.isNaN(v) ? null : v;
  }

  /** @param {'h' | 's' | 'b'} channel @param {Event} event */
  function onHsbInput(channel, event) {
    const v = readInt(event);
    if (v === null) return;
    if (channel === 'h') h = clamp(v, 0, 360) % 360;
    else if (channel === 's') s = clamp(v, 0, 100);
    else b = clamp(v, 0, 100);
    emitHsb();
  }

  /** @param {'r' | 'g' | 'b'} channel @param {Event} event */
  function onRgbInput(channel, event) {
    const v = readInt(event);
    if (v === null) return;
    const rgb = { ...currentRgb, [channel]: clamp(v, 0, 255) };
    takeHsb(rgbToHsb(rgb.r, rgb.g, rgb.b));
    emitChange(rgbToHex(rgb.r, rgb.g, rgb.b));
  }

  /** @param {Event} event */
  function onHexInput(event) {
    isEditingHex = true;
    hexText = /** @type {HTMLInputElement} */ (event.currentTarget).value;
    const parsed = hexOnInput(hexText);
    const rgb = parsed && hexToRgb(parsed);
    if (!rgb) return;
    takeHsb(rgbToHsb(rgb.r, rgb.g, rgb.b));
    onchange(parsed);
  }

  /** @param {string} raw */
  function commitHex(raw) {
    isEditingHex = false;
    const committed = hexOnCommit(raw);
    const rgb = committed && hexToRgb(committed);
    if (!rgb) {
      hexText = currentHex;
      return;
    }
    takeHsb(rgbToHsb(rgb.r, rgb.g, rgb.b));
    emitChange(committed);
  }

  const pickScreenColor = screenColorPicker();

  async function pickFromScreen() {
    try {
      const hex = await pickScreenColor?.();
      if (hex) commitHex(hex);
    } catch {
      /* the sampler failed to open; the value is unchanged */
    }
  }
</script>

{#snippet pickerPanel()}
  <div
    bind:this={panel}
    use:portal={unclipped}
    id={panelId}
    class="picker-panel"
    class:end={align === 'end'}
    class:flipped-y={flippedY}
    class:unclipped
    role="dialog"
    tabindex="-1"
    aria-label={label}
    style:left={unclipped ? `${floating.x}px` : undefined}
    style:top={unclipped ? `${floating.y}px` : undefined}
    onkeydown={(event) => {
      if (unclipped) overlay.dismissKey(event);
    }}
    onfocusout={(event) => {
      if (unclipped) overlay.focusOut(event);
    }}
  >
    <div class="visual-row">
      <div
        bind:this={sbArea}
        class="sb-box"
        style:background-color="hsl({h}, 100%, 50%)"
        role="slider"
        tabindex="0"
        aria-label="Saturation and brightness"
        aria-valuetext="Saturation {s}%, brightness {b}%"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={b}
        onpointerdown={(e) => onPointerDown('sb', e)}
        onpointermove={(e) => onPointerMove('sb', e)}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onkeydown={onSbKeyDown}
      >
        <div class="sb-white"></div>
        <div class="sb-black"></div>
        <div class="sb-handle" style:left="{s}%" style:top="{100 - b}%" style:background-color={currentHex}></div>
      </div>

      <div
        bind:this={hueRail}
        class="hue-rail"
        role="slider"
        tabindex="0"
        aria-label="Hue"
        aria-valuemin="0"
        aria-valuemax="360"
        aria-valuenow={h}
        onpointerdown={(e) => onPointerDown('hue', e)}
        onpointermove={(e) => onPointerMove('hue', e)}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onkeydown={onHueKeyDown}
      >
        <div class="hue-thumb" style:top="{(h / 360) * 100}%"></div>
      </div>
    </div>

    <div class="preview-hex-row">
      <div class="preview-swatch" style:background-color={currentHex}></div>
      {#if pickScreenColor}
        <button
          type="button"
          class="eyedropper-btn"
          title="Pick a colour from the screen"
          aria-label="Pick a colour from the screen"
          onclick={pickFromScreen}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8.7 5.6 3.75 10.55 2.9 13.1 5.45 12.25 10.4 7.3Z" />
            <path d="M8.13 5.04 9.97 3.2a2 2 0 0 1 2.83 2.83L10.96 7.87Z" />
          </svg>
        </button>
      {/if}
      <div class="hex-group">
        <label class="channel-label" for="{panelId}-hex">Hex</label>
        <input
          id="{panelId}-hex"
          type="text"
          class="channel-input hex-input"
          class:invalid={hexInvalid(hexText)}
          value={hexText}
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          aria-invalid={hexInvalid(hexText) ? 'true' : undefined}
          oninput={onHexInput}
          onblur={(e) => commitHex(e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === 'Enter') commitHex(e.currentTarget.value);
          }}
        />
      </div>
    </div>

    <div class="numeric-grid">
      {#each [['h', 'Hue', 'H', h], ['s', 'Saturation', 'S', s], ['b', 'Brightness', 'B', b]] as [key, name, short, v] (key)}
        <div class="channel-col">
          <label class="channel-label" for="{panelId}-{key}" title={name}>{short}</label>
          <input
            id="{panelId}-{key}"
            type="text"
            inputmode="numeric"
            class="channel-input"
            value={v}
            aria-label={name}
            oninput={(e) => onHsbInput(/** @type {'h' | 's' | 'b'} */ (key), e)}
          />
        </div>
      {/each}
      {#each [['r', 'Red', 'R'], ['g', 'Green', 'G'], ['b', 'Blue', 'B']] as [key, name, short] (key)}
        <div class="channel-col">
          <label class="channel-label" for="{panelId}-rgb-{key}" title={name}>{short}</label>
          <input
            id="{panelId}-rgb-{key}"
            type="text"
            inputmode="numeric"
            class="channel-input"
            value={currentRgb[key]}
            aria-label={name}
            oninput={(e) => onRgbInput(/** @type {'r' | 'g' | 'b'} */ (key), e)}
          />
        </div>
      {/each}
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="anchor" bind:this={root} onkeydown={(e) => overlay.dismissKey(e)} onfocusout={(e) => overlay.focusOut(e)}>
  <button
    type="button"
    class="swatch-trigger"
    style:width="{size}px"
    style:height="{size}px"
    style:background-color={currentHex}
    title={label}
    aria-label={label}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    onclick={overlay.toggle}
  ></button>

  {#if open}{@render pickerPanel()}{/if}
</div>

<style>
  .anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
  }

  .swatch-trigger {
    -webkit-appearance: none;
    appearance: none;
    flex: none;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 5px;
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .swatch-trigger:hover {
    border-color: var(--t3);
  }
  .swatch-trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .picker-panel {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 236px;
    padding: 12px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--edge);
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
  }
  .picker-panel.end {
    left: auto;
    right: 0;
  }
  .picker-panel.flipped-y {
    top: auto;
    bottom: calc(100% + 8px);
  }
  .picker-panel.unclipped {
    position: fixed;
    right: auto;
    bottom: auto;
    max-height: calc(100vh - 16px);
    overflow: auto;
  }

  .visual-row {
    display: flex;
    gap: 8px;
    height: 160px;
  }

  .sb-box {
    position: relative;
    flex: 1;
    height: 100%;
    border-radius: 5px;
    overflow: hidden;
    cursor: crosshair;
    touch-action: none;
  }
  .sb-box:focus-visible,
  .hue-rail:focus-visible,
  .eyedropper-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .sb-white,
  .sb-black {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .sb-white {
    background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0));
  }
  .sb-black {
    background: linear-gradient(to top, #000, rgba(0, 0, 0, 0));
  }
  .sb-handle {
    position: absolute;
    width: 12px;
    height: 12px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.8), inset 0 0 1px rgba(0, 0, 0, 0.4);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .hue-rail {
    position: relative;
    width: 16px;
    height: 100%;
    border-radius: 5px;
    background: linear-gradient(to bottom, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
    cursor: pointer;
    touch-action: none;
  }
  .hue-thumb {
    position: absolute;
    left: -2px;
    right: -2px;
    height: 6px;
    border: 2px solid #fff;
    border-radius: 3px;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
    transform: translateY(-50%);
    pointer-events: none;
  }

  .preview-hex-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .preview-swatch {
    flex: none;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 5px;
  }
  .eyedropper-btn {
    display: grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: var(--panel2);
    color: var(--text);
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .eyedropper-btn:hover {
    border-color: var(--t3);
  }
  .hex-group {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    gap: 4px;
  }

  .numeric-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .channel-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .channel-label {
    font-size: 10px;
    font-weight: 500;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .channel-input {
    width: 100%;
    height: 24px;
    padding: 0 4px;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: var(--panel2);
    color: var(--text);
    font-size: 11px;
    text-align: center;
    outline: none;
    user-select: text;
    -webkit-user-select: text;
    transition: border-color 0.12s;
  }
  .channel-input:hover {
    border-color: var(--t3);
  }
  .channel-input:focus {
    border-color: var(--accent);
  }
  .channel-input.invalid {
    border-color: var(--warn);
  }
  .hex-input {
    text-align: left;
    font-family: ui-monospace, monospace;
  }
</style>
