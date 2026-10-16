<script>
  // Chapter source image and translation management sheet.
  import { untrack } from 'svelte';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import {
    chapterById,
    readChapterSources,
    replaceCleanedPages,
    setPageCleaned,
    clearPageCleaned,
    removeAllCleaned,
    applyTranslations,
    restoreChapterSnapshot,
    sourcesUndo,
  } from '../library.svelte.js';
  import { pickImageFiles, pickJsonFile, readTranslations } from '../importer.js';
  import { toast, toastError } from '../store.svelte.js';
  import { plural } from '../format.js';
  import { joinPath } from '../paths.js';

  // In-flight operations block dismissal.
  let { open = $bindable(), busy = $bindable(false), projectId = null, chapterId = null } = $props();

  let sources = $state(null); // { rawsDir, cleanedDir, pages }
  let error = $state('');
  let pendingBulk = $state(null); // files picked for a bulk replace, awaiting Apply
  let confirmingRemoveAll = $state(false);
  // The version kept just before this sheet's last change (UND-2), which Undo
  // puts back - images included (CLN-11). Read off the library after each
  // change, so a change made and then superseded by an open is not offered.
  let undoName = $state(null);

  const chapter = $derived(projectId && chapterId ? chapterById(projectId, chapterId) : null);
  const pages = $derived(sources?.pages ?? []);
  const cleanedCount = $derived(pages.filter((pg) => pg.cleaned).length);
  const missingCount = $derived(pages.filter((pg) => pg.missing).length);

  // Reset and reload source lists on open.
  $effect(() => {
    if (!open || !projectId || !chapterId) {
      sources = null;
      return;
    }
    const pid = projectId;
    const cid = chapterId;
    untrack(() => reload(pid, cid));
  });

  // Ignore superseded asynchronous reads.
  let readSeq = 0;

  async function read(pid, cid) {
    const token = ++readSeq;
    const next = await readChapterSources(pid, cid);
    if (token !== readSeq) return null;
    sources = next;
    return next;
  }

  async function reload(pid, cid) {
    error = '';
    pendingBulk = null;
    confirmingRemoveAll = false;
    undoName = sourcesUndo(cid);
    try {
      await read(pid, cid);
    } catch (e) {

      if (pid !== projectId || cid !== chapterId) return;
      sources = null;
      error = `Could not read this chapter: ${e?.message ?? e}`;
    }
  }

  // Run mutation and reload chapter sources.
  async function run(pid, cid, fn) {
    if (busy) {

      toast('Still working on the last change - try again in a moment');
      return;
    }
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = `${e?.message ?? e}`;
      toastError(error);
    } finally {
      if (pid === projectId && cid === chapterId) undoName = sourcesUndo(cid);
      try {
        await read(pid, cid);
      } catch {

      }

      busy = false;
    }
  }

  const onUndo = () => {
    const pid = projectId;
    const cid = chapterId;
    const name = undoName;
    if (!name) return;
    return run(pid, cid, async () => {
      await restoreChapterSnapshot(pid, cid, name);
      toast('Undid the last change. The version it replaced is kept under Versions.');
    });
  };

  // Open native file picker (Tauri only).
  async function picking(label, fn) {
    try {
      await fn();
    } catch (e) {
      error = `${label} - ${e?.message ?? e}`;
      toastError(error);
    }
  }

  const pickBulk = () =>
    picking('Could not open the file picker', async () => {
      const picked = await pickImageFiles(true);
      if (picked) pendingBulk = [...picked];
    });

  // Positional pairing of picked files with pages.
  const bulkNotes = $derived.by(() => {
    if (!pendingBulk) return [];
    const n = Math.min(pendingBulk.length, pages.length);
    const notes = [];
    if (pendingBulk.length < pages.length) {
      notes.push({
        text: `Pages 1–${n} get a cleaned image; pages ${n + 1}–${pages.length} keep what they have.`,
        warn: true,
      });
    } else if (pendingBulk.length > pages.length) {
      notes.push({
        text: `${pages.length} of ${pendingBulk.length} images pair with a page; the last ${pendingBulk.length - pages.length} are ignored.`,
        warn: true,
      });
    } else {
      notes.push({ text: `All ${pages.length} pages get a cleaned image.`, warn: false });
    }
    const replaced = pages.slice(0, n).filter((pg) => pg.cleaned).length;
    if (replaced) {
      notes.push({
        text: `${plural(replaced, 'page')} already ${replaced === 1 ? 'has' : 'have'} a cleaned image. Applying replaces ${replaced === 1 ? 'it' : 'them'}. Undo brings the old ${replaced === 1 ? 'one' : 'ones'} back.`,
        warn: true,
      });
    }
    return notes;
  });

  async function applyBulk() {
    const files = pendingBulk;
    if (!files?.length) return;
    const pid = projectId;
    const cid = chapterId;
    await run(pid, cid, async () => {
      const { replaced, ignored } = await replaceCleanedPages(pid, cid, files);

      pendingBulk = null;
      toast(
        `Set the cleaned image on ${plural(replaced, 'page')}${ignored ? ` · ${ignored} ignored` : ''}`,
      );
    });
  }

  function onRemoveAll() {
    if (!confirmingRemoveAll) {
      confirmingRemoveAll = true;
      return;
    }
    confirmingRemoveAll = false;
    const pid = projectId;
    const cid = chapterId;
    return run(pid, cid, async () => {
      const n = await removeAllCleaned(pid, cid);
      toast(`Removed the cleaned image from ${plural(n, 'page')}`);
    });
  }

  // Capture target chapter before file picker await.
  const onAddTranslations = () => {
    const pid = projectId;
    const cid = chapterId;
    return picking('Could not read that translations file', async () => {
      const picked = await pickJsonFile();
      if (!picked || !picked[0]) return;
      const parsed = await readTranslations(picked[0]);
      await run(pid, cid, async () => {
        const { covered, kept, ignored, lines, orphaned } = await applyTranslations(pid, cid, parsed);
        const notes = [];
        if (kept) notes.push(`${plural(kept, 'later page')} left unchanged`);
        if (ignored) notes.push(`${plural(ignored, 'page')} past the end ignored`);
        // Warn if new translation renumbers placed lines.
        if (orphaned) notes.push(`${plural(orphaned, 'placed box')} no longer matches a line`);
        toast(
          `Applied ${plural(lines, 'line')} to ${plural(covered, 'page')}${notes.length ? ' - ' + notes.join(' · ') : ''}`,
        );
      });
    });
  };

  const onSetPage = (pg) => {
    const pid = projectId;
    const cid = chapterId;
    const n = pageNumber(pg);
    return picking('Could not open the file picker', async () => {
      const picked = await pickImageFiles(false);
      if (!picked || !picked[0]) return;
      await run(pid, cid, async () => {
        const name = await setPageCleaned(pid, cid, pg.id, picked[0]);
        toast(`Page ${n} now uses ${name}`);
      });
    });
  };

  const onClearPage = (pg) => {
    const pid = projectId;
    const cid = chapterId;
    const n = pageNumber(pg);
    return run(pid, cid, async () => {
      await clearPageCleaned(pid, cid, pg.id);
      toast(`Page ${n} is back on its raw`);
    });
  };

  const pageNumber = (pg) => pages.indexOf(pg) + 1;

  // Load thumbnails via asset protocol.
  const srcFor = (pg) => {
    const dir = pg.cleaned && !pg.missing ? sources.cleanedDir : sources.rawsDir;
    const file = pg.cleaned && !pg.missing ? pg.cleaned : pg.file;
    return convertFileSrc(joinPath(dir, file));
  };
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal sources-sheet">
      <div class="modal-head">
        <h3>Sources · {chapter ? chapter.title || `Chapter ${chapter.number}` : 'Chapter'}</h3>
        <button class="x" onclick={() => (open = false)} disabled={busy} aria-label="Close">✕</button>
      </div>

      <div class="sources-meta">
        {plural(pages.length, 'page')} · {cleanedCount} with a cleaned image
        {#if missingCount}
          <span class="warn"> · {plural(missingCount, 'cleaned file')} missing from disk</span>
        {/if}
      </div>

      <div class="sources-bulk">
        <button class="soft-btn" onclick={pickBulk} disabled={busy || !pages.length}>
          Add or replace cleaned pages…
        </button>
        <button
          class="soft-btn"
          class:warn={confirmingRemoveAll}
          onclick={onRemoveAll}
          disabled={busy || !cleanedCount}
        >
          {confirmingRemoveAll ? 'Click again to remove' : 'Remove all cleaned pages'}
        </button>
        <button class="soft-btn" onclick={onAddTranslations} disabled={busy || !pages.length}>
          Add translations…
        </button>
        {#if undoName}
          <button class="soft-btn" onclick={onUndo} disabled={busy} title="Put the chapter back as it was before the last change here">
            Undo last change
          </button>
        {/if}
      </div>

      {#if confirmingRemoveAll}
        <div class="pair-note warn" role="alert">
          Deletes the cleaned image on {plural(cleanedCount, 'page')} and puts every page back on its
          raw. The raws are untouched. Undo brings them back.
        </div>
      {/if}

      {#each bulkNotes as note}
        <div class="pair-note" class:warn={note.warn}>{note.text}</div>
      {/each}
      {#if pendingBulk}
        <div class="sources-bulk">
          <button class="accent-btn narrow" onclick={applyBulk} disabled={busy}>Apply</button>
          <button class="soft-btn" onclick={() => (pendingBulk = null)} disabled={busy}>Cancel</button>
        </div>
      {/if}

      {#if error}<div class="home-error" role="alert">{error}</div>{/if}

      <div class="sources-list">
        {#each pages as pg (pg.id)}
          <div class="sources-row">
            <div class="sources-idx">{pageNumber(pg)}</div>
            <div class="sources-thumb">
              {#if sources}
                <img
                  src={srcFor(pg)}
                  alt=""
                  loading="lazy"
                  onerror={(e) => (e.currentTarget.style.visibility = 'hidden')}
                />
              {/if}
            </div>
            <div class="sources-names">
              <code class="path">{pg.file}</code>
              {#if pg.missing}
                <code class="path warn">{pg.cleaned} - missing, using the raw</code>
              {:else if pg.cleaned}
                <code class="path">{pg.cleaned}</code>
              {:else}
                <span class="sources-none">no cleaned image</span>
              {/if}
            </div>
            <button class="soft-btn slim" onclick={() => onSetPage(pg)} disabled={busy}>Set cleaned…</button>
            <button
              class="soft-btn slim"
              onclick={() => onClearPage(pg)}
              disabled={busy || !pg.cleaned}
            >
              Remove
            </button>
          </div>
        {:else}
          <div class="home-empty">{error ? '' : 'This chapter has no pages.'}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}
