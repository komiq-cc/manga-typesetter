// Desktop updater facade for Tauri 2.
//
// In browser dev/preview there is no Tauri runtime, so checking for updates
// silently returns null. Under Tauri, it checks the endpoint configured in
// tauri.conf.json, validates signatures against the public key, and returns an
// Update handle if a newer version is available.

import { isTauri } from './importer.js';
import { app, flushSidebar, chapterSaveCycle } from './store.svelte.js';
import { flushPanels } from './editor/panels.svelte.js';
import { flushBeforeLeaving, leaveApprovalCurrent } from './library.svelte.js';

/**
 * Check if a new version of the app is available.
 * Returns the Update object if an update is found, or null otherwise (including on network errors).
 *
 * @param {import('@tauri-apps/plugin-updater').CheckOptions} [options]
 * @returns {Promise<import('@tauri-apps/plugin-updater').Update | null>}
 */
export async function checkForUpdate(options) {
  if (!isTauri()) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check(options);
    return update ?? null;
  } catch (e) {
    console.warn('Update check failed:', e);
    return null;
  }
}

// Alias for convenience
export const check = checkForUpdate;

// Installing an update ends this process, and neither way it does so is a close
// request: on Windows `install()` starts the installer and exits from inside
// the call, and everywhere else `relaunch()` restarts the app. So none of the
// quit routes in App.svelte ran - only the unload fallback, which can START the
// chapter's save but cannot wait for it and cannot refuse - and a chapter whose
// last save had failed was thrown away by the update without a word.
//
// So the update asks the same question a quit asks, through the same door as
// App.svelte's `safeToQuit` / `destroyWhenSaved`: the preference tiers flushed,
// the open chapter's save awaited through `flushBeforeLeaving('quit')`, and its
// yes still current - same chapter, same document - when the process is about
// to go. A no (the save refused, or the disk still writing) stops the update;
// flushBeforeLeaving has already said why. The two-step escape is the quit's
// own: after a refusal, a second deliberate request lets the update through
// and the last edits go, exactly as a second Cmd+Q would.
async function savedForRestart() {
  flushSidebar();
  flushPanels();
  if (!app.chapterRef) return true;
  const ref = app.chapterRef;
  const turn = chapterSaveCycle();
  const approval = flushBeforeLeaving('quit');
  if (!(await approval)) return false;
  return app.chapterRef === ref && chapterSaveCycle() === turn && leaveApprovalCurrent(approval);
}

// Raised for a refusal, so it reaches the dialog in its own words rather than
// wrapped as an install failure.
class NotSaved extends Error {}

const NOT_SAVED =
  'Not installed: updating restarts the app, and the open chapter has not been saved. ' +
  'Your edits are still on screen. Try again in a moment; if saving keeps failing, ' +
  'a second try updates anyway and leaves those edits behind.';
const NOT_RESTARTED =
  'The update is installed, but the app was not restarted: the open chapter has not been ' +
  'saved. Quit once it has, and the next launch is the new version.';

// Updates whose package is downloaded and not yet installed, so a try that a
// refused save stopped does not fetch the whole package again on the next one.
const downloaded = new WeakSet();

/**
 * Download an available update, reporting download progress, then - once the
 * open chapter is safely saved - install it and relaunch the application.
 * Rejects without installing when the chapter's save refuses or is still
 * writing.
 *
 * @param {import('@tauri-apps/plugin-updater').Update} update
 * @param {(progress: { event: 'Started' | 'Progress' | 'Finished', percent: number | null, downloaded: number, total: number | null }) => void} [onProgress]
 * @returns {Promise<void>}
 */
export async function installUpdate(update, onProgress) {
  if (!update) {
    throw new Error('No update object provided to installUpdate');
  }
  try {
    let contentLength = 0;
    let downloadedBytes = 0;

    // Downloaded and installed as two steps rather than `downloadAndInstall`,
    // so the save is asked for after the long part and immediately before the
    // step that can end the process.
    if (!downloaded.has(update)) {
      await update.download((event) => {
        if (event.event === 'Started') {
          contentLength = event.data?.contentLength ?? 0;
          downloadedBytes = 0;
          const percent = contentLength > 0 ? 0 : null;
          onProgress?.({
            event: 'Started',
            percent,
            downloaded: 0,
            total: contentLength || null,
          });
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data?.chunkLength ?? 0;
          const percent =
            contentLength > 0
              ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
              : null;
          onProgress?.({
            event: 'Progress',
            percent,
            downloaded: downloadedBytes,
            total: contentLength || null,
          });
        } else if (event.event === 'Finished') {
          onProgress?.({
            event: 'Finished',
            percent: 100,
            downloaded: downloadedBytes,
            total: contentLength || null,
          });
        }
      });
      downloaded.add(update);
    } else {
      onProgress?.({ event: 'Finished', percent: 100, downloaded: 0, total: null });
    }

    if (!(await savedForRestart())) throw new NotSaved(NOT_SAVED);
    // Forgotten before the call, not after: the package is spent by an install
    // that fails as well as by one that lands, so the next try downloads again.
    downloaded.delete(update);
    await update.install();

    // Not reached on Windows. Elsewhere the install took a moment, and an edit
    // made in it is in nothing that has been written - so the same question
    // again, right before the restart.
    if (!(await savedForRestart())) throw new NotSaved(NOT_RESTARTED);
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    if (e instanceof NotSaved) throw e;
    throw new Error(`Failed to install update: ${e?.message ?? e}`);
  }
}
