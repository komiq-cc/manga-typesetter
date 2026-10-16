<script>
  import { getVersion } from '@tauri-apps/api/app';
  import { installUpdate } from '../updater.js';
  import { toast, toastError } from '../store.svelte.js';
  import { isTauri } from '../importer.js';

  let { open = $bindable(false), update = null } = $props();

  let currentVersion = $state('');
  let downloading = $state(false);
  let percent = $state(null);
  let error = $state('');

  $effect(() => {
    if (open) {
      error = '';
      if (!currentVersion) {
        if (isTauri()) {
          getVersion()
            .then((v) => (currentVersion = v))
            .catch(() => {
              currentVersion = update?.currentVersion ?? '';
            });
        } else {
          currentVersion = update?.currentVersion ?? '';
        }
      }
    }
  });

  const curVer = $derived(
    currentVersion ? (currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`) : '-'
  );
  const newVer = $derived(
    update?.version ? (update.version.startsWith('v') ? update.version : `v${update.version}`) : '-'
  );

  function onKeydown(e) {
    if (e.key === 'Escape' && open && !downloading) {
      e.stopImmediatePropagation();
      open = false;
    }
  }

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay') && !downloading) {
      open = false;
    }
  }

  async function onDownload() {
    if (!update || downloading) return;
    downloading = true;
    percent = null;
    error = '';
    try {
      await installUpdate(update, (progress) => {
        if (progress.percent !== null && progress.percent !== undefined) {
          percent = progress.percent;
        }
      });
    } catch (e) {
      downloading = false;
      percent = null;
      const msg = e?.message ?? String(e);
      error = msg;
      toastError(`Update failed: ${msg}`);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="modal-overlay open"
    role="presentation"
    onclick={onOverlayClick}
  >
    <div class="modal dialog-narrow update-dialog">
      <div class="modal-head">Update available</div>

      <div class="field version-field">
        <span>Version</span>
        <div class="version-val">
          <span class="ver-curr">{curVer}</span>
          <span class="ver-arrow">→</span>
          <span class="ver-next">{newVer}</span>
        </div>
      </div>

      <div class="notes-section">
        <div class="notes-label">Release notes</div>
        {#if update?.body && update.body.trim()}
          <div class="notes-box">{update.body.trim()}</div>
        {:else}
          <div class="notes-box empty">No release notes.</div>
        {/if}
      </div>

      {#if downloading}
        <div class="progress-section">
          <div class="progress-meta">
            <span>Downloading update…</span>
            <span class="progress-pct">{percent !== null ? `${percent}%` : ''}</span>
          </div>
          <div class="progress-track">
            <div
              class="progress-fill"
              class:indeterminate={percent === null}
              style={percent !== null ? `width: ${percent}%` : ''}
            ></div>
          </div>
        </div>
      {/if}

      {#if error}
        <div class="home-error">{error}</div>
      {/if}

      <div class="modal-foot">
        <button
          class="soft-btn"
          onclick={() => (open = false)}
          disabled={downloading}
        >
          Later
        </button>
        <button
          class="accent-btn narrow"
          onclick={onDownload}
          disabled={downloading || !update}
        >
          {#if downloading}
            {percent !== null ? `Downloading ${percent}%…` : 'Downloading…'}
          {:else}
            Download update
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .update-dialog {
    width: 420px;
  }
  .version-field {
    margin-bottom: 14px;
  }
  .version-val {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .ver-curr {
    color: var(--t2);
  }
  .ver-arrow {
    color: var(--t3);
    font-size: 11px;
  }
  .ver-next {
    color: var(--text);
    font-weight: 600;
  }
  .notes-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .notes-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t3);
    font-weight: 600;
  }
  .notes-box {
    max-height: 180px;
    min-height: 60px;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .notes-box.empty {
    display: flex;
    align-items: center;
    color: var(--t3);
    font-style: italic;
    white-space: normal;
  }
  .progress-section {
    margin-bottom: 14px;
  }
  .progress-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11.5px;
    color: var(--t2);
    margin-bottom: 6px;
  }
  .progress-pct {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text);
  }
  .progress-track {
    height: 4px;
    background: var(--line2);
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.15s ease;
  }
  .progress-fill.indeterminate {
    width: 35%;
    position: absolute;
    animation: indeterminate 1.4s infinite ease-in-out;
  }
  @keyframes indeterminate {
    0% {
      left: -35%;
    }
    100% {
      left: 100%;
    }
  }
</style>
