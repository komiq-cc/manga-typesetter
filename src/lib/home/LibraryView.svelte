<script>
  import { onMount } from 'svelte';
  import { library, scanLibrary, createProject, deleteProject } from '../library.svelte.js';
  import { goProject } from '../route.svelte.js';
  import { toast, toastError } from '../store.svelte.js';
  import { plural } from '../format.js';
  import ProjectCard from './ProjectCard.svelte';

  let { onNewChapter } = $props();

  let confirmingId = $state(null); // inline two-step delete confirm
  let naming = $state(false);
  let newName = $state('');
  // Project reading layout.
  let layout = $state('pages');
  let ocrLanguage = $state('ja');

  onMount(scanLibrary);

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    naming = false;
    newName = '';
    const chosen = layout;
    const chosenLanguage = ocrLanguage;
    layout = 'pages';
    ocrLanguage = 'ja';

    try {
      const p = await createProject(name, { layout: chosen, ocrLanguage: chosenLanguage });
      goProject(p.id);
    } catch (e) {
      toastError(`Could not create ${name}: ${e?.message ?? e}`);
    }
  }

  function pageCountOf(project) {
    return project.chapters.reduce((n, c) => n + c.pageCount, 0);
  }

  async function onDelete(project) {
    if (confirmingId !== project.id) {
      confirmingId = project.id;
      return;
    }
    confirmingId = null;
    try {
      await deleteProject(project.id);
      toast(`Deleted ${project.name}`);
    } catch (e) {
      toastError(`Could not delete: ${e?.message ?? e}`);
    }
  }
</script>

<div class="home-actions">
  <button class="accent-btn" onclick={onNewChapter}>New chapter</button>
  {#if naming}
    <input
      class="name-input"
      placeholder="Project name"
      bind:value={newName}
      onkeydown={(e) => e.key === 'Enter' && onCreate()}
      autofocus
    />

    <div class="seg new-layout">
      <button class:on={layout === 'pages'} onclick={() => (layout = 'pages')}>Pages</button>
      <button class:on={layout === 'longstrip'} onclick={() => (layout = 'longstrip')}>Longstrip</button>
    </div>
    <div class="seg new-language" aria-label="Source language">
      <button class:on={ocrLanguage === 'ja'} onclick={() => (ocrLanguage = 'ja')}>Japanese</button>
      <button class:on={ocrLanguage === 'zh'} onclick={() => (ocrLanguage = 'zh')}>Chinese</button>
      <button class:on={ocrLanguage === 'ko'} onclick={() => (ocrLanguage = 'ko')}>Korean</button>
    </div>
    <button class="soft-btn wide" onclick={onCreate}>Create</button>
  {:else}
    <button class="soft-btn wide" onclick={() => (naming = true)}>New project</button>
  {/if}
</div>

<div class="section-label">PROJECTS</div>

{#if library.error}
  <div class="home-error" role="alert">
    <div>{library.error}</div>
    <button class="soft-btn" onclick={scanLibrary}>Try again</button>
  </div>
{/if}

{#if library.projects.length}
  <div class="pgrid">
    {#each library.projects as project (project.id)}
      <ProjectCard
        {project}
        onOpen={(p) => goProject(p.id)}
        onDelete={onDelete}
      />
      {#if confirmingId === project.id}
        <div class="confirm-note warn" role="alert">
          Moves the folder and every chapter in it to the trash - {plural(pageCountOf(project), 'page')}.
          Click Delete again to confirm.
        </div>
      {/if}
    {/each}
  </div>
{:else if library.loading}

  <div class="home-empty">Reading your library…</div>
{:else if !library.error}

  <div class="home-empty">
    <div>No projects yet.</div>
    <div>Start a chapter and the raws you pick will be copied into your library.</div>
  </div>
{/if}
