<script module>
  // Where the last right-click on a box asked for the menu. Module state
  // because the press is heard by a TextBox and the menu is drawn once, here,
  // over everything: a menu inside the box would be clipped by the page frame
  // and turned and mirrored with the box. `turn` makes a second right-click on
  // the same box a new request rather than the same one.
  const ask = $state({ id: null, x: 0, y: 0, turn: 0 });

  export function openBoxMenu(id, x, y) {
    ask.id = id;
    ask.x = x;
    ask.y = y;
    ask.turn++;
  }
</script>

<script>
  // The right-click menu on a box (FLOW-9). Every item is something a button
  // or a key already does: the keyed ones run through the shortcut registry
  // (`runShortcut`), so the menu and the key can never disagree about what an
  // action means, and each shows its key as the user has it bound. Nothing
  // here is the only way to anything.
  import { untrack } from 'svelte';
  import { app, page, lineByN, layoutLocked, lockableBox, isTranslateMode } from '../store.svelte.js';
  import { hasCopiedStyle } from '../presets.svelte.js';
  import { runShortcut, hasShortcutHandler, comboFor, formatCombo } from '../shortcuts.svelte.js';
  import { anchoredOverlay } from '../anchored-overlay.svelte.js';
  import { setHidden, raisePanel } from './panels.svelte.js';
  import { showActiveRow } from '../Queue.svelte';

  // Clear of the window's edges by this much when the menu has to be pushed
  // back on screen.
  const EDGE = 8;

  let menuEl = $state(null);
  let boxId = $state(null);
  let at = $state({ x: 0, y: 0 });
  // Which request the menu on screen answers. Keyed on, so a new request is a
  // new menu - placed and focused again - even if the old one never closed.
  let turn = $state(0);
  const overlay = anchoredOverlay(() => menuEl);

  // A request opens the menu fresh on its box. The overlay remembers where
  // focus was (a queue row, the Inspector's text field) so Escape gives it back.
  $effect(() => {
    const t = ask.turn;
    if (!t) return;
    untrack(() => {
      overlay.close({ refocus: false });
      turn = t;
      boxId = ask.id;
      at = { x: ask.x, y: ask.y };
      overlay.show();
    });
  });

  const box = $derived(boxId ? page().boxes.find((b) => b.id === boxId) ?? null : null);

  // The menu is about one box. Anything that takes the selection off it - an
  // undo, Tab, a click elsewhere, the box deleted, the page turned - takes the
  // menu away rather than leaving it pointing at a box that is not the one the
  // handlers act on (they act on the selection).
  $effect(() => {
    if (!overlay.open) return;
    if (!box || app.selectedId !== boxId || isTranslateMode()) overlay.close({ refocus: false });
  });

  // The page under the menu moving - a wheel scroll or zoom, the window
  // resized or left - leaves the menu beside nothing.
  $effect(() => {
    if (!overlay.open) return;
    const wheel = (e) => {
      if (!menuEl?.contains(e.target)) overlay.close({ refocus: false });
    };
    const away = () => overlay.close({ refocus: false });
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('wheel', wheel, { capture: true });
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  });

  const keyOf = (id) => formatCombo(comboFor(id));

  // Read when the menu opens (the block is made again each time), which is
  // when it has to be right: the style clipboard is not reactive, and nothing
  // fills it while the menu is up except the menu's own Copy style, which
  // closes it.
  function itemsFor(b) {
    const locked = layoutLocked(b);
    const line = b.lineN != null ? lineByN(page(), b.lineN) : null;
    const keyed = (id, label, ok = true, extra = {}) => ({ id, label, key: keyOf(id), ok: ok && hasShortcutHandler(id), run: () => runShortcut(id), ...extra });
    return [
      keyed('box.retypeset', 'Refit'),
      keyed('box.layoutLock', 'Lock layout', lockableBox(b), { checked: locked }),
      keyed('box.approveOutline', 'Approve outline', !!b.fit && b.outline?.approved !== 'user'),
      { sep: true },
      keyed('box.duplicate', 'Duplicate'),
      keyed('style.copy', 'Copy style'),
      keyed('style.paste', 'Paste style', hasCopiedStyle()),
      { sep: true },
      { id: 'queue.show', label: 'Show in queue', key: '', ok: !!line, run: () => showInQueue(line.n) },
      { sep: true },
      keyed('box.delete', 'Delete'),
    ];
  }

  // The box's line becomes the queue's active row, and the queue is brought
  // up and asked to scroll to it even when that row was active already.
  function showInQueue(n) {
    page().activeLineN = n;
    setHidden('queue', false);
    raisePanel('queue');
    showActiveRow();
  }

  // Closed first, then run: the action may toast, delete the box or open
  // something, and focus goes back where it was before the menu took it.
  function choose(it) {
    if (!it.ok) return;
    overlay.close();
    it.run();
  }

  // Placed at the pointer, then pushed back on screen: to the pointer's other
  // side when the right or bottom edge is too close, as a system menu does,
  // and clamped to the window when even that does not fit.
  function place(node) {
    const r = node.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = at.x, y = at.y;
    if (x + r.width > vw - EDGE) x = Math.max(EDGE, x - r.width);
    if (y + r.height > vh - EDGE) y = Math.max(EDGE, y - r.height);
    at = { x: Math.min(x, Math.max(EDGE, vw - EDGE - r.width)), y: Math.min(y, Math.max(EDGE, vh - EDGE - r.height)) };
    node.querySelector('button:not(:disabled)')?.focus();
  }

  // The editor listens for keys on the window: the arrows nudge the box,
  // Delete deletes it, Tab walks the selection, Escape deselects. None of that
  // is what a key pressed in the menu means, so plain keys stop here.
  // Cmd/Ctrl combos go on, so undo and the other shortcuts still work.
  function onKey(e) {
    if (overlay.dismissKey(e)) return;
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
    const all = [...(menuEl?.querySelectorAll('button:not(:disabled)') ?? [])];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement);
    const n = all.length;
    let to = null;
    if (e.key === 'ArrowDown') to = all[(i + 1) % n];
    else if (e.key === 'ArrowUp') to = i < 0 ? all[n - 1] : all[(i + n - 1) % n];
    else if (e.key === 'Home') to = all[0];
    else if (e.key === 'End') to = all[n - 1];
    else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      all[i].click();
      return;
    } else if (e.key === 'Tab') {
      // A menu is one stop: Tab leaves it, the way Escape does, but without
      // handing focus back to where it was.
      e.preventDefault();
      overlay.close({ refocus: false });
      return;
    } else return;
    e.preventDefault();
    to?.focus();
  }
</script>

{#if overlay.open && box}
  {#key turn}
  <div
    class="chrome-menu box-menu"
    role="menu"
    tabindex="-1"
    aria-label="Box"
    style="left:{at.x}px;top:{at.y}px"
    bind:this={menuEl}
    use:place
    onkeydown={onKey}
    onfocusout={overlay.focusOut}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each itemsFor(box) as it, i (i)}
      {#if it.sep}
        <div class="chrome-menu-sep"></div>
      {:else}
        <button
          type="button"
          role={it.checked != null ? 'menuitemcheckbox' : 'menuitem'}
          aria-checked={it.checked != null ? it.checked : undefined}
          disabled={!it.ok}
          onclick={() => choose(it)}
        >
          <span class="bm-label">{it.label}</span>
          {#if it.checked}<span class="bm-on">On</span>{/if}
          {#if it.key}<kbd class="bm-key">{it.key}</kbd>{/if}
        </button>
      {/if}
    {/each}
  </div>
  {/key}
{/if}

<style>
  /* The app's dropdown, at the pointer instead of under a toolbar pill: fixed
     to the window, over the floating panels (z 50 and up) and under a modal
     (100). */
  .box-menu {
    position: fixed;
    right: auto;
    z-index: 90;
    min-width: 200px;
    outline: none;
  }
  .box-menu button {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Arrow keys move focus here, and the hover tint is where the eye looks. */
  .box-menu button:focus-visible {
    background: var(--panel2);
    outline: none;
  }
  .bm-label {
    flex: 1;
  }
  .bm-on {
    font-size: 11px;
    color: var(--t2);
  }
  .bm-key {
    font: inherit;
    font-size: 11.5px;
    color: var(--t3);
  }
</style>
