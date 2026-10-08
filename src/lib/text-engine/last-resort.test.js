import { describe, it, expect } from 'vitest';
import { LAST_RESORT, lastResortFamily, osOf } from './last-resort.js';

describe('which OS the webview is on', () => {
  it('reads it off the user agent of each platform webview', () => {
    expect(osOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('macos');
    expect(osOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('windows');
    expect(osOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('linux');
  });
  it('answers null for anything else, a missing agent included', () => {
    expect(osOf('')).toBe(null);
    expect(osOf(undefined)).toBe(null);
    expect(osOf('node')).toBe(null);
  });
});

describe('the last-resort family', () => {
  const pick = (os, system, user = []) => lastResortFamily({ os, system, user });

  it('is the first family of the OS list that is installed, in list order', () => {
    expect(pick('macos', ['Arial', 'Helvetica', 'Helvetica Neue', 'Zapfino'])).toEqual({ name: 'Helvetica Neue', source: 'system' });
    expect(pick('macos', ['Arial', 'Helvetica', 'Zapfino'])).toEqual({ name: 'Helvetica', source: 'system' });
    expect(pick('macos', ['Arial', 'Zapfino'])).toEqual({ name: 'Arial', source: 'system' });
    expect(pick('windows', ['Arial', 'Calibri', 'Segoe UI'])).toEqual({ name: 'Segoe UI', source: 'system' });
    expect(pick('windows', ['Arial', 'Calibri'])).toEqual({ name: 'Arial', source: 'system' });
    expect(pick('linux', ['Noto Sans', 'Liberation Sans', 'DejaVu Sans'])).toEqual({ name: 'DejaVu Sans', source: 'system' });
    expect(pick('linux', ['Noto Sans', 'Liberation Sans'])).toEqual({ name: 'Liberation Sans', source: 'system' });
    expect(pick('linux', ['Noto Sans', 'Ubuntu'])).toEqual({ name: 'Noto Sans', source: 'system' });
  });

  it('does not take another OS’s face while its own list has one', () => {
    // Arial is on the macOS list and on the Windows one; Segoe UI only on Windows.
    expect(pick('macos', ['Segoe UI', 'Arial']).name).toBe('Arial');
    expect(pick('linux', ['Helvetica Neue', 'Segoe UI', 'Noto Sans']).name).toBe('Noto Sans');
  });

  it('prefers a listed system face to the user’s own fonts', () => {
    expect(pick('macos', ['Helvetica'], ['Anime Ace'])).toEqual({ name: 'Helvetica', source: 'system' });
  });

  it('falls to the user family that sorts first when no listed face is installed', () => {
    expect(pick('macos', [], ['Wild Words', 'Anime Ace', 'CC Astro City'])).toEqual({ name: 'Anime Ace', source: 'user' });
    expect(pick('linux', ['Ubuntu', 'Cantarell'], ['Wild Words'])).toEqual({ name: 'Wild Words', source: 'user' });
    // Whatever order they were loaded in: the same machine picks the same face every launch.
    expect(pick(null, [], ['b', 'a', 'C']).name).toBe('C');
  });

  it('then to the system family that sorts first, and to nothing when the machine has no font at all', () => {
    expect(pick('linux', ['Ubuntu', 'Cantarell'])).toEqual({ name: 'Cantarell', source: 'system' });
    expect(pick('macos', [])).toBe(null);
    expect(pick(null, [], [])).toBe(null);
  });

  it('tries every list in turn on an OS it cannot name', () => {
    expect(pick(null, ['DejaVu Sans', 'Segoe UI']).name).toBe('Segoe UI');
    expect(pick('plan9', ['DejaVu Sans']).name).toBe('DejaVu Sans');
  });

  it('keeps the lists short and fixed', () => {
    expect(LAST_RESORT).toEqual({
      macos: ['Helvetica Neue', 'Helvetica', 'Arial'],
      windows: ['Segoe UI', 'Arial'],
      linux: ['DejaVu Sans', 'Liberation Sans', 'Noto Sans'],
    });
  });
});
