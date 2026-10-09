<script>

  import { onDestroy } from 'svelte';
  import { app, saveExportPrefs, toast, setChapterTypesetMode } from './store.svelte.js';
  import { checkSidecar, modelsCacheInfo, clearModelsCache } from './sidecar.js';
  import { theme, setTheme } from './theme.svelte.js';
  import { library, setRoot, scanLibrary, withinHome } from './library.svelte.js';
  import { resetPanels } from './editor/panels.svelte.js';
  import { processMemory, ROLE_LABELS } from './memory.js';
  import { prefs, setPref } from './prefs.svelte.js';
  import { engineSwitch, engineHasNoFont } from './engine-switch.svelte.js';
  import { OCR_MODEL_OPTIONS } from './ocr-models.js';
  import {
    shortcutGroups,
    comboFor,
    defaultCombo,
    isCustomCombo,
    setCombo,
    resetCombo,
    resetAllCombos,
    formatCombo,
  } from './shortcuts.svelte.js';
  import { createRebindCapture } from './rebind-capture.js';
  import { getVersion } from '@tauri-apps/api/app';
  import { checkForUpdate } from './updater.js';
  import UpdateDialog from './home/UpdateDialog.svelte';

  let { open = $bindable() } = $props();

  // ---------- tabs ----------
  // Same shape as the Inspector's strip: a handful of panes, one job each,
  // instead of one long scroll where the section you want is always elsewhere.
  const TABS = [
    { id: 'general', label: 'General', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></svg>' },
    { id: 'typesetting', label: 'Typesetting', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></svg>' },
    { id: 'shortcuts', label: 'Shortcuts', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" /></svg>' },
    { id: 'system', label: 'System', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>' },
  ];
  let tab = $state('general');
  // The open chapter's line breaker.
  const smartHere = $derived(app.typesetting.mode === 'smart');
  // Whether the box defaults below reach any box: they are born into every
  // chapter, so they stay editable, and are only dimmed when neither the open
  // chapter nor a new one would lay them out with the smart breaker.
  const defaultsUsed = $derived(prefs.typeset || (!!app.chapterRef && smartHere));

  // The registry shortcut groups follow preferences like the brush tool toggle,
  // while each row combo comes from comboFor reading preferences.
  const groups = $derived(shortcutGroups());
  let capturing = $state(null); // shortcut id currently listening for a keypress
  let captureErr = $state('');
  let confirmResetKeys = $state(false);

  const capture = createRebindCapture(typeof window === 'undefined' ? null : window, {
    onKey: (combo, done) => {
      const r = setCombo(capturing, combo);
      if (r.ok) {
        done();
        capturing = null;
        captureErr = '';
        return;
      }
      captureErr =
        r.reason === 'conflict'
          ? `${formatCombo(combo)} is already “${r.conflict.label}”`
          : 'That key cannot be used - try another';
    },
    onCancel: () => {
      // Both cancel paths land here - bare Escape and the modal closing -
      // so the row stops presenting itself as still listening.
      capturing = null;
      captureErr = '';
    },
  });

  function beginCapture(id) {
    captureErr = '';
    capturing = capture.begin(id);
  }

  // While a row is listening, its keys are captured on the way down and
  // stopped there, so binding Cmd+1 does not also switch tool and Escape does
  // not close the settings modal out from under the row. The listener is armed
  // only while the modal is open AND a row is listening: closing the modal
  // mid-capture cancels the capture instead of leaving a window-wide key
  // snatcher behind.
  $effect(() => {
    capture.setOpen(open);
    capturing = capture.current;
  });
  onDestroy(() => capture.setOpen(false));

  function onResetKeys() {
    if (!confirmResetKeys) {
      confirmResetKeys = true;
      return;
    }
    confirmResetKeys = false;
    capture.end();
    capturing = null;
    captureErr = '';
    resetAllCombos();
    toast('Shortcuts back to their defaults');
  }

  let cache = $state(null); // { entries:[{path,exists,bytes}], total_bytes } | null
  let cacheLoading = $state(false);
  let clearing = $state(false);
  let confirmClear = $state(false); // inline two-step confirm (webviews may block window.confirm)
  let confirmResetPanels = $state(false); // same two-step; a reset cannot be undone

  // PSD export self-test (dev builds only).
  const DEV = !!import.meta.env?.DEV;
  let selfTesting = $state(false);
  let selfTest = $state(null); // the last report, or { error }

  async function onPsdSelfTest() {
    if (!app.pages.length) {
      toast('Open a chapter first - the self-test runs on the page you are looking at');
      return;
    }
    selfTesting = true;
    selfTest = null;
    try {

      const { psdSelfTest } = await import('./psd.js');
      selfTest = await psdSelfTest(app.pages[app.pageIndex]);
      toast(selfTest.ok ? 'PSD self-test passed' : 'PSD self-test FAILED - see Settings');
    } catch (e) {
      selfTest = { ok: false, error: String(e?.message ?? e) };
      toast('PSD self-test threw - see Settings');
    } finally {
      selfTesting = false;
    }
  }

  // Process memory tracking.
  let mem = $state(null); // MemoryReport | null (null = not the desktop app)
  let memLive = $state(false);

  async function loadMemory() {
    mem = await processMemory();
  }

  // Poll memory only while modal is open and live toggle is on.
  $effect(() => {
    if (!open || !memLive) return;
    const t = setInterval(loadMemory, 2000);
    return () => clearInterval(t);
  });


  $effect(() => {
    if (open) loadMemory();
  });

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }

  function isTauri() {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  }

  // ---------- updates ----------
  // The home screen checks once on launch and shows a badge if something is
  // there. That leaves no way to ask, which is the one thing a user wants after
  // reading that a release exists - so the ask lives here, and it reuses the
  // same check and the same dialog rather than growing a second update path.
  let appVersion = $state('');
  let checking = $state(false);
  // null = never asked this session; the Update object, or false for "nothing".
  let upd = $state(null);
  let updDialogOpen = $state(false);
  let updError = $state('');

  $effect(() => {
    if (!open || appVersion || !isTauri()) return;
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });

  async function onCheckUpdate() {
    if (checking) return;
    checking = true;
    updError = '';
    try {
      upd = (await checkForUpdate()) ?? false;
      // Found one: straight into the same dialog the home badge opens, because
      // the next thing the user wants is the notes and the Download button.
      if (upd) updDialogOpen = true;
    } catch (e) {
      upd = false;
      updError = e?.message ?? String(e);
    } finally {
      checking = false;
    }
  }

  function fmtBytes(n) {
    if (!n || n < 1) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  async function loadCache() {
    cacheLoading = true;
    cache = await modelsCacheInfo();
    cacheLoading = false;
  }

  async function onClearCache() {
    if (!confirmClear) {
      confirmClear = true;
      return;
    }
    confirmClear = false;
    clearing = true;
    try {
      const r = await clearModelsCache();
      toast(r?.ok ? `Cleared cache · freed ${fmtBytes(r.freed_bytes)}` : 'Cache clear had errors - see logs');
      await loadCache();
    } catch (e) {
      toast(`Clear cache failed: ${e}`);
    } finally {
      clearing = false;
    }
  }

  // Reset floating panel layout.
  function onResetPanels() {
    if (!confirmResetPanels) {
      confirmResetPanels = true;
      return;
    }
    confirmResetPanels = false;

    resetPanels(window.innerWidth, window.innerHeight);
    toast('Panel layout reset');
  }

  async function onChangeExportDir() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }
    try {
      const { open: pickDir } = await import('@tauri-apps/plugin-dialog');
      const dir = await pickDir({ directory: true, defaultPath: app.exportDir || undefined });
      if (dir) {
        saveExportPrefs(dir, app.exportName);
        toast('Default export folder set');
      }
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }

  function setOcrModel(language, model) {
    setPref('ocrModels', { ...prefs.ocrModels, [language]: model });
    const label = language === 'zh' ? 'Chinese' : 'Korean';
    toast(`${label} OCR model changed`);
  }

  async function chooseRoot() {
    if (!isTauri()) {
      toast('Choosing a folder needs the desktop app');
      return;
    }

    if (app.chapterRef) {
      toast('Close the open chapter before changing the library folder');
      return;
    }
    try {
      const { open: pick } = await import('@tauri-apps/plugin-dialog');
      const dir = await pick({ directory: true, defaultPath: library.root });
      if (!dir) return;
      // Library folder must be inside home directory.
      if (!(await withinHome(dir))) {
        toast('The library has to live inside your home folder for now.');
        return;
      }
      await setRoot(dir);
      await scanLibrary();
      toast('Library folder changed');
    } catch (e) {
      toast(`Couldn't set folder: ${e}`);
    }
  }


  $effect(() => {
    if (open) {
      confirmClear = false;
      confirmResetPanels = false;
      confirmResetKeys = false;
      capturing = null;
      captureErr = '';
      checkSidecar();
      loadCache();
    }
  });

  const sidecarOk = $derived(app.sidecar?.status === 'ok');

  const sidecarLabel = $derived(
    app.sidecar?.status === 'ok'
      ? `Ready · ${app.sidecar.info?.engine ?? 'onnx-rust'} · ${app.sidecar.device ?? '-'}`
      : app.sidecar?.status === 'unavailable'
        ? 'Unavailable - desktop app only'
        : app.sidecar?.status === 'error'
          ? 'Error - see logs'
          : 'Checking…',
  );

</script>

<!-- One switch, written once. Every preference toggle in here is the same three
     things - a knob, the preference it writes, and the name a screen reader
     reads - and the row that spells them out by hand is the row that ends up
     writing the wrong key. `disabled` is a look and a refusal, not an attribute:
     the element is a div, so it also leaves the tab order. `set` is for the one
     switch that writes the open chapter rather than a preference. -->
{#snippet toggle(key, label, on, disabled = false, set = null)}
  <div
    class="switch"
    class:on
    class:disabled
    role="switch"
    aria-checked={on}
    aria-label={label}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
    onclick={() => !disabled && (set ? set(!on) : setPref(key, !on))}
    onkeydown={(e) => {
      if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        if (set) set(!on);
        else setPref(key, !on);
      }
    }}
  ><span class="knob"></span></div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      <h3>Settings</h3>
      <button class="x" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="set-tabs" role="tablist" aria-label="Settings sections">
      {#each TABS as t (t.id)}
        <button
          role="tab"
          id="set-tab-{t.id}"
          class="set-tab"
          class:on={tab === t.id}
          aria-selected={tab === t.id}
          aria-controls="set-pane-{t.id}"
          onclick={() => {
            // A row waiting for keys stops waiting when its pane goes away.
            if (capturing) { capture.end(); capturing = null; captureErr = ''; }
            tab = t.id;
          }}
        >
          {@html t.icon}
          <span>{t.label}</span>
        </button>
      {/each}
    </div>

    <div class="modal-body">
      {#if tab === 'general'}
      <div class="set-pane" role="tabpanel" id="set-pane-general" aria-labelledby="set-tab-general">
      <div class="settings-section">
        <div class="settings-title">APPEARANCE</div>
        <div class="field">
          <span>Theme</span>

          <div class="seg">
            <button class:on={theme.mode === 'light'} onclick={() => setTheme('light')}>Light</button>
            <button class:on={theme.mode === 'dark'} onclick={() => setTheme('dark')}>Dark</button>
            <button class:on={theme.mode === 'system'} onclick={() => setTheme('system')}>
              System{theme.mode === 'system' ? ` · ${theme.resolved}` : ''}
            </button>
          </div>
        </div>
        <div class="field">
          <span>Panel layout</span>
          <div class="field-actions">
            <button class="btn tiny" class:danger={confirmResetPanels} onclick={onResetPanels}>
              {confirmResetPanels ? 'Confirm - reset?' : 'Reset'}
            </button>
            {#if confirmResetPanels}
              <button class="btn tiny" onclick={() => (confirmResetPanels = false)}>Cancel</button>
            {/if}
          </div>
        </div>
        <div class="qhint">Puts the Text Box Options and Text Queue windows back to their starting size and place.</div>
      </div>

      <div class="settings-section">
        <div class="settings-title">EDITOR</div>
        <div class="field">
          <span>Inherit previous box settings</span>
          {@render toggle('inheritBoxStyle', 'Inherit previous box settings', prefs.inheritBoxStyle)}
        </div>
        <div class="qhint">In Place and Text modes, reuse the previous box’s angle and text styling. Turn off to start new boxes with app and tag defaults.</div>
        <div class="field">
          <span>Brush tool (work in progress)</span>
          {@render toggle('brushTool', 'Brush tool (work in progress)', prefs.brushTool)}
        </div>
        <div class="qhint">Unfinished and hidden by default.</div>
      </div>

      <div class="settings-section">
        <div class="settings-title">LIBRARY</div>
        <div class="field">
          <span>Folder</span>
          <code class="path" title={library.root}>{library.root}</code>
        </div>
        <button
          class="btn"
          disabled={!isTauri() || !!app.chapterRef}
          title={app.chapterRef ? 'Close the open chapter first' : 'Pick a different library folder'}
          onclick={chooseRoot}
        >
          Change folder…
        </button>
        {#if app.chapterRef}
          <div class="qhint">Close the open chapter before changing the library folder.</div>
        {/if}
      </div>

      <div class="settings-section">
        <div class="settings-title">EXPORT</div>
        <div class="model-card">
          <div class="mc-top">
            <div class="mc-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
              <div>
                <div class="mc-name">Default export folder</div>
                <div class="mc-sub path" title={app.exportDir || ''}>
                  {app.exportDir || 'Not set - the export dialog asks each time'}
                </div>
              </div>
            </div>
          </div>
          <p class="mc-desc">Where <b>Export</b> saves by default. You can still choose a different folder at export time.</p>
          <div class="mc-actions">
            <button class="btn" disabled={!isTauri()} onclick={onChangeExportDir}>Change…</button>
            {#if app.exportDir}
              <button class="btn" onclick={() => { saveExportPrefs('', app.exportName); toast('Cleared default export folder'); }}>Clear</button>
            {/if}
          </div>
          {#if !isTauri()}
            <div class="qhint">Choosing a folder needs the desktop app; browser exports download to your default location.</div>
          {/if}
        </div>
      </div>
      </div>
      {/if}

      {#if tab === 'typesetting'}
      <div class="set-pane" role="tabpanel" id="set-pane-typesetting" aria-labelledby="set-tab-typesetting">
      <!-- The typesetting engine used to hang off every text box as its own
           Inspector sub-menu, which put a half-finished feature in front of
           everyone editing a line of dialogue. It lives here now - off, and
           labelled. The switch is the open chapter's, saved in its file so it
           opens the same on every machine (DET-3); the preference is only what
           a new chapter starts with. -->
      <div class="settings-section ts-section">
        <div class="settings-title">TYPESETTING <span class="beta-badge">Beta · work in progress</span></div>
        {#if app.chapterRef}
          <div class="field">
            <span>Smart line breaking · this chapter</span>
            {@render toggle(
              'typeset',
              'Smart line breaking for this chapter (beta)',
              smartHere,
              false,
              (on) => setChapterTypesetMode(on ? 'smart' : 'plain'),
            )}
          </div>
        {/if}
        <div class="field">
          <span>Smart line breaking · new chapters</span>
          {@render toggle('typeset', 'Smart line breaking for new chapters', prefs.typeset)}
        </div>
        <div class="qhint">
          Breaks lines to the shape of the balloon, hyphenates words that fit
          nowhere, and lays text out to a fitted balloon instead of its box.
          On by default for new chapters. With it off, boxes wrap plainly.
          Each chapter keeps its own setting, so it opens the same on any
          machine. A chapter made before this setting existed opens the way
          this computer had it then, and keeps that once saved.
        </div>

        <!-- The defaults a new box is born with. Auto height stands outside the
             beta gate because it is not part of it: it is on in every build and
             it is what makes a box grow with its text. The other four only mean
             anything while the engine above is on, so they are dimmed with it
             rather than hidden - a switch that vanishes is a switch nobody finds
             again. -->
        <div class="group-label">Defaults for new text boxes</div>
        <div class="field">
          <span>Auto height</span>
          {@render toggle('defaultAutoHeight', 'Auto height', prefs.defaultAutoHeight)}
        </div>
        <div class="qhint">
          A placed box's height follows its text inside its balloon: it grows
          and shrinks as the text changes, and text the balloon cannot hold is
          flagged. A box you drew yourself only grows, and never shrinks a box
          you made roomier.
        </div>
        <div class="ts-defaults" class:dim={!defaultsUsed}>
          <div class="field">
            <span>Shaped line breaks</span>
            {@render toggle('defaultShape', 'Shaped line breaks', prefs.defaultShape)}
          </div>
          <!-- The silhouette a shaped block aims for (BRK-3). Auto picks an oval
               in a balloon and a rectangle in a caption. -->
          <div class="field">
            <span>Block shape</span>
            <div class="seg" role="group" aria-label="Block shape">
              {#each [['auto', 'Auto'], ['oval', 'Oval'], ['rect', 'Rectangle']] as [v, label]}
                <button
                  class:on={prefs.defaultBlockShape === v}
                  disabled={!prefs.defaultShape}
                  onclick={() => setPref('defaultBlockShape', v)}
                >{label}</button>
              {/each}
            </div>
          </div>
          <div class="field">
            <span>Hyphenate long words</span>
            {@render toggle('defaultHyphenate', 'Hyphenate long words', prefs.defaultHyphenate)}
          </div>
          <div class="field">
            <span>Fit text to balloon</span>
            {@render toggle('defaultBalloon', 'Fit text to balloon', prefs.defaultBalloon)}
          </div>
          <div class="field">
            <label for="ts-orphan">Shortest word left alone on a line</label>
            <input
              id="ts-orphan"
              class="ts-num"
              type="number"
              min="1"
              max="8"
              step="1"
              value={prefs.defaultMinOrphan}
              title="A word shorter than this is never left alone at the end of a line"
              onchange={(e) => { setPref('defaultMinOrphan', e.target.value); e.target.value = prefs.defaultMinOrphan; }}
            />
          </div>
        </div>
        <div class="qhint">
          Applies to new text boxes · per-box via Bulk style. Boxes already on a
          page keep whatever they were given.
        </div>
      </div>

      <!-- Who measures text. Here with the rest of typesetting and not in the
           Inspector: it is one setting for the whole machine, and no box has a
           say in it. Disabled, and saying why, in a build made without the
           engine - the wasm is its own build step. -->
      <div class="settings-section">
        <div class="settings-title">TEXT ENGINE <span class="beta-badge">Experimental</span></div>
        <div class="field">
          <span>Measure text with the Rust engine</span>
          {@render toggle(
            'textEngine',
            'Measure text with the Rust engine',
            engineSwitch.available && prefs.textEngine === 'rust',
            !engineSwitch.available,
            (on) => setPref('textEngine', on ? 'rust' : 'browser'),
          )}
        </div>
        <div class="qhint">
          {#if !engineSwitch.available}
            Not in this build. The engine is built separately
            (<code>npm run build:engine</code>) and this copy of the app was made
            without it, so text is measured by the browser.
          {:else if engineSwitch.phase === 'starting'}
            Starting: loading the engine and your fonts. Text is laid out again
            once it is in.
          {:else if engineSwitch.phase === 'failed'}
            Could not start - {engineSwitch.error}. Text is measured by the
            browser. Turn the switch off and on to try again.
          {:else if engineHasNoFont()}
            Switched on, but nothing is measuring: the Rust engine has no font
            it can read, and it measures only in fonts this computer has. Add
            a font in the Font Library and it starts by itself. Until then
            text is laid out by estimate and no box is resized.
          {:else if engineSwitch.phase === 'on'}
            On. Line breaks and box sizes are measured from your font files and
            this computer's fonts, the same on every system. A font this
            computer does not have, the built-in web fonts included, is set in
            {engineSwitch.lastResort} and listed as missing in the Text Queue.
            A chapter lettered before this engine is not changed on disk by
            opening it: the Text Queue says what the engine changed, and that
            is saved when you edit the chapter or keep the changes.
          {:else}
            Off: text is measured by the browser, as before. On, line breaks
            and box sizes are measured from your font files and this computer's
            fonts instead. Drawing is unchanged. The switch is this computer's.
            A chapter saved with it on is marked as fitted by the engine; one
            that is not is told so in the Text Queue the first time it is
            opened with the switch on, and nothing is saved by opening it.
          {/if}
        </div>
      </div>

      </div>
      {/if}

      {#if tab === 'shortcuts'}
      <div class="set-pane" role="tabpanel" id="set-pane-shortcuts" aria-labelledby="set-tab-shortcuts">
      <!-- Every key the editor answers to by name. The three contextual ones -
           Escape, Tab and the arrows - are listed at the bottom as what they
           are: fixed, because their meaning depends on what is selected. -->
      <div class="settings-section">
        <div class="settings-title">SHORTCUTS</div>
        <div class="qhint sc-intro">
          Click a shortcut, then press the keys you want. <b>Esc</b> cancels.
        </div>

        {#each groups as g (g.name)}
          <div class="group-label">{g.name}</div>
          {#each g.items as s (s.id)}
            <div class="sc-row" class:capturing={capturing === s.id}>
              <span class="sc-label">{s.label}</span>
              <button
                class="sc-combo"
                class:custom={isCustomCombo(s.id)}
                class:listening={capturing === s.id}
                title={capturing === s.id
                  ? 'Press the keys - Esc cancels'
                  : `Click to rebind · default ${formatCombo(defaultCombo(s.id))}`}
                onclick={() => beginCapture(s.id)}
              >
                {capturing === s.id ? 'Press keys…' : formatCombo(comboFor(s.id))}
              </button>
              <button
                class="btn tiny sc-reset"
                disabled={!isCustomCombo(s.id)}
                title="Back to {formatCombo(defaultCombo(s.id))}"
                onclick={() => { resetCombo(s.id); if (capturing === s.id) { capture.end(); capturing = null; } }}
              >
                Default
              </button>
            </div>
            {#if capturing === s.id && captureErr}
              <div class="sc-err">{captureErr}</div>
            {/if}
          {/each}
        {/each}

        <div class="mc-actions">
          <button class="btn" class:danger={confirmResetKeys} onclick={onResetKeys}>
            {confirmResetKeys ? 'Confirm - reset every shortcut?' : 'Reset all shortcuts'}
          </button>
          {#if confirmResetKeys}
            <button class="btn" onclick={() => (confirmResetKeys = false)}>Cancel</button>
          {/if}
        </div>

        <div class="qhint">
          Fixed, because what they do depends on what you have selected:
          <b>Esc</b> closes whatever is open and then deselects,
          <b>Tab</b> steps through the boxes on the page, and the
          <b>arrows</b> nudge the selected box - or turn the page when nothing
          is selected. Hold <b>Shift</b> with an arrow for a bigger nudge.
        </div>
      </div>
      </div>
      {/if}

      {#if tab === 'system'}
      <div class="set-pane" role="tabpanel" id="set-pane-system" aria-labelledby="set-tab-system">
      <div class="group-label">Updates</div>

      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 19h16" /></svg>
            <div>
              <div class="mc-name">Manga Typesetter</div>
              <div class="mc-sub">
                {#if appVersion}Version {appVersion}
                {:else if isTauri()}Reading version…
                {:else}Desktop app only - a browser tab cannot update itself.{/if}
              </div>
            </div>
          </div>
          {#if upd}<span class="tag">v{upd.version}</span>{/if}
        </div>

        <p class="mc-desc">
          Checks the release channel for a newer build. Found updates download
          and install in place, then the app restarts.
        </p>

        <div class="mc-actions">
          <button class="btn" disabled={checking || !isTauri()} onclick={onCheckUpdate}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {#if upd}
            <button class="btn btn-accent" onclick={() => (updDialogOpen = true)}>
              Update to v{upd.version}
            </button>
          {/if}
        </div>

        {#if updError}
          <div class="qhint">Check failed: {updError}</div>
        {:else if upd === false}
          <div class="qhint">You are on the newest version.</div>
        {/if}
      </div>

      <div class="group-label">Engine</div>

      <div class="srow">
        <span class="slabel">Detection engine</span>
        <span class="dot {sidecarOk ? 'ok' : app.sidecar?.status === 'error' ? 'err' : 'off'}"></span>
        <span class="sval">{sidecarLabel}</span>
      </div>
      {#if sidecarOk && app.sidecar.info?.gpu_build === false}
        <div class="qhint">
          CPU-only build. GPU acceleration needs the Linux (GPU) download, which runs on
          glibc 2.39 or newer: Ubuntu 24.04, Fedora 40, Debian 13, Arch or newer.
        </div>
      {/if}

      <div class="group-label">Models</div>

      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>
            <div>
              <div class="mc-name">Language-specific OCR</div>
              <div class="mc-sub">Choose the recognizer used after text detection</div>
            </div>
          </div>
          <span class="tag auto">On demand</span>
        </div>

        <div class="ocr-model-grid">
          <div class="ocr-model-row">
            <span>
              <b>Japanese</b>
              <small>{OCR_MODEL_OPTIONS.ja[0].detail}</small>
            </span>
            <span class="ocr-fixed">{OCR_MODEL_OPTIONS.ja[0].label}</span>
          </div>

          <label class="ocr-model-row">
            <span>
              <b>Chinese</b>
              <small>Used by Chinese projects</small>
            </span>
            <select
              aria-label="Chinese OCR model"
              value={prefs.ocrModels.zh}
              onchange={(e) => setOcrModel('zh', e.currentTarget.value)}
            >
              {#each OCR_MODEL_OPTIONS.zh as model (model.id)}
                <option value={model.id}>{model.label} — {model.detail}</option>
              {/each}
            </select>
          </label>

          <label class="ocr-model-row">
            <span>
              <b>Korean</b>
              <small>Used by Korean projects</small>
            </span>
            <select
              aria-label="Korean OCR model"
              value={prefs.ocrModels.ko}
              onchange={(e) => setOcrModel('ko', e.currentTarget.value)}
            >
              {#each OCR_MODEL_OPTIONS.ko as model (model.id)}
                <option value={model.id}>{model.label} — {model.detail}</option>
              {/each}
            </select>
          </label>
        </div>

        <p class="mc-desc">
          Quality models are selected by default. The chosen model downloads on
          the next <b>Detect</b>; changing it does not alter the project's saved language.
        </p>
      </div>

      <!-- Model cache footprint + clear -->
      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" /></svg>
            <div>
              <div class="mc-name">Model cache</div>
              <div class="mc-sub">
                {#if cacheLoading}Measuring…{:else if cache}{fmtBytes(cache.total_bytes)} on disk{:else}Size unavailable - desktop app only{/if}
              </div>
            </div>
          </div>
          {#if cache}<span class="tag">{fmtBytes(cache.total_bytes)}</span>{/if}
        </div>

        {#if cache?.entries?.length}
          <div class="paths">
            {#each cache.entries as e}
              <div class="path-row">
                <span class="path" title={e.path}>{e.path}</span>
                <span class="path-size">{e.exists ? fmtBytes(e.bytes) : '-'}</span>
              </div>
            {/each}
          </div>
        {/if}

        <p class="mc-desc">
          Downloaded detector/OCR weights. Clearing frees disk; they re-download
          on the next <b>Detect</b>.
        </p>

        <div class="mc-actions">
          <button
            class="btn"
            class:danger={confirmClear}
            disabled={clearing || !sidecarOk || !cache || cache.total_bytes === 0}
            onclick={onClearCache}
          >
            {#if clearing}Clearing…{:else if confirmClear}Confirm - delete weights?{:else}Clear cache{/if}
          </button>
          {#if confirmClear}
            <button class="btn" disabled={clearing} onclick={() => (confirmClear = false)}>Cancel</button>
          {/if}
          <button class="btn" disabled={cacheLoading || !isTauri()} onclick={loadCache}>Recheck</button>
        </div>

        {#if !sidecarOk}
          <div class="qhint">The detection engine isn't reporting - cache actions need the desktop app.</div>
        {/if}
      </div>

      <div class="group-label">Memory</div>


      <div class="model-card">
        <div class="mc-top">
          <div class="mc-title">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="10" rx="2" /><path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3" /></svg>
            <div>
              <div class="mc-name">Live footprint</div>
              <div class="mc-sub">
                {#if !mem}Desktop app only - a browser tab cannot see its own host process.
                {:else if !mem.supported}Not available on this platform.
                {:else}{mem.processes.length} process{mem.processes.length === 1 ? '' : 'es'}, this app and everything it is responsible for.{/if}
              </div>
            </div>
          </div>
          {#if mem?.supported}<span class="tag">{fmtBytes(mem.total)}</span>{/if}
        </div>

        {#if mem?.supported && mem.processes.length}
          <div class="paths">
            {#each mem.processes as pr (pr.pid)}
              <div class="path-row">
                <span class="path" title="{pr.name} · pid {pr.pid} · matched by {pr.via}">
                  {ROLE_LABELS[pr.role] ?? pr.name}
                </span>
                <span class="path-size">{fmtBytes(pr.bytes)}</span>
              </div>
            {/each}
          </div>
        {/if}

        <p class="mc-desc">
          Physical footprint, the same measure Activity Monitor's <b>Memory</b>
          column uses - not RSS, which counts the shared system libraries once
          per process and would make this total several times too big. The
          web&nbsp;view is where page images live, so it is the row that moves
          when you open a long chapter.
        </p>

        {#if mem?.supported && mem?.incomplete}
          <div class="qhint">One or more processes went away while being measured - the total is short.</div>
        {/if}

        {#if mem?.processes?.some((pr) => pr.via === 'session')}
          <div class="qhint">
            Web view rows matched by launch session - this is a development build started
            from a terminal. A released app matches its web view exactly.
          </div>
        {/if}

        <div class="mc-actions">
          <button class="btn" disabled={!isTauri()} onclick={loadMemory}>Refresh</button>

          <button class="btn" class:btn-accent={memLive} disabled={!isTauri()} onclick={() => (memLive = !memLive)}>
            {memLive ? 'Stop live' : 'Live (2s)'}
          </button>
        </div>
      </div>

      {#if DEV}
        <div class="group-label">Developer</div>


        <div class="model-card">
          <div class="mc-top">
            <div class="mc-title">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6v4l4 10a3 3 0 0 1-3 4H8a3 3 0 0 1-3-4L9 7z" /><path d="M8 14h8" /></svg>
              <div>
                <div class="mc-name">PSD export self-test</div>
                <div class="mc-sub">Runs on the page you have open</div>
              </div>
            </div>
          </div>
          <p class="mc-desc">
            Builds a PSD from the current page, reads it back, and checks the round-tripped project, the
            per-layer pixels, the flat-white composite and the group structure. Needs a real canvas, so
            the test suite cannot run it.
          </p>
          <div class="mc-actions">
            <button class="btn" disabled={selfTesting || !app.pages.length} onclick={onPsdSelfTest}>
              {selfTesting ? 'Running…' : 'Run self-test'}
            </button>
          </div>
          {#if !app.pages.length}
            <div class="qhint">Open a chapter first - the self-test runs on the page you are looking at.</div>
          {/if}
          {#if selfTest}
            <pre class="mc-report" class:bad={!selfTest.ok}>{JSON.stringify(selfTest, null, 2)}</pre>
          {/if}
        </div>
      {/if}
      </div>
      {/if}
    </div>
  </div>
</div>

<!-- The same dialog the home badge opens, mounted here too so a check made
     from Settings lands somewhere. -->
<UpdateDialog bind:open={updDialogOpen} update={upd || null} />

<style>
  /* The tab strip, same grammar as the Inspector's: icon over label, the open
     one filled with the accent. It lives between the head and the scrolling
     body, so it never scrolls away. */
  .set-tabs {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: repeat(4, minmax(64px, 1fr));
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .set-tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 46px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    min-width: 0;
  }
  .set-tab :global(svg) {
    width: 18px;
    height: 18px;
  }
  .set-tab span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .set-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .set-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .set-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .srow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 4px 2px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 14px;
  }
  .slabel {
    color: var(--t2);
  }
  .sval {
    margin-left: 2px;
    color: var(--text);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--t3);
  }
  .dot.ok {
    background: var(--text);
  }
  .dot.err {
    background: var(--warn);
  }
  .group-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--t2);
    margin-bottom: 8px;
  }
  .model-card {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    background: var(--panel2);
  }
  .ocr-model-grid {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .ocr-model-row {
    display: grid;
    grid-template-columns: minmax(120px, 0.8fr) minmax(190px, 1.2fr);
    align-items: center;
    gap: 14px;
  }
  .ocr-model-row > span:first-child {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ocr-model-row b {
    color: var(--text);
    font-size: 12.5px;
  }
  .ocr-model-row small,
  .ocr-fixed {
    color: var(--t2);
    font-size: 11px;
  }
  .ocr-model-row select {
    min-width: 0;
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
  .ocr-model-row select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .ocr-fixed {
    padding: 0 9px;
  }
  .mc-top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .mc-title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }
  .mc-title svg {
    flex: none;
    color: var(--t2);
  }
  .mc-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text);
  }
  .mc-sub {
    font-size: 11.5px;
    color: var(--t2);
  }
  .mc-desc {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--t2);
    margin: 10px 0 0;
  }

  .mc-report {
    margin: 10px 0 0;
    padding: 8px 10px;
    max-height: 220px;
    overflow: auto;
    border-radius: 6px;
    background: var(--panel2);
    color: var(--t2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
  }
  .mc-report.bad {
    color: var(--warn);
  }
  .mc-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .tag {
    flex: none;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel2);
    color: var(--t2);
    height: fit-content;
  }
  .tag.auto {
    background: var(--accent-soft);
    color: var(--text);
  }
  .btn {
    padding: 7px 14px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .btn.tiny {
    padding: 4px 10px;
    font-size: 12px;
  }
  .field-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  .btn.danger {
    background: color-mix(in srgb, var(--warn) 16%, transparent);
    border-color: var(--warn);
    color: var(--warn);
    font-weight: 600;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .paths {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .path-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 11.5px;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t2);
    font-family: ui-monospace, monospace;
  }
  .path-size {
    flex: none;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .qhint {
    font-size: 12px;
    color: var(--t2);
    margin-top: 10px;
    line-height: 1.4;
  }

  /* One shortcut: what it does on the left, the keys on the right. The keys are
     the button - there is no second "change" control to hunt for, and the row
     says what it is going to do when you press it. */
  .sc-intro {
    margin-top: 0;
    margin-bottom: 12px;
  }
  /* The registry's own group headings sit between rows rather than above a
     card, so they need the air the card gave the ones further down. */
  .settings-section .group-label {
    margin-top: 16px;
  }
  .sc-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    border-bottom: 1px solid var(--line);
  }
  .sc-label {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sc-combo {
    flex: none;
    min-width: 92px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    cursor: pointer;
  }
  .sc-combo:hover {
    background: var(--accent-soft);
  }
  /* A rebound key is worth spotting at a glance when you are wondering why a
     press does something unexpected. */
  .sc-combo.custom {
    border-color: var(--line2);
    font-weight: 600;
  }
  .sc-combo.listening {
    border-color: var(--warn);
    color: var(--warn);
    font-family: inherit;
  }
  .sc-reset {
    flex: none;
  }
  .sc-reset:disabled {
    /* Present but silent on a default binding - the row keeps its shape, so
       nothing shifts sideways when a shortcut is changed. */
    opacity: 0.28;
  }
  .sc-err {
    font-size: 12px;
    color: var(--warn);
    padding: 4px 0 6px;
    line-height: 1.4;
  }

  /* Typesetting. The rows here are sentences, not the two-word labels the fixed
     110px column further up was cut for, so the label takes the room and the
     control sits at the right edge - which also lines every switch in the
     section up with every other one. */
  .ts-section .field > span,
  .ts-section .field > label {
    width: auto;
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--t2);
  }
  /* The four beta defaults mean nothing while the engine above them is off, so
     they dim with it rather than vanishing: a control that disappears is one
     nobody finds again when they turn the beta on. */
  .ts-defaults.dim {
    opacity: 0.5;
  }
  .ts-section :global(.switch.disabled) {
    cursor: default;
  }
  .ts-num {
    flex: none;
    width: 62px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .ts-num:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
