<script>
  // The editor's chrome, floating over a full-bleed canvas rather than sitting
  // in a bar above it: identity and the way out at top-left, everything else in
  // one cluster at the top right. Detect, Bulk style and Export used to float in
  // the middle of the band, over the page, where they read as four loose buttons
  // with no relationship to each other; they now sit in the same row as the font
  // and settings drawers, split from them by a hairline, chapter verbs on the
  // left of it, app drawers on the right.
  // Nothing here is laid out by a parent, every row pins itself to the window,
  // so the canvas underneath is never inset by chrome it does not know about.
  import { app, openBulk, closeBulk, isTranslateMode, toast, toastError } from '../store.svelte.js';
  import { goProject, goLibrary } from '../route.svelte.js';
  import { projectById, chapterById } from '../library.svelte.js';
  import { exportTextJson } from '../exporter.js';
  import { sidecarReady } from '../sidecar.js';
  import DetectMenu from './DetectMenu.svelte';
  import { comboFor, formatCombo } from '../shortcuts.svelte.js';

  let { onFontLib, onSettings } = $props();

  // What a translate chapter keeps: the way out, who you are, Detect, and the
  // JSON. Bulk style and the font library configure typesetting that is not
  // happening here, and Settings is reachable from the home screens, so the
  // whole right-hand group goes with the hairline that separated it.
  const translate = $derived(isTranslateMode());

  // The export in a translate chapter has one meaningful format and one
  // meaningful scope, so the dialog that asks about both is skipped and the
  // button does the thing. The busy flag and the catch are held here rather than
  // inside `exportTextJson`, exactly as `exportImages` and the detect menu's own
  // JSON item hold them, see the note on that function.
  async function saveJson() {
    app.exporting = true;
    try {
      await exportTextJson('all');
    } catch (e) {
      toastError('Export failed: ' + (e?.message || e));
    } finally {
      app.exporting = false;
    }
  }

  const label = $derived.by(() => {
    const ref = app.chapterRef;
    if (!ref) return 'Untitled';
    const p = projectById(ref.projectId);
    const c = chapterById(ref.projectId, ref.chapterId);
    if (!p || !c) return 'Untitled';
    return `${p.name} · ${c.title || 'Chapter ' + c.number}`;
  });

  // The save indicator rides on the project pill because it is a fact about the
  // open chapter. There is no manual save in this app, so a rejected autosave is
  // the user's only signal that their work is not reaching the disk, hence the
  // third state, and hence its staying up until a write lands.
  const saveTitle = $derived(
    app.saveFailed
      ? 'Could not save: your last edits are only in memory'
      : app.saved
        ? 'All changes saved'
        : 'Unsaved changes - saving shortly',
  );

  // Leaving the editor awaits a save before the route moves. A second click in
  // that window would run the leave hook twice and push a duplicate history
  // entry, so the control is inert until the first navigation settles.
  let leaving = $state(false);

  async function goHome() {
    if (leaving) return;
    leaving = true;
    try {
      const pid = app.chapterRef?.projectId;
      // A refused leave has already told the user why and left them here; there
      // is nothing more to do.
      await (pid ? goProject(pid) : goLibrary());
    } finally {
      leaving = false;
    }
  }

  // The pill is the only thing on screen while detection runs, the menu closes
  // itself the moment an item is chosen, so it carries the whole progress
  // report. `app.detecting` is what both scopes set, and it is what says
  // something is happening at all; the count is the extra a whole-chapter run
  // has to say and a single page does not.
  const detectNote = $derived.by(() => {
    if (!app.detecting) return null;
    const b = app.detectBatch;
    return b ? `${b.done}/${b.total}` : 'Detecting…';
  });

  // A greyed-out menu with no reason beside it is the state the spec's error
  // handling forbids, and the detection engine being unavailable is the one
  // reason the user cannot work out from the page in front of them.
  const detectTip = $derived(
    sidecarReady() ? 'Detect text + OCR' : 'Detect text + OCR - engine not ready',
  );

  // Handed to the menu so its outside-pointerdown check can spare the button
  // that opened it, see the note there.
  let detectBtn = $state(null);
  let detectOpen = $state(false);

  // The bulk button is lit while bulk mode is on, so its second press has to be
  // the way out of it. `openBulk` on an already-open mode would silently empty
  // the targets the user had picked and reseed the style; `closeBulk` is what
  // Escape and the panel's own Cancel already do.
  const toggleBulk = () => (app.bulk.active ? closeBulk() : openBulk());
  const regionsKey = $derived(formatCombo(comboFor('view.regions')));
  const regionsTip = $derived(
    `Regions - bubble outlines, detected text, line numbers${regionsKey ? ` (${regionsKey})` : ''}. Hold \\ to see the raw page`,
  );
</script>

<div class="pill-row left">
  <button class="pill pill-icon" onclick={goHome} disabled={leaving} data-tip="Back to the project" aria-label="Back to the project">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 7.4 8 3l5.4 4.4" /><path d="M4.3 6.9v6.3h7.4V6.9" /></svg>
  </button>
  <div class="pill pill-proj">
    <span class="pill-label">{label}</span>
    <span class="save-dot" class:saved={app.saved} class:failed={app.saveFailed} title={saveTitle}></span>
  </div>
</div>

<div class="pill-row far-right">
  <div class="pill-anchor">
    <button
      class="pill pill-icon"
      class:on={detectOpen}
      class:busy={!!detectNote}
      bind:this={detectBtn}
      onclick={() => (detectOpen = !detectOpen)}
      aria-haspopup="menu"
      aria-expanded={detectOpen}
      aria-label="Detect text"
      data-tip={detectTip}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>
      <!-- The two things the glyph cannot say on its own: that a run is under
           way at all, and how far through a whole-chapter one we are. Present
           only while detection is in flight. -->
      {#if detectNote}
        <span class="pill-count">{detectNote}</span>
      {/if}
    </button>
    {#if detectOpen}
      <DetectMenu anchor={detectBtn} onClose={() => (detectOpen = false)} />
    {/if}
  </div>
  {#if !translate}
    <button
      class="pill pill-icon"
      class:on={app.showRegions}
      onclick={() => (app.showRegions = !app.showRegions)}
      aria-pressed={app.showRegions}
      aria-label="Regions"
      data-tip={regionsTip}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="11" rx="8" ry="6" stroke-dasharray="3 2.2" /><path d="M9 16.5 7.5 20.5l4-3.6" /></svg>
    </button>
    <button
      class="pill pill-icon"
      class:on={app.bulk.active}
      onclick={toggleBulk}
      aria-pressed={app.bulk.active}
      aria-label="Bulk style"
      data-tip="Bulk style - one style, many boxes"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 14l9 5 9-5" /></svg>
    </button>
    <button class="pill pill-accent" onclick={() => (app.exportOpen = true)} disabled={app.exporting}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>Export
    </button>
    <!-- The hairline is the whole grouping: three chapter verbs, then the two
         drawers that belong to the app and not to the open chapter. -->
    <span class="pill-sep"></span>
    <button class="pill pill-icon" onclick={onFontLib} data-tip="Font library" aria-label="Font library">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
    </button>
    <button class="pill pill-icon" onclick={onSettings} data-tip="Settings" aria-label="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
    </button>
  {:else}
    <!-- The one export a translate chapter has: the whole chapter's text, as the
         same document the typeset side's JSON format writes. -->
    <button class="pill pill-accent" onclick={saveJson} disabled={app.exporting} data-tip="Save this chapter's text as JSON">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>JSON
    </button>
  {/if}
</div>
