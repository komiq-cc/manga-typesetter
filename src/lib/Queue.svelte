<script>
  import {
    app,
    page,
    placedLineNs,
    activateLine,
    lineText,
    toggleTagOnLine,
    toast,
    isFreeLine,
    addTextBoxInView,
    setLineText,
    isTranslateMode,
    addQueueLine,
    placeableDetectedLines,
    placeDetectedOnPage,
    placeDetectedInChapter,
    cancelChapterPlace,
  } from './store.svelte.js';
  import { fontGroups, isFontOffered } from './font-menu.js';
  import { untrack } from 'svelte';
  import {
    knownTags,
    lineTags,
    hasTag,
    createTag,
    saveTagDefaults,
    deleteTag,
    tagFormFields,
    tagFormDefaults,
    findTag,
    normalizeTagName,
    MAX_TAG_LEN,
  } from './tags.svelte.js';
  import {
    createFieldUndo,
    resyncField,
    recordFieldEdit,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { modKey } from './format.js';
  import ReviewList from './ReviewList.svelte';
  import ColorPicker from './ColorPicker.svelte';

  const p = $derived(page());
  // Which lines already have a box, in one pass over the page's boxes rather
  // than one pass per row - see `placedLineNs`.
  const placedNs = $derived(placedLineNs(p));
  // How many bubbles on THIS page still want a box. Drives the top button's
  // label and its disabled state.
  const pagePlaceable = $derived(placeableDetectedLines(p).length);

  // Undo/redo for translation textarea.
  const fieldUndo = createFieldUndo();
  let fieldOwner = null;

  $effect(() => {
    const activeLine = p.lines.find((l) => l.n === p.activeLineN);
    const key = activeLine ? `${p.id}:${activeLine.n}` : null;
    const v = activeLine?.en ?? '';
    if (key === fieldOwner && v === fieldUndo.stack[fieldUndo.i]) return;
    fieldOwner = key;
    resyncField(fieldUndo, v);
  });

  // The translation textarea writes through the store (`setLineText`), which
  // fits the line's boxes and records one `line` entry per typing burst for the
  // toolbar undo; the field's own Cmd+Z stack covers the keystrokes.
  function onTextareaInput(e, line) {
    const v = e.currentTarget.value;
    setLineText(p, line.n, v);
    recordFieldEdit(fieldUndo, v, { atomic: isAtomicInput(e.inputType) });
  }

  function onTextareaKey(e, line) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
    e.preventDefault();
    const next = e.shiftKey ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    const el = e.currentTarget;
    const caret = caretAfter(el.value, next);
    el.value = next;
    el.setSelectionRange(caret, caret);
    setLineText(p, line.n, next);
  }

  // Translate mode disables canvas box placement and status indicators.
  const translate = $derived(isTranslateMode());


  const known = $derived(knownTags(app.pages));
  const recent = $derived(known.slice(0, 4));


  let menuFor = $state(null);

  let form = $state(null);

  // Reset active tag form on page navigation.
  $effect(() => {
    p.id;
    menuFor = null;
    form = null;
  });

  // Construct active and recent tag chips for a line.
  function chips(line) {
    const applied = lineTags(line);
    const rest = recent.map((t) => t.name).filter((n) => !applied.includes(n));
    return [...applied.map((name) => ({ name, on: true })), ...rest.map((name) => ({ name, on: false }))];
  }

  // Toggle tag on line and restyle attached boxes.
  function toggle(line, name) {
    const { restyled } = toggleTagOnLine(line.n, name, p);
    if (restyled) toast(`Restyled ${restyled} box${restyled > 1 ? 'es' : ''} on this line · ${modKey()}Z`);
  }

  function openCreate(n) {
    menuFor = null;
    form = { n, name: '', edit: false, tools: false, existed: false, confirmDelete: false, ...tagFormFields(null) };
  }


  function openEdit(n, name) {
    menuFor = null;
    form = { n, name, edit: true, tools: true, existed: false, confirmDelete: false, ...tagFormFields(findTag(name)) };
  }

  function submitForm(line) {
    const f = form;
    if (!f) return;
    if (f.edit) {
      saveTagDefaults(f.name, tagFormDefaults(f));
      form = null;
      return;
    }
    const name = normalizeTagName(f.name);
    if (!name) return;
    // If tag already exists, transition form to edit mode.
    if (findTag(name)) {
      if (!hasTag(line, name)) toggle(line, name);
      form = { ...f, name, edit: true, tools: true, existed: true, confirmDelete: false };
      return;
    }
    createTag(name, tagFormDefaults(f));

    if (!hasTag(line, name)) toggle(line, name);
    form = null;
  }

  // Add text box in visible viewport.
  function addText() {
    const id = addTextBoxInView();
    if (!id) return;
    const b = page().boxes.find((x) => x.id === id);

    if (b) page().activeLineN = b.lineN;
  }

  function doDelete() {
    const name = form?.name;
    if (!name) return;
    form = null;
    if (deleteTag(name)) toast(`Forgot the defaults for “${name}” - lines keep the tag`);
  }

  // ---------- following the active line ----------
  // The queue is a floating panel a letterer sizes down to a handful of rows,
  // and the active line moves on its own: a placement advances it, an undo
  // rewinds it, a page turn picks a new one. Left alone, the row that says what
  // you are working on is off-screen most of the time.
  //
  // The panel's body is the scroller (see `.fpanel-body`), not this list, so the
  // scroll is computed against that element rather than handed to
  // `scrollIntoView` - which would also walk every ancestor scroller and has no
  // way to be told about the sticky bars at either end of this list.
  //
  // Nothing moves when the row is already fully visible. That is what keeps it
  // from flinching: typing in the active row's textarea re-renders it, and a
  // scroll on every render - even a smooth one - is the twitch this is trying
  // not to be. The guard on top of that is `lastFollowed`, so this answers only
  // to the active line CHANGING, never to the row's contents changing.
  let listEl = $state(null);
  let lastFollowed = null;
  let followRaf = 0;
  // The sticky bars at either end of the list overlap it: a row scrolled to the
  // exact edge lands underneath one. Measured rather than hard-coded, because
  // the top bar is not mounted in a translate chapter.
  const stickyPad = (sel) => listEl?.querySelector(sel)?.getBoundingClientRect().height ?? 0;

  function followActiveLine() {
    followRaf = 0;
    const scroller = listEl?.closest('.fpanel-body');
    const row = listEl?.querySelector('.qrow.active');
    if (!scroller || !row) return;
    const rowR = row.getBoundingClientRect();
    const boxR = scroller.getBoundingClientRect();
    const top = boxR.top + stickyPad('.qtop') + 6;
    const bottom = boxR.bottom - stickyPad('.qadd') - 6;
    let delta = 0;
    if (rowR.top < top) delta = rowR.top - top;
    // A row taller than the visible band is aligned to its top rather than its
    // bottom: the badge and the first words are the part worth seeing.
    else if (rowR.bottom > bottom) delta = Math.min(rowR.bottom - bottom, rowR.top - top);
    if (!delta) return;
    const reduce =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: reduce ? 'auto' : 'smooth' });
  }

  $effect(() => {
    const key = p.activeLineN == null ? null : `${p.id}:${p.activeLineN}`;
    untrack(() => {
      if (key === lastFollowed) return;
      lastFollowed = key;
      if (!key) return;
      // A frame later: the row that just became active grows into its expanded
      // form (the tag strip, the textarea), and a scroll measured before that
      // layout lands is measured against the height the row no longer has.
      if (followRaf) cancelAnimationFrame(followRaf);
      followRaf = requestAnimationFrame(followActiveLine);
    });
  });
  $effect(() => () => {
    if (followRaf) cancelAnimationFrame(followRaf);
  });

  // Esc stops a "Place chapter" that is still measuring - unless a modal is up,
  // whose Esc it is (the markup contract `App.svelte` relies on too).
  function cancelOnEscape(e) {
    if (e.key !== 'Escape' || !app.chapterPlace) return;
    if (document.querySelector('.modal-overlay.open')) return;
    cancelChapterPlace();
  }
</script>

<svelte:window onkeydown={cancelOnEscape} />

<div class="qlist" bind:this={listEl}>
  <!-- The batch placement, at the top of the panel rather than under the queue.
       It is the first thing a letterer does to a detected page - one press
       instead of one click per bubble - and at the foot of a list of forty lines
       it was below the fold on every page that needed it most. -->
  {#if !translate}
    <div class="qtop">
      <button
        class="qtop-btn"
        title="Put a text box on every detected bubble on this page that has none yet"
        disabled={pagePlaceable === 0}
        onclick={() => placeDetectedOnPage(p)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
        Place page{pagePlaceable ? ` · ${pagePlaceable}` : ''}
      </button>
      <!-- Never counted up front, unlike the page button beside it: the count is
           a pass over every page's lines AND every page's boxes, and as a
           `$derived` it would re-run on every keystroke in the panel. The button
           says so itself when there is nothing left to do. -->
      <!-- Every balloon in the chapter is measured before anything is placed,
           which takes a moment per page; cancelling before the end places
           nothing. -->
      {#if app.chapterPlace}
        <button class="qtop-btn" disabled>
          Fitting {app.chapterPlace.done}/{app.chapterPlace.total}
        </button>
        <button class="qtop-btn" title="Stop fitting and place nothing (Esc)" onclick={cancelChapterPlace}>
          Cancel
        </button>
      {:else}
        <button
          class="qtop-btn"
          title="Put a text box on every detected bubble in the whole chapter that has none yet"
          disabled={app.pages.length === 0}
          onclick={() => placeDetectedInChapter()}
        >
          Place chapter
        </button>
      {/if}
    </div>
  {/if}
  <ReviewList />
  {#if p.lines.length === 0}
    <div class="qhint">
      No lines yet.<br />{translate
        ? 'Run Detect to read this page, or import a JSON of numbered text.'
        : 'Import a JSON of numbered text to populate the queue, or add a text box below.'}
    </div>
  {/if}
  {#each p.lines as line (line.n)}
    {@const placed = placedNs.has(line.n)}
    {@const tagged = lineTags(line)}
    {@const editing = line.n === p.activeLineN}

    {@const free = isFreeLine(line)}
    {@const badge = free ? 'T' : line.n}
    {@const badgeTitle = free ? 'Typed on the page - not from the translation' : `Line ${line.n}`}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="qrow"
      class:editing
      class:active={editing}
      class:placed
      class:sfx={tagged.includes('sfx')}
      class:narration={tagged.includes('narration')}
      role={editing ? undefined : 'button'}
      tabindex={editing ? -1 : 0}
      onclick={editing ? undefined : () => activateLine(line.n)}
      onkeydown={editing ? undefined : (e) => e.key === 'Enter' && activateLine(line.n)}
    >
      {#if editing}

        <button class="badge" class:free title="Select this line's box" onclick={() => activateLine(line.n)}>{badge}</button>
        <span class="qcol">
          <span class="qtags">
            {#each chips(line) as c (c.name)}
              <button class="qtag" class:on={c.on} title={c.on ? `Remove ${c.name}` : `Apply ${c.name}`} onclick={() => toggle(line, c.name)}>{c.name}</button>
            {/each}
            <button class="qtag-ic" title="Create tag" onclick={() => (form?.n === line.n && !form.edit ? (form = null) : openCreate(line.n))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h8" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z" /></svg>
            </button>
            <button class="qtag-ic" title="All tags" onclick={() => (menuFor = menuFor === line.n ? null : line.n)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </span>

          {#if menuFor === line.n}

            <span class="qmenu">
              {#if known.length === 0}
                <span class="qmenu-empty">No tags yet - use the pen to make one.</span>
              {/if}
              {#each known as t (t.name)}
                <span class="qmenu-row">
                  <button class="qmenu-pick" class:on={hasTag(line, t.name)} onclick={() => toggle(line, t.name)}>
                    <svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12l5 5L20 6" /></svg>
                    <span class="nm">{t.name}</span>
                  </button>
                  <button class="qtag-ic" title="Tag settings" onclick={() => openEdit(line.n, t.name)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></svg>
                  </button>
                </span>
              {/each}
            </span>
          {/if}

          {#if form?.n === line.n}
            <span class="qtagform">
              <span class="qtf-top">
                {#if form.edit}
                  <span class="qtf-name">{form.name}</span>
                {:else}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="qtf-input"
                    autofocus
                    placeholder="Tag name…"
                    maxlength={MAX_TAG_LEN}
                    value={form.name}
                    oninput={(e) => (form.name = e.currentTarget.value)}
                    onkeydown={(e) => e.key === 'Enter' && submitForm(line)}
                  />
                {/if}
                <button class="qtag-ic" class:on={form.tools} title="Default font, outline and size" onclick={() => (form.tools = !form.tools)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="16" cy="7" r="2.2" /><path d="M4 7h9.8M18.2 7H20" /><circle cx="9" cy="16" r="2.2" /><path d="M4 16h2.8M11.2 16H20" /></svg>
                </button>
                <button class="qtf-go" onclick={() => submitForm(line)}>{form.edit ? 'Save' : 'Add'}</button>
              </span>
              {#if form.existed}

                <span class="qtf-note">
                  “{form.name}” already existed and is now on this line. Its saved defaults are untouched - press Save to replace them with what you set here.
                </span>
              {/if}
              {#if form.tools}

                <span class="qtf-row">
                  <label class="qtf-lbl" for="qtf-font-{line.n}">Font</label>
                  <select id="qtf-font-{line.n}" value={form.font} onchange={(e) => (form.font = e.currentTarget.value)}>
                    <option value="">-</option>
                    {#if form.font && !isFontOffered(form.font)}
                      <option value={form.font}>{form.font} (not in menus)</option>
                    {/if}
                    {#each fontGroups() as g (g.key)}
                      <optgroup label={g.label}>
                        {#each g.fonts as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
                      </optgroup>
                    {/each}
                  </select>
                </span>

                <span class="qtf-row">
                  <label class="qtf-lbl" for="qtf-out-{line.n}">Outline</label>
                  <input class="btick" id="qtf-out-{line.n}" type="checkbox" checked={form.outlineOn} onchange={(e) => (form.outlineOn = e.currentTarget.checked)} />
                  {#if form.outlineOn}
                    <ColorPicker value={form.outline} label="Outline colour" size={20} unclipped onchange={(hex) => (form.outline = hex)} />
                    <input type="number" min="0" max="20" step="0.5" value={form.outlineWidth} oninput={(e) => (form.outlineWidth = Math.max(0, Math.min(20, +e.currentTarget.value || 0)))} />
                  {/if}
                </span>

                <!-- The size a box of this tag starts at when no box of it comes
                     before. Empty is no default. -->
                <span class="qtf-row">
                  <label class="qtf-lbl" for="qtf-size-{line.n}">Size</label>
                  <input id="qtf-size-{line.n}" type="number" min="6" max="200" step="1" placeholder="-" title="Font size, px" value={form.size} onchange={(e) => { const v = e.currentTarget.value.trim(); form.size = v === '' ? '' : Math.max(6, Math.min(200, +v || 6)); e.currentTarget.value = String(form.size); }} />
                </span>
              {/if}
              {#if form.edit}

                <span class="qtf-del">
                  {#if form.confirmDelete}
                    <span class="qtf-note">
                      Forget “{form.name}”? It leaves your tag list and stops setting defaults for boxes placed from now on. Lines already tagged “{form.name}” keep the tag, and their boxes keep the style they were placed with - here and in every other chapter. While a line in this chapter still carries it, it stays in this list with no defaults.
                    </span>
                    <span class="qtf-delrow">
                      <button class="qtf-danger" onclick={doDelete}>Forget it</button>
                      <button class="qtf-quiet" onclick={() => (form.confirmDelete = false)}>Keep</button>
                    </span>
                  {:else}
                    <button class="qtf-quiet" onclick={() => (form.confirmDelete = true)}>Delete tag…</button>
                  {/if}
                </span>
              {/if}
            </span>
          {/if}

          {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
          <textarea
            rows="2"
            placeholder="English…"
            value={line.en ?? ''}
            oninput={(e) => onTextareaInput(e, line)}
            onkeydown={(e) => onTextareaKey(e, line)}
          ></textarea>
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {:else}
        <span class="badge" class:free title={badgeTitle}>{badge}</span>
        <span class="qcol">
          {#if tagged.length}
            <span class="qtypes">
              {#each tagged as t (t)}<span class="qtype {t}">{t}</span>{/each}
            </span>
          {/if}
          <span class="preview">{lineText(line)}</span>
          {#if line.jp}<span class="qjp">{line.jp}</span>{/if}
        </span>
        {#if !translate}<span class="dot {placed ? 'placed' : 'unplaced'}" title={placed ? 'Placed' : 'Unplaced'}></span>{/if}
      {/if}
    </div>
  {/each}


  {#if !translate}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addText}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add text
      </button>
    </div>
  {:else}
    <div class="qadd">
      <button class="qadd-btn" disabled={!app.pages.length} onclick={addQueueLine}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
        Add line
      </button>
    </div>
  {/if}
</div>
