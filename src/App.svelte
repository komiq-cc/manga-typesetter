<script module>
  // Holds page-switch unsubscribe across component remounts.
  let releasePageSwitch = null;
</script>

<script>
  import EditorRoot from './lib/editor/EditorRoot.svelte';
  import FontModal from './lib/FontModal.svelte';
  import BrushModal from './lib/BrushModal.svelte';
  import SettingsModal from './lib/SettingsModal.svelte';
  import ExportDialog from './lib/ExportDialog.svelte';
  import Toast from './lib/Toast.svelte';
  import HomeFrame from './lib/home/HomeFrame.svelte';
  import LibraryView from './lib/home/LibraryView.svelte';
  import ProjectView from './lib/home/ProjectView.svelte';
  import NewChapterDialog from './lib/home/NewChapterDialog.svelte';
  import ChapterSourcesSheet from './lib/home/ChapterSourcesSheet.svelte';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { app, byId, page, selectBox, settleEdits, deleteBox, duplicateBox, nudgeBox, deselect, nextPage, prevPage, setTool, resetBoxRotation, toggleBalloonFit, refitBalloon, placeDetectedOnPage, closeBulk, toast, setPageSwitchHook, flushSidebar, noteFontsChanged, isLongstrip, isTranslateMode } from './lib/store.svelte.js';
  import { copyStyle, pasteStyle } from './lib/presets.svelte.js';
  import { dispatchShortcut, registerShortcutHandlers } from './lib/shortcuts.svelte.js';
  import { setInspectorTab, cycleInspectorTab } from './lib/inspector-tabs.svelte.js';
  import { brushTool, closeBrushManager } from './lib/brush-tool.svelte.js';
  import { initHistory, undo, redo } from './lib/editor/history.svelte.js';
  import { flushPanels } from './lib/editor/panels.svelte.js';
  import { switchHistoryPage } from './lib/editor/history-file.svelte.js';
  import { restoreFonts, scanSystemFonts } from './lib/fonts.js';
  import { isTauri } from './lib/importer.js';
  import { checkSidecar } from './lib/sidecar.js';
  import { initTheme } from './lib/theme.svelte.js';
  // Side-effect import: reading the stored preferences also applies them, and
  // the typesetting switch has to be applied before the first line is measured.
  import './lib/prefs.svelte.js';
  import { library, initRoot, openChapter, flushBeforeLeaving } from './lib/library.svelte.js';
  import { route, goBack } from './lib/route.svelte.js';
  import { watchFontLoads, installContextMenuGuard, isReloadKey, isEditableTarget } from './lib/shell-guards.js';

  let fontModalOpen = $state(false);
  let settingsOpen = $state(false);
  let newChapterOpen = $state(false);
  let newChapterBusy = $state(false);
  let newChapterProject = $state(null);
  let sourcesOpen = $state(false);
  let sourcesBusy = $state(false);
  let sourcesRef = $state({ projectId: null, chapterId: null });
  // Library root resolves asynchronously before child views mount.
  let booted = $state(false);
  // Releases the beforeunload/pagehide fallback - see `armUnloadFlush`.
  let releaseUnloadFlush = null;
  let releaseFontWatch = null;
  let releaseContextMenu = null;

  onMount(async () => {
    initTheme();
    if (typeof document !== 'undefined') {
      releaseContextMenu = installContextMenuGuard(document);
      releaseFontWatch = watchFontLoads(document.fonts, () => noteFontsChanged(), 150);
    }
    // Register history and page-switch hooks.
    initHistory();
    releasePageSwitch?.();
    releasePageSwitch = setPageSwitchHook(switchHistoryPage);
    try {
      await initRoot();
    } catch (e) {
      // Display root resolution failure on the library screen.
      library.error = `Could not work out where your library lives: ${e?.message ?? e}`;
    } finally {
      // Mark booted regardless of success.
      booted = true;
    }
    restoreFonts();
    // What this machine has installed, so a system font the user shows is in
    // the menus from the start. Not awaited: nothing on screen needs it yet.
    scanSystemFonts();
    // Recompute measurements when web fonts finish loading.
    document.fonts?.ready.then(() => noteFontsChanged());
    armQuitFlush();
    // Probe detection engine (Tauri only).
    checkSidecar().then((h) => {
      if (h) toast(`Detection ready · ${h.device}`);
    });
  });

  // The last thing that can be done synchronously on the way out of the process.
  //
  // Registered on EVERY platform and in the browser dev server too, which is the
  // whole point: the routes below it (the close button, the macOS Quit item) are
  // Tauri's and cover the ways a user asks this window to close, and nothing
  // covered the ways the page goes away underneath them - a reload, a devtools
  // restart, the updater's `relaunch()`, an OS-initiated logout that tears the
  // webview down without a close request. Each of those cost up to DOC_SAVE_MS
  // of edits.
  //
  // Synchronous by necessity: `beforeunload` cannot await, so the two debounced
  // preference tiers (which write synchronously to localStorage) are the part
  // that is guaranteed, and the chapter's own save is kicked off with whatever
  // time the platform then gives it. `settleEdits` first, for the same reason
  // `flushBeforeLeaving` does it first - an edit inside its settle window has
  // been applied to the document and is not yet in anything that gets written.
  function armUnloadFlush() {
    if (typeof window === 'undefined') return () => {};
    const onUnload = () => {
      try {
        settleEdits();
        flushSidebar();
        flushPanels();
        // Not awaited - there is nothing here that can await. A chapter with
        // nothing pending resolves immediately and this costs nothing.
        if (app.chapterRef) flushBeforeLeaving('quit');
      } catch (e) {
        console.error('Could not flush on unload', e);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    // `pagehide` as well, because a webview backgrounded and then killed by the
    // OS never fires `beforeunload` at all.
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }

  // Quitting with the editor open flushes pending debounced writes.
  async function armQuitFlush() {
    // First and unconditionally, so the fallback is in place before anything
    // below can fail - and so it exists at all under `vite dev`, where there is
    // no Tauri window to hang a close handler on.
    releaseUnloadFlush?.();
    releaseUnloadFlush = armUnloadFlush();
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      // Track single in-flight quit flush.
      let inFlight = null;
      const safeToQuit = () => {
        // Flush preference tiers and open chapter before quitting.
        flushSidebar();
        flushPanels();
        if (!app.chapterRef) return Promise.resolve(true);
        if (!inFlight) inFlight = flushBeforeLeaving('quit').finally(() => (inFlight = null));
        return inFlight;
      };

      // Route 1: window close button. The only route that exists on every
      // platform - Alt+F4, the titlebar X, the dock's Quit.
      await w.onCloseRequested(async (e) => {
        if (!app.chapterRef) {
          // Flush preferences when closing without an open chapter.
          flushSidebar();
          flushPanels();
          return;
        }
        e.preventDefault();
        if (await safeToQuit()) await w.destroy();
      });

      // Route 2: Cmd+Q and the Quit menu item. macOS only because the MENU is
      // macOS only - see `patchDefaultMenu`.
      await patchDefaultMenu(safeToQuit, w);
    } catch (e) {
      // Not swallowed any more. This used to be a bare `catch {}`, so a build
      // where the window API moved, or a platform that refused the menu, quietly
      // lost every route above and took the last 800ms of edits with it on every
      // quit - with nothing anywhere to say so. The unload fallback registered at
      // the top is still standing, which is what makes this a degradation and not
      // a silent data loss.
      console.error('Could not arm the quit flush', e);
      toast(`Quitting may not save the last edits: ${e?.message ?? e}`);
    }
  }

  // Strip predefined Undo/Redo from the macOS application menu so DOM keydowns
  // work, and put our own Quit in front of the predefined one.
  async function patchDefaultMenu(safeToQuit, w) {
    // macOS only, and deliberately: Tauri installs a default application menu on
    // macOS alone. On Windows and Linux there is no menu to patch - building one
    // here and calling `setAsAppMenu` would ADD a menu bar the app has never had.
    // The close-button route above is what covers those platforms for the window,
    // and `armUnloadFlush` is what covers the ways the page goes away without one.
    if (!/Mac/i.test(navigator.userAgent)) return;
    const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
    const menu = await Menu.default();
    let changed = false;
    let quitDone = false;
    for (const sub of await menu.items()) {
      if (sub.kind !== 'Submenu') continue;
      const items = await sub.items();
      // Descending so removals do not shift unvisited indices.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind !== 'Predefined') continue;

        const text = (await items[i].text()) ?? '';
        if (/^&?(un|re)do\b/i.test(text)) {
          await sub.removeAt(i);
          changed = true;
          continue;
        }
        // Replace only the first Quit item.
        if (quitDone || !/^&?quit\b/i.test(text)) continue;
        const replacement = await MenuItem.new({
          id: 'mt-quit',
          text,
          accelerator: 'CmdOrCtrl+Q',
          action: async () => {
            if (await safeToQuit()) await w.destroy();
          },
        });
        await sub.removeAt(i);
        await sub.insert(replacement, i);
        quitDone = true;
        changed = true;
      }
    }
    if (changed) await menu.setAsAppMenu();
  }

  // Hydrate editor when routing to a chapter.
  $effect(() => {
    if (route.name !== 'editor') return;
    const { projectId, chapterId } = route;
    if (untrack(() => app.chapterRef?.projectId === projectId && app.chapterRef?.chapterId === chapterId)) return;
    openChapter(projectId, chapterId).catch((e) => {
      toast(`Could not open that chapter: ${e?.message ?? e}`);
      goBack();
    });
  });

  function openNewChapter(projectId = null) {
    newChapterProject = projectId;
    newChapterOpen = true;
  }

  function openSources(projectId, chapterId) {
    sourcesRef = { projectId, chapterId };
    sourcesOpen = true;
  }

  // Arrow keys, as the step they move a box by. Shift multiplies it.
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const NUDGE_FAST = 10;

  // Every named shortcut in the app dispatches through here - the registry in
  // shortcuts.svelte.js owns which keys reach which of these, and the settings
  // screen rebinds them. A handler returning exactly `false` declines the press
  // (nothing selected, wrong chapter mode) and lets the key fall through to the
  // browser; anything else counts as handled and the default is prevented.
  const releaseShortcuts = registerShortcutHandlers({
    // Modes. `setTool` refuses anything but the hand in a translate chapter, so
    // there is nothing to guard here - but the press is still swallowed, because
    // Cmd+1 falling through to the webview is not a better outcome than nothing.
    'tool.place': () => setTool('place'),
    'tool.text': () => setTool('text'),
    'tool.brush': () => setTool('brush'),
    'tool.pan': () => setTool('pan'),

    'box.duplicate': () => {
      // Swallowed either way, so the browser's bookmark dialog never opens over
      // a translate chapter that has nothing to duplicate.
      if (!isTranslateMode()) duplicateBox();
    },
    // A switch, not a one-shot: pressing it again on the same box turns balloon
    // fit back off. The re-measure is `box.retypeset` below, the Inspector's
    // button - see `toggleBalloonFit` for why the two are different actions.
    'box.fitBalloon': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      toggleBalloonFit(app.selectedId);
    },
    // The Inspector's Refit button, from the keyboard: one undo step, and a
    // second press changes nothing.
    'box.retypeset': () => {
      if (isTranslateMode() || !app.selectedId) return false;
      refitBalloon(app.selectedId);
    },
    'box.delete': deleteSelected,
    'box.deleteAlt': deleteSelected,
    'box.resetRotation': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      if (!resetBoxRotation(app.selectedId)) toast('That box is already straight');
    },
    'style.copy': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      const b = byId(app.selectedId);
      if (b) copyStyle(b);
    },
    'style.paste': () => {
      if (!app.selectedId || isTranslateMode()) return false;
      const b = byId(app.selectedId);
      // A debounced Inspector edit still pending on this box would settle
      // AFTER the paste and record on top of it; settle first, so undo takes
      // the paste back in one press. Same reason `duplicateBox` settles.
      settleEdits();
      if (b) pasteStyle(b);
    },

    'queue.placeDetected': () => {
      if (isTranslateMode()) return false;
      placeDetectedOnPage();
    },

    'edit.undo': () => {
      if (noCanvasHistory()) return;
      undo();
    },
    'edit.redo': redoShortcut,
    'edit.redoAlt': redoShortcut,

    'inspector.tabNext': () => cycleInspectorTab(1),
    'inspector.tabPrev': () => cycleInspectorTab(-1),
    'inspector.tabText': () => setInspectorTab('text'),
    'inspector.tabFill': () => setInspectorTab('fill'),
    'inspector.tabEffects': () => setInspectorTab('effects'),
    'inspector.tabLayout': () => setInspectorTab('layout'),
  });
  onDestroy(() => {
    releaseShortcuts();
    releaseUnloadFlush?.();
    releaseUnloadFlush = null;
    releaseFontWatch?.();
    releaseFontWatch = null;
    releaseContextMenu?.();
    releaseContextMenu = null;
  });

  function deleteSelected() {
    if (!app.selectedId || isTranslateMode()) return false;
    deleteBox(app.selectedId);
  }
  function redoShortcut() {
    if (noCanvasHistory()) return;
    redo();
  }
  // Translate chapters edit the queue, not the canvas, and the undo stack they
  // would walk is empty. Say so rather than doing nothing.
  function noCanvasHistory() {
    if (!isTranslateMode()) return false;
    toast('Nothing to undo here: a translate chapter edits the queue, not the canvas');
    return true;
  }

  // Is the caret somewhere that owns the keyboard? Text fields and the canvas's
  // own in-place editor both count, and `app.editingId` is the second because
  // the box being typed into is a contenteditable that may have lost focus to a
  // panel button without the edit ending. Context menu guards do not exempt
  // <select>, but typing targets still include it.
  function isTypingTarget(t) {
    if (!(t instanceof Element)) return false;
    return isEditableTarget(t) || t.matches('select');
  }

  function onKeydown(e) {
    // Reload is never wanted in a desktop app: Mod+R, Mod+Shift+R and F5
    // tear down the webview and lose unsaved edits. The page's default is
    // blocked everywhere, even while typing, but the key carries on below so a
    // shortcut the user has bound to one of these combos still fires.
    if (isReloadKey(e)) e.preventDefault();
    // An IME mid-composition owns the keyboard: isComposing is the standard
    // flag, keyCode 229 is how some engines mark the synthetic keys. Acting
    // on either would steal keystrokes from the composition window.
    if (e.isComposing || e.keyCode === 229) return;
    // Not an early return any more. It used to be one - three lines at the top
    // of this handler that gave up the moment the caret was in a text field -
    // and since a letterer's caret lives in the Inspector's text field or a
    // queue row nearly all the time, that is what made the old bare v/t/h mode
    // keys look dead. What survives is: the shortcuts that cannot be part of
    // typing (the Cmd/Ctrl combos for modes, tabs and rotation) still fire, and
    // everything else stands down. The registry decides which is which.
    const typing = isTypingTarget(e.target) || !!app.editingId;
    if (!typing && e.key === 'Escape') {
      if (newChapterOpen) {
        // In-flight chapter copy is not dismissible.
        if (!newChapterBusy) newChapterOpen = false;
        return;
      }
      if (sourcesOpen) {
        // In-flight copy is not dismissible.
        if (!sourcesBusy) sourcesOpen = false;
        return;
      }
      if (app.exportOpen) return (app.exportOpen = false);
      if (app.bulk.active) return closeBulk();
      if (settingsOpen) return (settingsOpen = false);
      if (fontModalOpen) return (fontModalOpen = false);
      if (brushTool.manager) return closeBrushManager();
      return deselect();
    }
    // Suppress global editor shortcuts while a modal overlay is open. Markup
    // contract, relied on by this query: every app modal renders a root
    // `.modal-overlay` element and carries the `open` class only while it is
    // showing (SettingsModal, FontModal, ExportDialog do; so must any modal
    // added later, or this line has to be taught about it).
    if (typeof document !== 'undefined' && document.querySelector('.modal-overlay.open')) return;
    if (route.name !== 'editor') return;
    // Every named shortcut, in one line: undo, redo, duplicate, delete, the
    // style clipboard, the three modes, the Inspector's tabs and the rotation
    // reset. What each of them is bound to is the registry's business, and the
    // user's - nothing below this line knows a combo.
    if (dispatchShortcut(e, { typing })) return;
    // Past here is the contextual half of the keyboard: keys whose meaning
    // depends on what has focus and what is selected, which is exactly what a
    // rebindable shortcut cannot be. None of it runs while typing.
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    // Tab / Shift+Tab: cycle box selection in document order, but only when
    // focus is not on a focusable UI control (e.g. sidebar inputs or inspector buttons).
    if (!mod && e.key === 'Tab' && app.selectedId) {
      const ae = typeof document !== 'undefined' ? document.activeElement : null;
      const isCanvasFocus =
        !ae || ae === document.body || !!ae.closest?.('.editor-scroll') || !!ae.closest?.('.page-frame');
      if (isCanvasFocus) {
        const boxes = page().boxes;
        if (boxes?.length) {
          const idx = boxes.findIndex((b) => b.id === app.selectedId);
          if (idx !== -1) {
            e.preventDefault();
            settleEdits();
            const nextIdx = e.shiftKey
              ? (idx - 1 + boxes.length) % boxes.length
              : (idx + 1) % boxes.length;
            selectBox(boxes[nextIdx].id);
            return;
          }
        }
      }
    }
    // The tool keys used to be here, as bare v / t / h. They are Cmd/Ctrl+1/2/3
    // in the registry now: a bare letter is typing before it is a shortcut, so
    // it could only ever fire with focus nowhere at all, and it collided with
    // the letter itself the moment focus moved into a field.
    // The arrows nudge the selected box and turn the page when nothing is
    // selected - one key, and which it means is what the user is looking at.
    const step = !mod ? NUDGE[e.key] : null;
    if (step && app.selectedId && !isTranslateMode()) {
      e.preventDefault();
      const k = e.shiftKey ? NUDGE_FAST : 1;
      nudgeBox(app.selectedId, step[0] * k, step[1] * k);
      return;
    }
    // Longstrip navigation is handled by scroll container; paged chapters
    // consume the arrow for the turn, so the default (scrolling the page
    // under a caret-less keypress) is prevented with it.
    if (!isLongstrip()) {
      if (e.key === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        nextPage();
      }
      if (e.key === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        prevPage();
      }
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if route.name === 'editor'}
  <EditorRoot onFontLib={() => (fontModalOpen = true)} onSettings={() => (settingsOpen = true)} />
{:else if booted}
  <HomeFrame onSettings={() => (settingsOpen = true)}>
    {#if route.name === 'project'}
      <ProjectView
        onNewChapter={(id) => openNewChapter(id)}
        onSources={openSources}
      />
    {:else}
      <LibraryView
        onNewChapter={() => openNewChapter(null)}
      />
    {/if}
  </HomeFrame>
{:else}
  <div class="boot"></div>
{/if}

<NewChapterDialog
  bind:open={newChapterOpen}
  bind:busy={newChapterBusy}
  projectId={newChapterProject}
/>
<ChapterSourcesSheet
  bind:open={sourcesOpen}
  bind:busy={sourcesBusy}
  projectId={sourcesRef.projectId}
  chapterId={sourcesRef.chapterId}
/>
<FontModal bind:open={fontModalOpen} />
<BrushModal />
<SettingsModal bind:open={settingsOpen} />
<ExportDialog />
<Toast />
