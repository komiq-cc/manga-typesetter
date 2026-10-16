<script>
  import { projectById, deleteChapter, setChapterMode, setProjectOcrLanguage } from '../library.svelte.js';
  import { route, goLibrary, goEditor } from '../route.svelte.js';
  import { toast } from '../store.svelte.js';
  import { relativeTime, plural } from '../format.js';
  import { exportChapterPackage, stayingNote } from '../package-flow.js';

  let { onNewChapter, onSources, onVersions } = $props();

  // Chapter progress state.
  function status(c) {
    if (!c.pageCount) return { mark: '·', label: 'No pages', on: false };
    if (!c.typeset) return { mark: '○', label: 'Raws only', on: false };
    return { mark: '●', label: 'Typeset', on: true };
  }

  const project = $derived(projectById(route.projectId));
  const pageTotal = $derived((project?.chapters ?? []).reduce((n, c) => n + c.pageCount, 0));

  let confirmingId = $state(null);
  // Track active row mode write.
  let switchingId = $state(null);
  // The row whose package is being built and written.
  let exportingId = $state(null);
  let changingLanguage = $state(false);

  async function onLanguageChange(event) {
    if (changingLanguage) return;
    const select = event.currentTarget;
    changingLanguage = true;
    try {
      await setProjectOcrLanguage(project.id, select.value);
    } catch (e) {
      select.value = project.ocrLanguage;
      toast(`Could not change source language: ${e?.message ?? e}`);
    } finally {
      changingLanguage = false;
    }
  }

  // Build a package for one chapter and save it wherever the user says. A
  // cancelled save dialog resolves to null and is not worth a toast.
  async function onExport(c) {
    if (exportingId) return;
    exportingId = c.id;
    try {
      const saved = await exportChapterPackage(project.id, c.id);
      // With the Rust engine on, also which fonts went without a file: a
      // system font is not copied, and the other machine needs its own.
      const note = stayingNote(saved?.staying);
      if (saved) toast(note ? `Saved to ${saved.path}. ${note}` : `Saved to ${saved.path}`);
    } catch (e) {
      toast(`Could not export: ${e?.message ?? e}`);
    } finally {
      exportingId = null;
    }
  }

  // Toggle chapter workflow mode.
  async function onToggleMode(c) {
    if (switchingId) return;
    switchingId = c.id;
    const next = c.mode === 'translate' ? 'typeset' : 'translate';
    try {
      await setChapterMode(project.id, c.id, next);
      toast(`Chapter ${c.number} is now a ${next} chapter`);
    } catch (e) {
      toast(`Could not change the mode: ${e?.message ?? e}`);
    } finally {
      switchingId = null;
    }
  }

  async function onDelete(chapter) {
    if (confirmingId !== chapter.id) {
      confirmingId = chapter.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteChapter(project.id, chapter.id);
      toast(`Deleted chapter ${chapter.number}`);
    } catch (e) {
      toast(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

{#if project}
  <button class="back-link" onclick={goLibrary}>← Projects</button>

  <div class="project-head">
    <div class="project-title">
      <div class="project-name">{project.name}</div>
      <div class="project-meta">
        {plural(project.chapters.length, 'chapter')} · {plural(pageTotal, 'page')}
      </div>
    </div>
    <label class="project-language">
      Source language
      <select value={project.ocrLanguage} onchange={onLanguageChange} disabled={changingLanguage}>
        <option value="ja">Japanese</option>
        <option value="zh">Chinese</option>
        <option value="ko">Korean</option>
      </select>
    </label>
    <button class="soft-btn" onclick={() => onNewChapter(project.id)}>New chapter</button>
  </div>

  <div class="section-label spaced">CHAPTERS</div>

  <div class="chapter-table">
    {#each project.chapters as c (c.id)}
      <div class="chapter-row" class:unreadable={c.unreadable}>
        <button
          class="chapter-open"
          onclick={() => goEditor(project.id, c.id)}
          disabled={c.unreadable}
        >
          <div class="chapter-mark" class:on={!c.unreadable && status(c).on} aria-hidden="true">
            {c.unreadable ? '-' : status(c).mark}
          </div>
          <div class="chapter-num">{c.unreadable ? '-' : c.number}</div>
          <div class="chapter-title">
            {#if c.duplicate}
              <div class="warn">Same chapter as another folder</div>
              <div class="chapter-sub">{c.slug} - rename or remove the copy</div>
            {:else if c.unreadable}
              <div class="warn">Unreadable chapter</div>
              <div class="chapter-sub">{c.slug} - check this folder</div>
            {:else}
              <div>{c.title || `Chapter ${c.number}`}</div>
              <div class="chapter-sub">{c.slug}</div>
            {/if}
          </div>
          <div class="chapter-chip">{c.unreadable ? '' : status(c).label}</div>
          <div class="chapter-pages">{c.unreadable ? '' : plural(c.pageCount, 'page')}</div>
          <div class="chapter-time">{c.unreadable ? '' : relativeTime(c.updatedAt)}</div>
        </button>
        <button
          class="chapter-act chapter-mode"
          class:on={c.mode === 'translate'}
          onclick={() => onToggleMode(c)}
          disabled={c.unreadable || switchingId === c.id}
          title={c.mode === 'translate'
            ? 'Opens as a translation workspace - click to typeset instead'
            : 'Opens as the full typesetting editor - click to translate instead'}
          >{c.mode === 'translate' ? 'Translate' : 'Typeset'}</button
        >
        <button
          class="chapter-act"
          onclick={() => onExport(c)}
          disabled={c.unreadable || exportingId === c.id}
          title="Export this chapter as a package (.mtchapter)"
          >{exportingId === c.id ? 'Exporting…' : 'Export'}</button
        >
        <button
          class="chapter-act"
          onclick={() => onSources(project.id, c.id)}
          disabled={c.unreadable}
          title="Cleaned pages and translations">Sources</button
        >
        <button
          class="chapter-act"
          onclick={() => onVersions(project.id, c.id)}
          disabled={c.unreadable}
          title="Restore an earlier version of this chapter">Versions</button
        >
        <button class="chapter-del" onclick={() => onDelete(c)} title="Delete chapter">Delete</button>
      </div>
      {#if confirmingId === c.id}
        <div class="confirm-note warn" role="alert">
          Moves this chapter's folder to the trash, including its {plural(c.pageCount, 'copied raw')}. Click Delete again to confirm.
        </div>
      {/if}
    {:else}
      <div class="home-empty">No chapters yet.</div>
    {/each}
  </div>
{:else}
  <div class="home-empty">That project is no longer in the library.</div>
{/if}
