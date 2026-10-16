<script>
  import { app, dismissError } from './store.svelte.js';
  // Errors come from `app.errors` and stay; the passing toast is info only.
  const show = $derived(app.toast.msg !== '' && app.toast.kind !== 'error');
</script>

{#if app.errors.length}
  <div class="toast-errors" role="alert">
    {#each app.errors as e (e.id)}
      <div class="toast-error">
        <span class="msg">{e.msg}{#if e.count > 1}<span class="count">×{e.count}</span>{/if}</span>
        <button class="x" onclick={() => dismissError(e.id)} aria-label="Dismiss">✕</button>
      </div>
    {/each}
  </div>
{/if}
<div class="toast" class:show>{app.toast.kind === 'error' ? '' : app.toast.msg}</div>
