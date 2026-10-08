import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderHtml } from './html.js';

function makeReport() {
  return { pass: true, metadataSource: 'test', hashDifferences: [], before: { manifest: { engine: '</script><script>globalThis.injected=true</script>' } }, after: { manifest: {} },
    gates: [], summary: {}, assets: { limit: 150 }, statistics: { metrics: [], layout: [], pixels: {} },
    cases: Array.from({ length: 2000 }, (_, i) => ({ id: `p.fake.${i}`, group: 'pixels', status: 'compared', font: i % 2 ? 'Font B' : 'Font A',
      tags: i % 2 ? ['curve'] : ['kern'], gates: i % 3 ? [] : ['pixels.thick'], numbers: [],
      image: { width: 1, height: 1, iou: 1, thick: 0 },
      images: { before: `img/${i}-original-before.png`, after: `img/${i}-original-after.png`, beforeAligned: `img/${i}-before.png`, afterAligned: `img/${i}-after.png`, heat: `img/${i}-heat.png` } })) };
}

describe('report in a DOM with 2,000 cases', () => {
  it('renders only 100 rows initially, supports show-more and combines font/tag/gate/search filters', () => {
    const dom = new JSDOM(renderHtml(makeReport()), { runScripts: 'dangerously' });
    try {
      const document = dom.window.document;
      expect(document.querySelectorAll('article.case')).toHaveLength(100);
      document.getElementById('more').click();
      expect(document.querySelectorAll('article.case')).toHaveLength(200);
      const set = (id, value) => {
        const element = document.getElementById(id);
        element.value = value;
        element.dispatchEvent(new dom.window.Event(id === 'search' ? 'input' : 'change'));
      };
      set('font', 'Font A');
      set('tag', 'kern');
      set('gate', 'pixels.thick');
      expect(document.getElementById('count').textContent).toBe('100 of 334 cases');
      set('search', 'p.fake.1998');
      expect(document.querySelectorAll('article.case')).toHaveLength(1);
      expect(document.getElementById('more').hidden).toBe(true);
      expect(dom.window.injected).toBeUndefined();
    } finally { dom.window.close(); }
  });
  it('swaps the aligned image on flicker and restores before when stopped', () => {
    const dom = new JSDOM(renderHtml(makeReport()), { runScripts: 'dangerously' });
    try {
      let callback;
      dom.window.setInterval = fn => { callback = fn; return 1; };
      dom.window.clearInterval = () => {};
      const button = dom.window.document.querySelector('[data-flicker]');
      const img = button.closest('article').querySelector('img');
      button.click();
      expect(button.textContent).toBe('Stop flicker');
      callback();
      expect(img.getAttribute('src')).toBe('img/0-after.png');
      callback();
      expect(img.getAttribute('src')).toBe('img/0-before.png');
      button.click();
      expect(button.textContent).toBe('Start flicker');
      expect(img.getAttribute('src')).toBe('img/0-before.png');
    } finally { dom.window.close(); }
  });
});
