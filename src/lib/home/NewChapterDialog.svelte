<script>
  // New chapter dialog. One dialog, two sources - picked files or a chapter
  // package - chosen at the top, so there is one place a chapter comes into
  // being from and the project / number / title fields are shared.
  //
  // PSD import (chapterPagesFromPsdFiles / pickPsdFiles in psd.js) is parked
  // for now: the code stays, the dialog no longer offers it.
  import { untrack } from 'svelte';
  import { library, createProject, createChapter } from '../library.svelte.js';
  import { goEditor } from '../route.svelte.js';
  import { pickImageFiles, pickJsonFile, readTranslations } from '../importer.js';
  import { pickPackageFile, inspectPackage, importChapterPackage } from '../package-flow.js';
  import { toast, toastError } from '../store.svelte.js';
  import { plural, relativeTime } from '../format.js';

  // In-flight creation blocks dismissal.
  let { open = $bindable(), busy = $bindable(false), projectId = null } = $props();

  // Where the pages come from: 'files' | 'package'.
  let source = $state('files');

  let target = $state('');
  let newProjectName = $state('');
  let number = $state(1);
  let title = $state('');
  let files = $state([]);
  let cleaned = $state([]);
  let translations = $state(null); // { name, pages } from a picked JSON
  // The parsed chapter package and its description, or null before one is picked.
  let pkg = $state(null);
  let pkgSummary = $state(null);
  let pkgName = $state('');
  let reading = $state(false);
  let error = $state('');
  let workflow = $state('typeset');
  let newProjectLayout = $state('pages');
  let newProjectOcrLanguage = $state('ja');

  const isPackage = $derived(source === 'package');

  function nextNumberFor(id) {
    const p = library.projects.find((x) => x.id === id);
    return p ? (p.chapters.at(-1)?.number ?? 0) + 1 : 1;
  }

  // Reset dialog state on open.
  $effect(() => {
    if (!open) return;
    const pid = projectId;
    untrack(() => {
      source = 'files';
      target = pid ?? library.projects.find((p) => !p.unreadable)?.id ?? '__new__';
      number = nextNumberFor(target);
      title = '';
      files = [];
      cleaned = [];
      translations = null;
      pkg = null;
      pkgSummary = null;
      pkgName = '';
      reading = false;
      error = '';
      newProjectName = '';
      newProjectLayout = 'pages';
      newProjectOcrLanguage = 'ja';
      workflow = 'typeset';
    });
  });

  function onTargetChange() {
    number = nextNumberFor(target);
  }

  // Native file pickers (Tauri only).
  async function picking(label, fn) {
    try {
      await fn();
    } catch (e) {
      error = `${label} - ${e?.message ?? e}`;
    }
  }

  const PICKER = 'Could not open the file picker';

  const pickRaws = () =>
    picking(PICKER, async () => {
      const picked = await pickImageFiles(true);
      if (picked) files = [...picked];
    });

  const pickCleaned = () =>
    picking(PICKER, async () => {
      const picked = await pickImageFiles(true);
      if (picked) cleaned = [...picked];
    });

  // Reading a package prefills the fields it knows - number, title, and for a
  // new project its name and layout - all of which stay editable.
  async function pickPackage() {
    error = '';
    reading = true;
    try {
      const file = await pickPackageFile();
      if (!file) return;
      const read = await inspectPackage(file, target === '__new__' ? null : target);
      pkg = read.pkg;
      pkgSummary = read.summary;
      pkgName = file.name ?? '';
      number = read.summary.number;
      title = read.summary.title;
      if (!newProjectName.trim()) newProjectName = read.summary.projectName ?? '';
      newProjectLayout = read.summary.layout;
      newProjectOcrLanguage = read.summary.ocrLanguage;
    } catch (e) {
      pkg = null;
      pkgSummary = null;
      error = `Could not read that package: ${e?.message ?? e}`;
    } finally {
      reading = false;
    }
  }

  const layoutLabel = (l) => (l === 'longstrip' ? 'Longstrip' : 'Pages');

  const pickTranslations = () =>
    picking('Could not read that translations file', async () => {
      const picked = await pickJsonFile();
      if (!picked || !picked[0]) return;
      // Validate translation JSON on selection.
      translations = { name: picked[0].name, pages: await readTranslations(picked[0]) };
    });

  // Preview positional page count.
  const summary = $derived.by(() => {
    if (isPackage) {
      const sm = pkgSummary;
      if (!sm) return [];
      const notes = [];
      let head = plural(sm.pageCount, 'page');
      if (sm.cleanedCount) head += ` · ${sm.cleanedCount} cleaned`;
      if (sm.boxCount) head += ` · ${plural(sm.boxCount, 'box', 'boxes')}`;
      head += ` · ${sm.mode} chapter`;
      notes.push({ text: head, warn: false });
      const by = (st) => sm.fonts.filter((f) => f.status === st);
      const bits = [];
      if (by('install').length) bits.push(`${by('install').length} to install`);
      if (by('present').length) bits.push(`${by('present').length} already here`);
      // Only said with the Rust engine on (package-flow.js, `fontStatus`).
      if (by('system').length) bits.push(`${by('system').length} installed on this computer`);
      if (bits.length) notes.push({ text: `Fonts - ${bits.join(', ')}`, warn: false });
      const missing = by('missing').map((f) => f.name);
      if (missing.length) {
        notes.push({
          text: `${plural(missing.length, 'font')} not in the package - will use a fallback (${missing.join(', ')})`,
          warn: true,
        });
      }
      const fresh = sm.tags.filter((t) => t.status === 'new').length;
      if (sm.tags.length) {
        const tb = [];
        if (fresh) tb.push(`${fresh} new`);
        if (sm.tags.length - fresh) tb.push(`${sm.tags.length - fresh} known`);
        notes.push({ text: `Tags - ${tb.join(', ')}`, warn: false });
      }
      const tp = target === '__new__' ? null : library.projects.find((p) => p.id === target);
      if (tp && tp.layout !== sm.layout) {
        notes.push({
          text: `This package was made for a ${layoutLabel(sm.layout)} project. It will still import.`,
          warn: true,
        });
      }
      const src = [];
      if (sm.projectName) src.push(`From "${sm.projectName}"`);
      if (sm.app) src.push(`v${sm.app}`);
      const when = relativeTime(sm.exportedAt);
      if (when) src.push(`exported ${when}`);
      if (src.length) notes.push({ text: src.join(' · '), warn: false });
      return notes;
    }
    if (!files.length) return [];
    const notes = [{ text: `${plural(files.length, 'page')} in this chapter.`, warn: false }];

    if (!cleaned.length) {
      notes.push({ text: 'No cleaned pages - every page typesets on its raw.', warn: false });
    } else if (cleaned.length === files.length) {
      notes.push({ text: `All ${files.length} pages will use a cleaned image.`, warn: false });
    } else if (cleaned.length < files.length) {
      notes.push({
        text: `${cleaned.length} of ${files.length} pages will use a cleaned image; pages ${cleaned.length + 1}–${files.length} keep their raw.`,
        warn: true,
      });
    } else {
      notes.push({
        text: `${files.length} cleaned images pair with a page; the last ${cleaned.length - files.length} are ignored.`,
        warn: true,
      });
    }

    if (translations) {
      const covered = Math.min(translations.pages.length, files.length);
      const lines = translations.pages.slice(0, covered).reduce((n, pg) => n + pg.lines.length, 0);
      if (translations.pages.length === files.length) {
        notes.push({ text: `Translations for all ${files.length} pages - ${plural(lines, 'line')}.`, warn: false });
      } else if (translations.pages.length < files.length) {
        notes.push({
          text: `Translations cover pages 1–${translations.pages.length} of ${files.length} - ${plural(lines, 'line')}.`,
          warn: true,
        });
      } else {
        notes.push({
          text: `Translations describe ${translations.pages.length} pages; the last ${translations.pages.length - files.length} are ignored.`,
          warn: true,
        });
      }
    }
    return notes;
  });

  async function submit() {
    error = '';
    if (isPackage && !pkg) {
      error = 'Choose a package file first.';
      return;
    }
    if (!isPackage && !files.length) {
      error = 'Pick at least one raw page.';
      return;
    }
    if (target === '__new__' && !newProjectName.trim()) {
      error = 'Name the new project.';
      return;
    }
    const n = number === null || number === undefined || number === '' ? 1 : Number(number);
    if (!Number.isFinite(n) || n < 0) {
      error = 'Enter a valid chapter number.';
      return;
    }
    busy = true;

    let createdProject = null;
    try {
      if (target === '__new__') {
        createdProject = await createProject(newProjectName.trim(), {
          layout: newProjectLayout,
          ocrLanguage: newProjectOcrLanguage,
        });
      }
      const pid = createdProject ? createdProject.id : target;

      let chapter;
      let note;
      if (isPackage) {
        const r = await importChapterPackage({ pkg, projectId: pid, number: n, title });
        chapter = r.chapter;
        const parts = [plural(pkgSummary.pageCount, 'page')];
        if (r.fontsInstalled) parts.push(`${plural(r.fontsInstalled, 'font')} installed`);
        if (r.fontsFailed) parts.push(`${plural(r.fontsFailed, 'font')} could not be installed`);
        if (r.tagsAdded) parts.push(`${plural(r.tagsAdded, 'tag')} added`);
        note = parts.join(' · ');
      } else {
        chapter = await createChapter({
          projectId: pid,
          number: n,
          title,
          files,
          cleanedFiles: cleaned,
          translations: translations?.pages ?? null,
          mode: workflow,
        });
        note = `${plural(files.length, 'page')} copied`;
        if (cleaned.length) note += ` · ${Math.min(cleaned.length, files.length)} cleaned`;
      }
      open = false;
      toast(`Created chapter ${chapter.number} · ${note}`);
      await goEditor(pid, chapter.id);
    } catch (e) {

      const orphan = createdProject
        ? ` The project "${createdProject.name}" was created and is now empty.`
        : '';
      error = `Could not create the chapter: ${e?.message ?? e}.${orphan}`;

      toastError(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={(e) => e.target.classList.contains('modal-overlay') && !busy && (open = false)}
  >
    <div class="modal dialog-narrow">
      <div class="modal-head">New chapter</div>

      <div class="field">
        <span>Source</span>
        <div class="seg">
          <button class:on={source === 'files'} onclick={() => (source = 'files')} disabled={busy}>Pages</button>
          <button class:on={source === 'package'} onclick={() => (source = 'package')} disabled={busy}>Package</button>
        </div>
      </div>

      {#if isPackage}
        <div class="field">
          <span>Package</span>
          <button class="soft-btn" onclick={pickPackage} disabled={busy || reading}>
            {reading ? 'Reading…' : pkgName ? `${pkgName} - change` : 'Choose a .mtchapter…'}
          </button>
        </div>
      {/if}

      <label class="field">
        <span>Project</span>
        <select bind:value={target} onchange={onTargetChange}>
          {#each library.projects.filter((p) => !p.unreadable) as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
          <option value="__new__">New project…</option>
        </select>
      </label>

      {#if target === '__new__'}
        <label class="field">
          <span>Project name</span>
          <input bind:value={newProjectName} placeholder="Series name" />
        </label>

        <div class="field">
          <span>Layout</span>
          <div class="seg">
            <button class:on={newProjectLayout === 'pages'} onclick={() => (newProjectLayout = 'pages')} disabled={busy}>Pages</button>
            <button class:on={newProjectLayout === 'longstrip'} onclick={() => (newProjectLayout = 'longstrip')} disabled={busy}>Longstrip</button>
          </div>
        </div>

        <div class="field">
          <span>Language</span>
          <div class="seg">
            <button class:on={newProjectOcrLanguage === 'ja'} onclick={() => (newProjectOcrLanguage = 'ja')} disabled={busy}>Japanese</button>
            <button class:on={newProjectOcrLanguage === 'zh'} onclick={() => (newProjectOcrLanguage = 'zh')} disabled={busy}>Chinese</button>
            <button class:on={newProjectOcrLanguage === 'ko'} onclick={() => (newProjectOcrLanguage = 'ko')} disabled={busy}>Korean</button>
          </div>
        </div>
      {/if}

      <label class="field">
        <span>Chapter number</span>
        <input type="number" min="0" bind:value={number} />
      </label>

      <label class="field">
        <span>Title</span>
        <input bind:value={title} placeholder="Optional" />
      </label>

      {#if isPackage}
        <!-- everything a package carries is described in the notes below -->
      {:else}

        <div class="field">
          <span>Mode</span>
          <div class="seg">
            <button class:on={workflow === 'typeset'} onclick={() => (workflow = 'typeset')} disabled={busy}>Typeset</button>
            <button class:on={workflow === 'translate'} onclick={() => (workflow = 'translate')} disabled={busy}>Translate</button>
          </div>
        </div>

        <div class="field">
          <span>Raw pages</span>
          <button class="soft-btn" onclick={pickRaws} disabled={busy}>
            {files.length ? `${files.length} selected - change` : 'Choose files…'}
          </button>
        </div>

        <div class="field">
          <span>Cleaned pages</span>
          <button class="soft-btn" onclick={pickCleaned} disabled={busy}>
            {cleaned.length ? `${cleaned.length} selected - change` : 'Choose files…'}
          </button>
          {#if cleaned.length}
            <button class="soft-btn slim" onclick={() => (cleaned = [])} disabled={busy}>Clear</button>
          {/if}
        </div>

        <div class="field">
          <span>Translations</span>
          <button class="soft-btn" onclick={pickTranslations} disabled={busy}>
            {translations ? `${translations.name} - change` : 'Choose a JSON…'}
          </button>
          {#if translations}
            <button class="soft-btn slim" onclick={() => (translations = null)} disabled={busy}>Clear</button>
          {/if}
        </div>
      {/if}

      {#each summary as note}
        <div class="pair-note" class:warn={note.warn}>{note.text}</div>
      {/each}

      {#if error}<div class="home-error">{error}</div>{/if}

      <div class="modal-foot">
        <button class="soft-btn" onclick={() => (open = false)} disabled={busy}>Cancel</button>
        <button class="accent-btn narrow" onclick={submit} disabled={busy}>
          {busy ? (isPackage ? 'Importing…' : 'Copying…') : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}
