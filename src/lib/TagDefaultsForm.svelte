<script>
  // A tag's defaults - font, outline, size - and its Delete, as one piece. Two
  // places edit the same registry: the queue, on the line being worked, and
  // Settings ▸ Project, for the series as a whole. They share this so the two
  // cannot drift into saying or saving different things; the round trip itself
  // (`tagFormFields` in, `tagFormDefaults` out) is in tags.svelte.js.
  //
  // `form` is the caller's, bound: it holds the fields plus `tools` (are the
  // rows showing), `edit` (does the tag already exist, so it can be deleted) and
  // `confirmDelete`. The caller owns the name row and Save, because what Save
  // means differs - the queue also puts a new tag on its line. `key` keeps the
  // label ids unique when more than one form is on screen; `onforget` runs after
  // a delete, for the caller to close its form.
  import { fontGroups, fontCaveat } from './font-menu.js';
  import { deleteTag } from './tags.svelte.js';
  import { toast } from './store.svelte.js';
  import ColorPicker from './ColorPicker.svelte';

  let { form = $bindable(), key, onforget = null } = $props();

  function forget() {
    const name = form?.name;
    if (!name) return;
    onforget?.();
    if (deleteTag(name)) toast(`Forgot the defaults for “${name}” - lines keep the tag`);
  }
</script>

{#if form.tools}
  <span class="qtf-row">
    <label class="qtf-lbl" for="qtf-font-{key}">Font</label>
    <select id="qtf-font-{key}" value={form.font} onchange={(e) => (form.font = e.currentTarget.value)}>
      <option value="">-</option>
      {#if fontCaveat(form.font)}
        <option value={form.font}>{form.font} ({fontCaveat(form.font)})</option>
      {/if}
      {#each fontGroups() as g (g.key)}
        <optgroup label={g.label}>
          {#each g.fonts as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
        </optgroup>
      {/each}
    </select>
  </span>

  <span class="qtf-row">
    <label class="qtf-lbl" for="qtf-out-{key}">Outline</label>
    <input class="btick" id="qtf-out-{key}" type="checkbox" checked={form.outlineOn} onchange={(e) => (form.outlineOn = e.currentTarget.checked)} />
    {#if form.outlineOn}
      <ColorPicker value={form.outline} label="Outline colour" size={20} unclipped onchange={(hex) => (form.outline = hex)} />
      <input type="number" min="0" max="20" step="0.5" value={form.outlineWidth} oninput={(e) => (form.outlineWidth = Math.max(0, Math.min(20, +e.currentTarget.value || 0)))} />
    {/if}
  </span>

  <!-- The size a box of this tag starts at when no box of it comes
       before. Empty is no default. -->
  <span class="qtf-row">
    <label class="qtf-lbl" for="qtf-size-{key}">Size</label>
    <input id="qtf-size-{key}" type="number" min="6" max="200" step="1" placeholder="-" title="Font size, px" value={form.size} onchange={(e) => { const v = e.currentTarget.value.trim(); form.size = v === '' ? '' : Math.max(6, Math.min(200, +v || 6)); e.currentTarget.value = String(form.size); }} />
  </span>
{/if}
{#if form.edit}
  <span class="qtf-del">
    {#if form.confirmDelete}
      <span class="qtf-note">
        Forget “{form.name}”? It leaves your tag list and stops setting defaults for boxes placed from now on. Lines already tagged “{form.name}” keep the tag, and their boxes keep the style they were placed with - here and in every other chapter. While a line in this chapter still carries it, it stays in this list with no defaults.
      </span>
      <span class="qtf-delrow">
        <button class="qtf-danger" onclick={forget}>Forget it</button>
        <button class="qtf-quiet" onclick={() => (form.confirmDelete = false)}>Keep</button>
      </span>
    {:else}
      <button class="qtf-quiet" onclick={() => (form.confirmDelete = true)}>Delete tag…</button>
    {/if}
  </span>
{/if}
