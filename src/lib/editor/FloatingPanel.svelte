<script>
  // One floating editor window: a titled, draggable, resizable, hideable frame
  // around whatever the caller renders. It owns pointer work only - every rule
  // about where a panel may end up lives in panels.svelte.js, which is tested
  // without a browser.
  import { panels, movePanel, resizePanel, setHidden, raisePanel, clampAll } from './panels.svelte.js';
  import { prefersReducedMotion } from 'svelte/motion';

  let { id, title, count = null, children } = $props();

  const g = $derived(panels[id]);

  // The panels float over every piece of editor chrome (the bulk-style panel is
  // 40) and under the modal layer (100+). The stored z is 1..n and only orders
  // the panels among themselves.
  const LAYER = 50;

  // How long the collapse/expand plays, matched to the `.42s` baked into the
  // `fp-expand`/`fp-collapse` keyframes in styles.css - the two numbers have
  // to agree and there is nowhere shared to read one from, so a change to
  // either is a prompt to change the other. Noticeably slower than the old
  // instant swap on purpose: the panel's contents visibly gather into its
  // corner and spread back out of it, and anything close to the previous
  // 0.18s entrance reads as a glitch, not a gather.
  const GATHER_MS = 420;

  // Every gesture in flight, so an unmount can end them all. It is the same
  // leak as a cancelled pointer wearing different clothes: the listeners live
  // on `document`, nothing guarantees a further pointer event once the
  // component is gone, and they would go on writing geometry. A set rather
  // than a single controller because two pointers can be down at once - the
  // grip and the header both pressed before either releases - and a lone slot
  // would let the second gesture overwrite the first one's net.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  // Hiding a panel does not unmount it at once: it stays for one animation
  // wearing `fp-exit`, which swaps its entrance keyframe for the collapse that
  // mirrors it (see styles.css), so the panel visibly gathers into its corner.
  // What it leaves behind is not drawn here: a hidden panel is a tab under the
  // tool strip (RailTools.svelte), one per panel, and that tab is the way back.
  //
  // `prefersReducedMotion` collapses the wait to nothing, matching the CSS
  // media query in styles.css that stops the animation itself, so a
  // reduced-motion user gets neither the motion nor a lingering element.
  let exitingPanel = $state(false);
  const showPanel = $derived(!g.hidden || exitingPanel);
  // Plain, not `$state`: it is this effect's own memory of what it last acted
  // on, never rendered, and making it reactive would only invalidate the
  // effect that writes it.
  let lastHidden = g.hidden;
  $effect(() => {
    const hidden = g.hidden;
    if (hidden === lastHidden) return;
    lastHidden = hidden;
    // A panel shown again mid-collapse must not keep wearing the exit.
    exitingPanel = hidden;
    const ms = prefersReducedMotion.current ? 0 : GATHER_MS;
    const t = setTimeout(() => {
      exitingPanel = false;
    }, ms);
    // Cleared automatically before the next run of this effect - a second
    // hide/show before the timer fires - and on unmount. The same guarantee
    // `live` gives the pointer gestures below, for a timer instead of a
    // listener.
    return () => clearTimeout(t);
  });

  function drag(e, kind) {
    if (e.button !== 0) return;
    // The header is the drag handle, so the hide button lives inside it. Without
    // this the button's own pointerdown would arm a drag and the click would
    // land as a one-pixel move instead of a hide.
    if (e.target.closest?.('.fpanel-hide')) return;
    e.preventDefault();
    raisePanel(id);
    const pid = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    e.currentTarget.setPointerCapture?.(pid);
    const move = (ev) => {
      // A second pointer - another touch, or a pen alongside the mouse - would
      // otherwise arm its own drag and the two closures would fight over the
      // same panel.
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (kind === 'move') movePanel(id, o.x + dx, o.y + dy);
      else resizePanel(id, o.w + dx, o.h + dy);
    };
    // One controller for all three listeners, because a gesture does not always
    // end in a pointerup: a cancelled pointer (an OS gesture takes over, the
    // captured element leaves the DOM) fires pointercancel instead, and a move
    // handler that survives that would track the cursor with no button held and
    // save on every frame, with nothing left to stop it.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      // Clamped on drop, not per frame: clamping under a held pointer fights the
      // cursor, the panel lagging behind the hand that is dragging it. Waiting
      // for the release keeps the gesture honest and still guarantees the
      // invariant - no drag can leave a panel outside the window where the
      // user cannot reach it again.
      clampAll(window.innerWidth, window.innerHeight);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }
</script>

{#if showPanel}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section
    class="fpanel"
    class:fp-exit={exitingPanel}
    style="left:{g.x}px; top:{g.y}px; width:{g.w}px; height:{g.h}px; z-index:{LAYER + g.z}"
    onpointerdown={() => raisePanel(id)}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header class="fpanel-head" onpointerdown={(e) => drag(e, 'move')}>
      <span class="fpanel-title">{title}</span>
      {#if count}<span class="fpanel-count">{count}</span>{/if}
      <button
        class="fpanel-hide"
        onclick={() => setHidden(id, true)}
        aria-label="Hide {title}"
        title="Hide {title}"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </header>
    <div class="fpanel-body">{@render children()}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="fpanel-grip" onpointerdown={(e) => drag(e, 'resize')}></div>
  </section>
{/if}
