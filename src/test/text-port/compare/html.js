import { json } from './stats.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmt = value => typeof value === 'number' ? (Number.isFinite(value) ? Number(value.toPrecision(6)) : String(value)) : value ?? '—';

export function renderHtml(report) {
  const table = (headers, rows) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const manifest = side => `<section><h2>${side === 'before' ? 'Before' : 'After'}</h2><pre>${escape(json(report[side].manifest, 2))}</pre></section>`;
  const numberTables = ['metrics', 'layout'].map(group => `<h2>${group} numbers</h2>${table(['Font', 'Field', 'Cases', 'Count', 'Abs max', 'Abs median', 'Abs p99', 'Rel max', 'Rel median', 'Rel p99', 'Invalid'], report.statistics[group].map(item => [item.font, item.field, item.caseCount, item.absolute.count, fmt(item.absolute.max), fmt(item.absolute.median), fmt(item.absolute.p99), fmt(item.relative.max), fmt(item.relative.median), fmt(item.relative.p99), item.invalid]))}`).join('');
  // Only compact per-case display data is embedded. Full observations and all
  // 200-worst lists live in report.json, without duplicating them in the DOM.
  const data = report.cases.map(item => ({ id: item.id, group: item.group, font: item.font, tags: item.tags, mode: item.mode, status: item.status, gates: item.gates,
    before: item.status === 'compared' ? undefined : item.before, after: item.status === 'compared' ? undefined : item.after,
    image: item.image, images: item.images,
    linesA: item.before?.solve?.lines ?? item.before?.lines, linesB: item.after?.solve?.lines ?? item.after?.lines,
    layout: item.layout ? { ...item.layout, numbers: undefined } : undefined,
    differences: item.numbers.filter(diff => diff.abs !== 0 || diff.structural).map(diff => ({ path: diff.path, before: diff.before, after: diff.after, abs: diff.abs, rel: diff.rel })) }));
  const embedded = json(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const gateRows = report.gates.map(gate => [gate.id, `${gate.empty ? 'EMPTY' : gate.pass ? 'PASS' : 'FAIL'}${gate.enforce ? '' : ' (report only)'}`, `${gate.count - gate.failures}/${gate.count}`, fmt(gate.fraction),
    [gate.abs !== undefined ? `abs ≤ ${gate.abs}` : '', gate.rel !== undefined ? `OR rel ≤ ${gate.rel}` : '', gate.max !== undefined ? `max ≤ ${gate.max}` : '', gate.min !== undefined ? `min ≥ ${gate.min}` : '', `fraction ≥ ${gate.atLeast ?? 1}`].filter(Boolean).join(' '),
    `max ${fmt(gate.statistics.max)}; p99 ${fmt(gate.statistics.p99)}`,
    gate.envelope.length ? gate.envelope.map(item => `${item.field}: candidate max ${fmt(item.candidate.max)} / ref max ${fmt(item.reference.max)} (×${fmt(item.ratioToMax)})`).join('; ') : report.referenceEnvelope ? 'No comparable reference metric' : '—',
    gate.unknownSize.length ? `${gate.unknownSize.length} unknown sizes; threshold applied` : '', gate.why]);
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Text port comparison</title>
<style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}body{margin:24px;max-width:1600px}h1,h2,h3{line-height:1.2}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:6px 10px;text-align:left;border:1px solid #8886;vertical-align:top}th{background:#8882}.scroll{overflow:auto}.manifests,.lines,.pictures{display:flex;gap:20px;flex-wrap:wrap}.manifests section,.lines section{flex:1;min-width:280px}.warning{border:3px solid #d33;padding:16px;font-weight:700}.case{border-top:1px solid #888;margin-top:22px;padding-top:12px}.changed{background:#d334}.filters{display:flex;gap:12px;flex-wrap:wrap;position:sticky;top:0;background:Canvas;padding:12px 0;border-bottom:1px solid #888;z-index:1}label{display:flex;gap:6px;align-items:center}button,select,input{font:inherit;padding:4px}figure{margin:0;max-width:100%;overflow:auto}.checker{background-color:#eee;background-image:linear-gradient(45deg,#bbb 25%,transparent 25%),linear-gradient(-45deg,#bbb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#bbb 75%),linear-gradient(-45deg,transparent 75%,#bbb 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}.checker img{display:block;image-rendering:pixelated;max-width:none}.fail{color:#d33}.pass{color:#19813c}ol{padding-left:28px}.muted{opacity:.75}
</style>
<body><h1>Text port comparison: <span class="${report.pass ? 'pass' : 'fail'}">${report.pass ? 'PASS' : 'FAIL'}</span></h1>
${report.hashDifferences.length ? `<p class="warning">MEANINGLESS COMPARISON: corpus or font hashes differ (${escape(report.hashDifferences.join(', '))}). Results cannot verify the port.</p>` : ''}
<p>Metadata: ${escape(report.metadataSource)}. <a href="report.json">Full machine-readable report, exceptions and worst 200 observations per font/field</a>.</p>
<div class="manifests">${manifest('before')}${manifest('after')}</div>
<h2>Cases</h2>${table(['Group', 'Total', 'Compared', 'Missing', 'Errors', 'Both skipped', 'Skip mismatch', 'Before skips', 'After skips'], Object.entries(report.summary).map(([group, s]) => [group, s.total, s.compared, s.missing, s.error, s.skipped, s['skip-mismatch'], s.skippedBefore, s.skippedAfter]))}
<h2>Gates</h2>${table(['Gate', 'Result', 'Within threshold', 'Fraction', 'Threshold', 'Observed differences', 'Reference envelope', 'Metadata', 'Why'], gateRows)}
${numberTables}<h2>Pixels</h2>${table(['Metric', 'Count', 'Max', 'Median', 'p99'], Object.entries(report.statistics.pixels).map(([name, s]) => [name, s.count, fmt(s.max), fmt(s.median), fmt(s.p99)]))}
<h2>Per-case details, worst first</h2><p>Heat map: magenta = threshold-mask XOR (opacity 128–255 by magnitude); yellow = alpha difference (opacity = magnitude). Images share aligned coordinates; exact original PNGs are linked. Asset limit: ${report.assets?.limit ?? 0} per group, plus every gate exception.</p>
<div class="filters"><label>Search <input id="search" type="search"></label><label>Font <select id="font"></select></label><label>Tag <select id="tag"></select></label><label>Gate <select id="gate"></select></label><label>Group <select id="group"></select></label><label>Zoom <select id="zoom"><option value="2">2×</option><option value="1">1×</option><option value="4">4×</option></select></label></div>
<p id="count" aria-live="polite"></p><div id="cases"></div><button id="more">Show 100 more</button>
<script type="application/json" id="data">${embedded}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent);
const byId=id=>document.getElementById(id);
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const timers=new Map();let shown=100;
for(const key of ['font','tag','gate','group']){const values=[...new Set(data.flatMap(c=>key==='tag'?c.tags:key==='gate'?c.gates:[c[key]]))].sort();byId(key).innerHTML='<option value="">All</option>'+values.map(v=>'<option>'+e(v)+'</option>').join('');byId(key).onchange=()=>{shown=100;render()}}
byId('search').oninput=()=>{shown=100;render()};byId('zoom').onchange=render;byId('more').onclick=()=>{shown+=100;render()};
function lines(a,b){const count=Math.max(a?.length??0,b?.length??0);return '<div class="lines">'+[a,b].map((list,side)=>'<section><b>'+['Before','After'][side]+'</b><ol>'+Array.from({length:count},(_,i)=>'<li class="'+(a?.[i]===b?.[i]?'':'changed')+'">'+e(list?.[i]??'[missing]')+'</li>').join('')+'</ol></section>').join('')+'</div>'}
function picture(c,key,label){const z=Number(byId('zoom').value);return '<figure><figcaption>'+label+'</figcaption><div class="checker"><img loading="lazy" alt="'+label+' '+e(c.id)+'" src="'+e(c.images[key])+'" style="width:'+c.image.width*z+'px;height:'+c.image.height*z+'px"></div></figure>'}
function render(){for(const timer of timers.values())clearInterval(timer);timers.clear();const query=byId('search').value.toLowerCase();const filtered=data.filter(c=>(!query||c.id.toLowerCase().includes(query))&&(!byId('font').value||c.font===byId('font').value)&&(!byId('tag').value||c.tags.includes(byId('tag').value))&&(!byId('gate').value||c.gates.includes(byId('gate').value))&&(!byId('group').value||c.group===byId('group').value));byId('count').textContent=Math.min(shown,filtered.length)+' of '+filtered.length+' cases';byId('more').hidden=shown>=filtered.length;byId('cases').innerHTML=filtered.slice(0,shown).map(c=>'<article class="case"><h3>'+e(c.id)+'</h3><p>'+e([c.group,c.font,c.mode,c.status,...c.tags].filter(Boolean).join(' · '))+'</p><p class="fail">'+e(c.gates.join(', '))+'</p>'+(c.image?'<pre>'+e(JSON.stringify(c.image,null,2))+'</pre>':'')+(c.images?'<div class="pictures">'+picture(c,'beforeAligned','Before')+picture(c,'afterAligned','After')+picture(c,'heat','Heat map')+'</div><button data-flicker="'+e(c.id)+'">Start flicker</button> <a href="'+e(c.images.before)+'">Original before</a> · <a href="'+e(c.images.after)+'">Original after</a>':c.image?'<p class="muted">Images omitted by asset limit; metrics are included.</p>':'')+(c.layout?lines(c.linesA,c.linesB)+'<details><summary>Layout changes</summary><pre>'+e(JSON.stringify(c.layout,null,2))+'</pre></details>':'')+(c.status!=='compared'?'<pre>'+e(JSON.stringify({before:c.before,after:c.after},null,2))+'</pre>':'')+(c.differences.length?'<details><summary>'+c.differences.length+' numeric differences</summary><pre>'+e(JSON.stringify(c.differences,null,2))+'</pre></details>':'')+'</article>').join('');}
byId('cases').onclick=event=>{const button=event.target.closest('[data-flicker]');if(!button)return;const id=button.dataset.flicker;const c=data.find(c=>c.id===id&&c.images);const img=button.closest('article').querySelector('img');if(timers.has(id)){clearInterval(timers.get(id));timers.delete(id);img.src=c.images.beforeAligned;button.textContent='Start flicker'}else{let after=false;timers.set(id,setInterval(()=>{after=!after;img.src=after?c.images.afterAligned:c.images.beforeAligned},500));button.textContent='Stop flicker'}};
render();
</script></body></html>`;
}
