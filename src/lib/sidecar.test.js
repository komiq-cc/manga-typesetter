import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd, args) => {
    h.calls.push([cmd, args]);
    return { img_width: 100, img_height: 100, panels: [], lines: [] };
  }),
}));

beforeEach(() => {
  h.calls.length = 0;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  globalThis.fetch = vi.fn().mockResolvedValue({
    arrayBuffer: async () => new ArrayBuffer(4),
  });
});

describe('analyzeImage IPC invocation', () => {
  it('defaults language to ja when omitted', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][0]).toBe('detect_analyze');
    expect(h.calls[0][1].language).toBe('ja');
    expect(h.calls[0][1].ocr).toBe(true);
  });

  it('passes explicit lang option when provided', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', { ocr: false, lang: 'ko' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][0]).toBe('detect_analyze');
    expect(h.calls[0][1].language).toBe('ko');
    expect(h.calls[0][1].ocrModel).toBe('ko-ppocrv5-mobile');
    expect(h.calls[0][1].ocr).toBe(false);
  });

  it('supports lang passed as positional third arg', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', { ocr: true }, 'ko');
    expect(h.calls.at(-1)[1].language).toBe('ko');
  });

  it('supports lang passed as second arg string', async () => {
    const { analyzeImage } = await import('./sidecar.js');
    await analyzeImage('blob:fake', 'ko');
    expect(h.calls.at(-1)[1].language).toBe('ko');
  });
});
