// The last-resort family: what the Rust engine measures a box in when the
// document names a font this machine does not have. No font ships with the
// app, so it has to be one the machine brought, and it has to be the same one
// every time on the same machine or a chapter would lay out differently from
// one launch to the next.
//
// The rule, in order:
//   1. the first family of this OS's list below that the system scan found;
//   2. else the user's own family that sorts first by name - the only fonts
//      there are in a plain browser (the dev server), where nothing is scanned;
//   3. else the system family that sorts first by name - a machine with none
//      of the listed faces still has something to measure with;
//   4. else none: nothing can be measured, and the engine is not installed.
//
// The lists are plain sans faces each OS has carried for years, most
// preferred first. An OS the app cannot name tries all three lists in turn.
export const LAST_RESORT = Object.freeze({
  macos: Object.freeze(['Helvetica Neue', 'Helvetica', 'Arial']),
  windows: Object.freeze(['Segoe UI', 'Arial']),
  linux: Object.freeze(['DejaVu Sans', 'Liberation Sans', 'Noto Sans']),
});

// Which of the three lists applies, read off the webview's user agent: WKWebView
// says Macintosh, WebView2 says Windows NT, WebKitGTK says Linux. Null for
// anything else.
export function osOf(userAgent) {
  const ua = String(userAgent ?? '');
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ os: string | null, system: string[], user: string[] }} have family
 *   names: every scanned system family, and the user families the engine can read
 * @returns {{ name: string, source: 'system' | 'user' } | null}
 */
export function lastResortFamily({ os, system = [], user = [] }) {
  const installed = new Set(system);
  const lists = LAST_RESORT[os] ? [LAST_RESORT[os]] : Object.values(LAST_RESORT);
  for (const list of lists) {
    for (const name of list) if (installed.has(name)) return { name, source: 'system' };
  }
  if (user.length) return { name: [...user].sort(byName)[0], source: 'user' };
  if (system.length) return { name: [...system].sort(byName)[0], source: 'system' };
  return null;
}
