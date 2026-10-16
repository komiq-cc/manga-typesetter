<script>
  // Earlier versions of one chapter (SAV-1): the copies of chapter.json kept
  // in logs/snapshots, newest first, each one restorable. A restore keeps the
  // version it replaces on the same shelf, so it is itself undoable.
  import { untrack } from 'svelte';
  import { chapterById, listChapterSnapshots, restoreChapterSnapshot } from '../library.svelte.js';
  import { toast } from '../store.svelte.js';
  import { plural, relativeTime } from '../format.js';

  let { open = $bindable(), busy = $bindable(false), projectId = null, chapterId = null } = $props();

  let versions = $state(null);
  let error = $state('');
  // The row asking for its second click, by snapshot name.
  let confirming = $state(null);

  const chapter = $derived(projectId && chapterId ? chapterById(projectId, chapterId) : null);

  const REASONS = {
    open: 'Opened',
    timed: 'Autosaved',
    'before-restore': 'Before a restore',
    'before-cleaned': 'Before cleaned pages changed',
    'before-translations': 'Before translations were added',
    'outside-change': 'Changed outside the app',
  };
  const reasonLabel = (r) => REASONS[r] ?? r.replace(/-/g, ' ');
  const exactTime = (at) => new Date(at).toLocaleString();

  $effect(() => {
    if (!open || !projectId || !chapterId) {
      versions = null;
      return;
    }
    const pid = projectId;
    const cid = chapterId;
    untrack(() => reload(pid, cid));
  });

  // A slow read for a chapter the sheet has since left must not land on the
  // one it shows now.
  let readSeq = 0;
  async function reload(pid, cid) {
    const token = ++readSeq;
    error = '';
    confirming = null;
    try {
      const next = await listChapterSnapshots(pid, cid);
      if (token === readSeq) versions = next;
    } catch (e) {
      if (token !== readSeq) return;
      versions = null;
      error = `Could not read the earlier versions: ${e?.message ?? e}`;
    }
  }

  async function onRestore(v) {
    if (confirming !== v.name) {
      confirming = v.name;
      return;
    }
    confirming = null;
    if (busy) return;
    const pid = projectId;
    const cid = chapterId;
    busy = true;
    try {
      const { missingCleaned } = await restoreChapterSnapshot(pid, cid, v.name);
      const missing = missingCleaned
        ? ` ${plural(missingCleaned, 'page')} use the raw: the cleaned file is gone.`
        : '';
      toast(`Restored the version from ${relativeTime(v.at)}. The one it replaced is kept here.${missing}`);
    } catch (e) {
      toast(`Could not restore: ${e?.message ?? e}`);
    } finally {
      busy = false;
      if (pid === projectId && cid === chapterId) await reload(pid, cid);
    }
  }
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal sources-sheet">
      <div class="modal-head">
        <h3>Earlier versions · {chapter ? chapter.title || `Chapter ${chapter.number}` : 'Chapter'}</h3>
        <button class="x" onclick={() => (open = false)} disabled={busy} aria-label="Close">✕</button>
      </div>

      <div class="sources-meta">
        A copy is kept when the chapter opens and every ten minutes while you work. The last 20 are kept.
      </div>

      {#if error}<div class="home-error" role="alert">{error}</div>{/if}

      <div class="sources-list">
        {#each versions ?? [] as v (v.name)}
          <div class="sources-row">
            <div class="sources-names">
              <span class="path" title={exactTime(v.at)}>{relativeTime(v.at)} · {reasonLabel(v.reason)}</span>
              <span class="sources-none">{plural(v.pages, 'page')} · {plural(v.boxes, 'box', 'boxes')}</span>
            </div>
            <button
              class="soft-btn slim"
              class:warn={confirming === v.name}
              onclick={() => onRestore(v)}
              disabled={busy}
            >
              {confirming === v.name ? 'Click again to restore' : 'Restore'}
            </button>
          </div>
          {#if confirming === v.name}
            <div class="pair-note warn" role="alert">
              Replaces the chapter with this version. The current one is kept in this list first. The
              chapter's undo history is cleared.
            </div>
          {/if}
        {:else}
          <div class="home-empty">{error || versions == null ? '' : 'No earlier versions yet. One is kept the next time this chapter opens.'}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}
