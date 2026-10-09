<script>
  // The queue's "fonts missing" notice: every family the open chapter names
  // that this machine cannot draw it in, with how many boxes each, and one
  // click to the first of them. A chapter from another machine, or one set in
  // a font since removed, used to draw in a substitute and say nothing; the
  // only way to find out was to open a box and read its font menu.
  //
  // With the Rust engine measuring it also lists the boxes whose text is not
  // all drawn in the font they are set in: a letter the font lacks is taken
  // from another font on this computer (which letters, and which font), or is
  // an empty box when no installed font has it. A browser does the first
  // silently and never tells anyone. And with the engine switched on but no
  // font for it to read, it says that nothing is measuring.
  //
  // It is the review list's sibling and sits under it, so it wears the same
  // clothes: the rules below are that component's, copied because a
  // component's styles are its own.
  import { app, missingFonts, fontNameFor, fontByName, gotoPage, selectBox, boxText, isLongstrip } from './store.svelte.js';
  import { boxesBorrowingLetters, lettersWereAskedFor, whyFontMissing, engineHasNoFont } from './engine-switch.svelte.js';
  import { revealInStrip } from './editor/strip-sync.svelte.js';
  import { plural } from './format.js';

  // This is mounted for the whole session, so what each list listens to is
  // what it costs.
  //
  // `missing` walks every box of the chapter and reads one thing of each, its
  // font name. It is made again when a box changes font, when a box or a page
  // comes or goes, and when the font lists or the one signal a face arriving
  // raises change - so it clears the moment the family is loaded. Not when a
  // box is typed in, moved, resized or restyled (FontNotice-cost.dom.test.js).
  //
  // `letters` listens to nothing but the switch while the browser measures.
  // With the Rust engine on it reads every box's text, so a keystroke makes it
  // again; the engine is asked only about a face and string it has not seen
  // (engine-switch.svelte.js keeps the answers), the rest is one lookup a box.
  // Which family a letter is borrowed from is part of that kept answer, so
  // saying it costs nothing more.
  //
  // `idle` is the switch on with no font the engine can read: no engine is
  // installed, and to the font sync EVERY name is one it has no bytes for -
  // the built-ins the browser is drawing included. Passing that list on would
  // say an engine had judged them. What is listed then is what is true with
  // no engine: the user's fonts the engine could not take, with why (they are
  // the reason it has nothing), and the names nothing on this machine has.
  const idle = $derived(engineHasNoFont());
  const missing = $derived.by(() => {
    const all = missingFonts(app.pages);
    return idle ? all.filter((m) => WHY[whyFontMissing(m.name)] || !fontByName(m.name)) : all;
  });
  const letters = $derived(boxesBorrowingLetters(app.pages));
  const borrowing = $derived(letters.filter((l) => l.borrowed.length).length);
  const lacking = $derived(letters.filter((l) => l.none.length).length);
  let open = $state(false);

  // A handful of the letters, as themselves: enough to recognise the box by.
  const shown = (cps) => cps.slice(0, 6).map((cp) => String.fromCodePoint(cp)).join(' ') + (cps.length > 6 ? ' …' : '');
  // One short line for a box: what is borrowed and from where, then what
  // nothing has. In a plain browser nobody looked through the installed
  // fonts, so the line does not claim anybody did.
  function lettersLine(l) {
    const parts = l.borrowed.map((b) => `${shown(b.letters)} drawn in ${b.family}`);
    if (l.none.length) parts.push(`${lettersWereAskedFor() ? 'no installed font has' : 'no loaded font has'} ${shown(l.none)}`);
    return parts.join(' · ');
  }

  const WHY = {
    compressed: 'a WOFF file, which the Rust engine can read only in the desktop app',
    unreadable: 'the Rust engine could not read this font file',
    unsaved: 'this font could not be stored when it was added, so the Rust engine has no copy of it · remove it and add the file again',
  };

  // Built only while the list is open, like the review list's.
  const rows = $derived.by(() => {
    if (!open) return [];
    const out = [];
    if (idle) {
      out.push({
        key: 'idle',
        pill: '!',
        text: 'No font to measure with',
        why: 'the Rust text engine is switched on but can read no font here, so nothing is measuring · add a font in the Font Library, or switch it off in Settings',
        title: 'The Rust engine measures only in fonts this computer has. Until it has one, text is laid out by estimate and no box is resized.',
        pageIndex: null,
        boxId: null,
      });
    }
    for (const m of missing) {
      let first = null;
      app.pages.some((pg, pageIndex) => {
        const b = pg.boxes.find((x) => x.style?.font === m.name);
        if (b) first = { pageIndex, boxId: b.id };
        return !!b;
      });
      const drawn = fontNameFor(m.name);
      out.push({
        key: `f:${m.name}`,
        pill: `${m.boxes}×`,
        text: m.name,
        why: WHY[whyFontMissing(m.name)] ?? (drawn === m.name ? 'not on this computer' : `not on this computer · set in ${drawn}`),
        title: `${plural(m.boxes, 'box', 'boxes')} set in ${m.name}. Load the font in the Font Library and they are set in it again.`,
        ...first,
      });
    }
    for (const l of letters) {
      const pg = app.pages[l.pageIndex];
      const b = pg?.boxes.find((x) => x.id === l.boxId);
      if (!b) continue;
      out.push({
        key: `l:${pg.id}:${l.boxId}`,
        pill: `p.${l.pageIndex + 1}`,
        text: String(boxText(b, pg) ?? '').replace(/\s+/g, ' ').trim(),
        why: lettersLine(l),
        title: l.none.length
          ? 'The font this box is set in has no glyph for these letters. One no font on this computer has is measured and drawn as an empty box.'
          : 'The font this box is set in has no glyph for these letters, so they are drawn from another font on this computer.',
        pageIndex: l.pageIndex,
        boxId: l.boxId,
      });
    }
    return out;
  });

  const headline = $derived(
    [
      idle ? 'Rust engine has no font to measure with' : '',
      missing.length ? `${plural(missing.length, 'font')} missing` : '',
      lacking ? `${plural(lacking, 'box', 'boxes')} with letters no font has` : '',
      borrowing ? `${plural(borrowing, 'box', 'boxes')} with letters from another font` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  function jump(r) {
    if (r.boxId == null) return;
    if (r.pageIndex !== app.pageIndex) gotoPage(r.pageIndex);
    selectBox(r.boxId);
    if (isLongstrip()) revealInStrip(r.boxId);
  }
</script>

{#if missing.length || letters.length || idle}
  <div class="rv">
    <button class="rv-head" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="rv-mark" aria-hidden="true">!</span>
      <span class="rv-count">{headline}</span>
      <svg class="rv-chev" class:open viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {#if open}
      <div class="rv-list">
        {#each rows as r (r.key)}
          <button
            class="rv-row"
            class:here={r.pageIndex === app.pageIndex && r.boxId === app.selectedId}
            title={r.title}
            onclick={() => jump(r)}
          >
            <span class="rv-pg">{r.pill}</span>
            <span class="rv-col">
              <span class="rv-text">{r.text || 'Empty box'}</span>
              <span class="rv-why">{r.why}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .rv {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 2px 0 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }
  .rv-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .rv-head:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-mark {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--warn);
    color: var(--panel);
    font-size: 11px;
    font-weight: 800;
  }
  .rv-count {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-chev {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    opacity: 0.7;
    transition: transform 0.12s;
  }
  .rv-chev.open {
    transform: rotate(180deg);
  }
  .rv-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rv-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rv-row:hover {
    background: var(--panel2);
  }
  .rv-row.here {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-pg {
    flex: 0 0 auto;
    min-width: 30px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--panel2);
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .rv-col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rv-text {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-why {
    font-size: 10.5px;
    color: var(--warn);
  }
</style>
