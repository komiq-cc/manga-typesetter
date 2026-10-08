import { json } from './stats.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmt = value => typeof value === 'number' ? (Number.isFinite(value) ? Number(value.toPrecision(6)) : String(value)) : value ?? '—';

export function renderHtml(report) {
  const table = (headers, rows) => {
    const heading = headers.map(header => `<th>${escape(header)}</th>`).join('');
    const body = rows.map(row => {
      const cells = row.map(cell => `<td>${escape(cell)}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<div class="scroll"><table><thead><tr>${heading}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  const manifest = side => `<section><h2>${side === 'before' ? 'Before' : 'After'}</h2><pre>${escape(json(report[side].manifest, 2))}</pre></section>`;
  const groupTables = (tables, key) => ['metrics', 'layout', 'pixels'].map(group => {
    const gates = report.gates.filter(gate => !gate.group || gate.group === group);
    const headers = [key, 'Cases', ...gates.map(gate => `${gate.id}: eligible / failures; p50 / p99 / max`)];
    const rows = (tables?.[group] ?? []).map(row => [row[key], row.cases, ...gates.map(gate => {
      const entry = row.gates[gate.id];
      if (!entry) return '0 / 0; —';
      return `${entry.count} / ${entry.failures}; ${fmt(entry.quantity.p50)} / ${fmt(entry.quantity.p99)} / ${fmt(entry.quantity.max)}`;
    })]);
    return `<h3>${group}</h3>${table(headers, rows)}`;
  }).join('');
  const numberTables = `<h2>By font</h2>${groupTables(report.byFont, 'font')}<h2>By tag</h2>${groupTables(report.byTag, 'tag')}`;
  const limit = report.sampleLimit ?? (report.assets?.limit === 'all' ? 150 : (report.assets?.limit ?? 150));
  const selected = new Set(report.cases.filter(item => item.images));
  for (const group of ['metrics', 'layout']) {
    for (const item of report.cases.filter(item => item.group === group).slice(0, limit)) selected.add(item);
  }
  const data = [...selected].map(item => ({
    id: item.id,
    group: item.group,
    font: item.font,
    tags: item.tags,
    mode: item.mode,
    status: item.status,
    gates: item.gates,
    before: item.status === 'compared' ? undefined : item.before,
    after: item.status === 'compared' ? undefined : item.after,
    image: item.image,
    images: item.images,
    linesA: item.before?.solve?.lines ?? item.before?.lines,
    linesB: item.after?.solve?.lines ?? item.after?.lines,
    layout: item.layout ? { ...item.layout, numbers: undefined } : undefined,
    differences: item.numbers.filter(diff => diff.abs !== 0 || diff.structural).map(diff => ({
      path: diff.path, before: diff.before, after: diff.after, abs: diff.abs, rel: diff.rel
    }))
  }));
  const embedded = json(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const gateRows = report.gates.map(gate => {
    const result = `${gate.empty ? 'EMPTY' : gate.pass ? 'PASS' : 'FAIL'}${gate.enforce ? '' : ' (report only)'}`;
    const thresholds = [
      gate.abs !== undefined ? `abs ≤ ${gate.abs}` : '',
      gate.rel !== undefined ? `OR rel ≤ ${gate.rel}` : '',
      gate.max !== undefined ? `max ≤ ${gate.max}` : '',
      gate.min !== undefined ? `min ≥ ${gate.min}` : '',
      `fraction ≥ ${gate.atLeast ?? 1}`
    ].filter(Boolean).join(' ');
    const envelope = gate.envelope.length ? gate.envelope.map(item =>
      `${item.field}: candidate max ${fmt(item.candidate.max)} / ref max ${fmt(item.reference.max)} (×${fmt(item.ratioToMax)})`).join('; ')
      : report.referenceEnvelope ? 'No comparable reference metric' : '—';
    return [
      gate.id, result, `${gate.count - gate.failures}/${gate.count}`, fmt(gate.fraction),
      thresholds, `max ${fmt(gate.statistics.max)}; p99 ${fmt(gate.statistics.p99)}`,
      envelope, gate.unknownSizeCount ? `${gate.unknownSizeCount} unknown sizes; threshold applied` : '', gate.why
    ];
  });
  const caseTable = table([
    'Group', 'Total', 'Compared', 'Missing', 'Errors', 'Both skipped',
    'Skip mismatch', 'Before skips', 'After skips'
  ], Object.entries(report.summary).map(([group, counts]) => [
    group, counts.total, counts.compared, counts.missing, counts.error,
    counts.skipped, counts['skip-mismatch'], counts.skippedBefore, counts.skippedAfter
  ]));
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Text port comparison</title>
<style>
:root {
  color-scheme:light dark;
  font:15px/1.5 system-ui,sans-serif
}
body {
  margin:24px;
  max-width:1600px
}
h1,h2,h3 {
  line-height:1.2
}
pre {
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  font:13px/1.5 monospace
}
table {
  border-collapse:collapse;
  width:100%;
  font-variant-numeric:tabular-nums
}
td,th {
  padding:6px 10px;
  text-align:left;
  border:1px solid #8886;
  vertical-align:top
}
th {
  background:#8882
}
.scroll {
  overflow:auto
}
.manifests,.lines,.pictures {
  display:flex;
  gap:20px;
  flex-wrap:wrap
}
.manifests section,.lines section {
  flex:1;
  min-width:280px
}
.warning {
  border:3px solid #d33;
  padding:16px;
  font-weight:700
}
.case {
  border-top:1px solid #888;
  margin-top:22px;
  padding-top:12px
}
.changed {
  background:#d334
}
.filters {
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  position:sticky;
  top:0;
  background:Canvas;
  padding:12px 0;
  border-bottom:1px solid #888;
  z-index:1
}
label {
  display:flex;
  gap:6px;
  align-items:center
}
button,select,input {
  font:inherit;
  padding:4px
}
figure {
  margin:0;
  max-width:100%;
  overflow:auto
}
.checker {
  background-color:#eee;
  background-image:linear-gradient(45deg,#bbb 25%,transparent 25%),linear-gradient(-45deg,#bbb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#bbb 75%),linear-gradient(-45deg,transparent 75%,#bbb 75%);
  background-size:16px 16px;
  background-position:0 0,0 8px,8px -8px,-8px 0
}
.checker img {
  display:block;
  image-rendering:pixelated;
  max-width:none
}
.fail {
  color:#d33
}
.pass {
  color:#19813c
}
ol {
  padding-left:28px
}
.muted {
  opacity:.75
}

</style>
<body><h1>Text port comparison: <span class="${report.pass ? 'pass' : 'fail'}">${report.pass ? 'PASS' : 'FAIL'}</span></h1>
${report.hashDifferences.length ? `<p class="warning">MEANINGLESS COMPARISON: corpus or font hashes differ (${escape(report.hashDifferences.join(', '))}). Results cannot verify the port.</p>` : ''}
<p>Metadata: ${escape(report.metadataSource)}. <a href="report.json">Summary, gate exceptions and worst 200 observations per font/field</a>.</p>
<div class="manifests">${manifest('before')}${manifest('after')}</div>
<h2>Cases</h2>
${caseTable}
<h2>Gates</h2>
${table(['Gate', 'Result', 'Within threshold', 'Fraction', 'Threshold', 'Observed differences', 'Reference envelope', 'Metadata', 'Why'], gateRows)}
${numberTables}<h2>Pixels</h2>
${table(['Metric', 'Count', 'Max', 'Median', 'p99'], Object.entries(report.statistics.pixels).map(([name, s]) => [name, s.count, fmt(s.max), fmt(s.median), fmt(s.p99)]))}
<h2>Per-case details, worst first</h2>
<p>Heat map: magenta = threshold-mask XOR (opacity 128–255 by magnitude); yellow = alpha difference (opacity = magnitude). Images share aligned coordinates; exact original PNGs are linked. Asset limit: ${report.assets?.limit ?? 0} per group.
These rows are a sample (${data.length} of ${Object.values(report.summary).reduce((sum, group) => sum + group.total, 0)} total cases).
Full rows: <a href="cases/metrics.jsonl">cases/metrics.jsonl</a>, <a href="cases/layout.jsonl">cases/layout.jsonl</a>, <a href="cases/pixels.jsonl">cases/pixels.jsonl</a>.
Numeric gate quantities in grouping tables are each case's largest absolute difference; line/decision quantities are 0 or 1; image quantities are raw metrics.</p>
<div class="filters">
<label>Search <input id="search" type="search"></label>
<label>Font <select id="font"></select></label>
<label>Tag <select id="tag"></select></label>
<label>Gate <select id="gate"></select></label>
<label>Group <select id="group"></select></label>
<label>Zoom <select id="zoom"><option value="2">2×</option><option value="1">1×</option><option value="4">4×</option></select></label></div>
<p id="count" aria-live="polite"></p><div id="cases"></div><button id="more">Show 100 more</button>
<script type="application/json" id="data">${embedded}</script>
<script>
(${reportUi.toString()})();
</script></body></html>`;
}

function reportUi() {
  const data = JSON.parse(document.getElementById('data').textContent);
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const timers = new Map();
  let shown = 100;
  for (const key of ['font', 'tag', 'gate', 'group']) {
    const values = [...new Set(data.flatMap(item =>
      key === 'tag' ? item.tags : key === 'gate' ? item.gates : [item[key]]))].sort();
    byId(key).innerHTML = '<option value="">All</option>'
      + values.map(value => '<option>' + escape(value) + '</option>').join('');
    byId(key).onchange = () => {
      shown = 100;
      render();
    };
  }
  byId('search').oninput = () => {
    shown = 100;
    render();
  };
  byId('zoom').onchange = render;
  byId('more').onclick = () => {
    shown += 100;
    render();
  };

  function lines(a, b) {
    const count = Math.max(a?.length ?? 0, b?.length ?? 0);
    return '<div class="lines">' + [a, b].map((list, side) =>
      '<section><b>' + ['Before', 'After'][side] + '</b><ol>'
      + Array.from({ length: count }, (_, i) =>
        '<li class="' + (a?.[i] === b?.[i] ? '' : 'changed') + '">'
        + escape(list?.[i] ?? '[missing]') + '</li>').join('')
      + '</ol></section>').join('') + '</div>';
  }

  function picture(item, key, label) {
    const zoom = Number(byId('zoom').value);
    return '<figure><figcaption>' + label + '</figcaption><div class="checker">'
      + '<img loading="lazy" alt="' + label + ' ' + escape(item.id)
      + '" src="' + escape(item.images[key]) + '" style="width:'
      + item.image.width * zoom + 'px;height:' + item.image.height * zoom
      + 'px"></div></figure>';
  }

  function caseRow(item) {
    const description = [item.group, item.font, item.mode, item.status, ...item.tags].filter(Boolean).join(' · ');
    let content = '<article class="case"><h3>' + escape(item.id) + '</h3><p>'
      + escape(description) + '</p><p class="fail">' + escape(item.gates.join(', ')) + '</p>';
    if (item.image) content += '<pre>' + escape(JSON.stringify(item.image, null, 2)) + '</pre>';
    if (item.images) {
      content += '<div class="pictures">' + picture(item, 'beforeAligned', 'Before')
        + picture(item, 'afterAligned', 'After') + picture(item, 'heat', 'Heat map')
        + '</div><button data-flicker="' + escape(item.id) + '">Start flicker</button>'
        + ' <a href="' + escape(item.images.before) + '">Original before</a> · '
        + '<a href="' + escape(item.images.after) + '">Original after</a>';
    } else if (item.image) {
      content += '<p class="muted">Images omitted by asset limit; metrics are included.</p>';
    }
    if (item.layout) {
      content += lines(item.linesA, item.linesB)
        + '<details><summary>Layout changes</summary><pre>'
        + escape(JSON.stringify(item.layout, null, 2)) + '</pre></details>';
    }
    if (item.status !== 'compared') {
      content += '<pre>' + escape(JSON.stringify({ before: item.before, after: item.after }, null, 2)) + '</pre>';
    }
    if (item.differences.length) {
      content += '<details><summary>' + item.differences.length + ' numeric differences</summary><pre>'
        + escape(JSON.stringify(item.differences, null, 2)) + '</pre></details>';
    }
    return content + '</article>';
  }

  function render() {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    const query = byId('search').value.toLowerCase();
    const filtered = data.filter(item =>
      (!query || item.id.toLowerCase().includes(query))
      && (!byId('font').value || item.font === byId('font').value)
      && (!byId('tag').value || item.tags.includes(byId('tag').value))
      && (!byId('gate').value || item.gates.includes(byId('gate').value))
      && (!byId('group').value || item.group === byId('group').value));
    byId('count').textContent = Math.min(shown, filtered.length) + ' of ' + filtered.length + ' cases';
    byId('more').hidden = shown >= filtered.length;
    byId('cases').innerHTML = filtered.slice(0, shown).map(caseRow).join('');
  }

  byId('cases').onclick = event => {
    const button = event.target.closest('[data-flicker]');
    if (!button) return;
    const id = button.dataset.flicker;
    const item = data.find(item => item.id === id && item.images);
    const img = button.closest('article').querySelector('img');
    if (timers.has(id)) {
      clearInterval(timers.get(id));
      timers.delete(id);
      img.src = item.images.beforeAligned;
      button.textContent = 'Start flicker';
    } else {
      let after = false;
      timers.set(id, setInterval(() => {
        after = !after;
        img.src = after ? item.images.afterAligned : item.images.beforeAligned;
      }, 500));
      button.textContent = 'Stop flicker';
    }
  };
  render();
}
