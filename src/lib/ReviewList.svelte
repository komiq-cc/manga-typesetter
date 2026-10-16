<script>
  // The queue's check list (UX-6, FLOW-1): every box or line in the chapter
  // that still needs a look, counted, grouped by reason, one click from each to
  // the place. It only reads `checks.items` (store.svelte.js); fixing the box
  // is what clears its row.
  import { app, checks, openCheck, boxText, lineText, lineByN } from './store.svelte.js';
  import { reviewReason, reviewWhere, reviewTitle } from './review-label.js';

  const items = $derived(checks.items);
  let open = $state(false);

  // What each reason is called, in the order the groups show.
  const GROUPS = [
    ['overflow', 'Text does not fit'],
    ['open', 'No bubble outline found'],
    ['outline', 'Outline not approved'],
    ['stale', 'Layout out of date'],
    ['empty', 'No text yet'],
    ['font', 'Font missing'],
    ['unplaced', 'Line not placed'],
  ];

  // Built only while the list is open: a chapter opening can list dozens of
  // boxes, and the text of each is a line lookup.
  const groups = $derived.by(() => {
    if (!open) return [];
    const by = new Map();
    for (const it of items) {
      const pg = app.pages[it.pageIndex];
      if (!pg) continue;
      const b = it.boxId != null ? pg.boxes.find((x) => x.id === it.boxId) : null;
      const text = b ? boxText(b, pg) : lineText(lineByN(pg, it.lineN));
      const row = {
        key: `${it.reason}:${it.pageId}:${it.boxId ?? 'l' + it.lineN}`,
        it,
        text: String(text ?? '').replace(/\s+/g, ' ').trim(),
        why: whyOf(it),
        title: it.reason === 'overflow' ? reviewTitle(it.review) : undefined,
      };
      if (!by.has(it.reason)) by.set(it.reason, []);
      by.get(it.reason).push(row);
    }
    // Outlines nobody approved: the least sure first (01-bubble-check.md).
    by.get('outline')?.sort((a, b) => a.it.confidence - b.it.confidence);
    return GROUPS.filter(([k]) => by.has(k)).map(([k, name]) => ({ key: k, name, rows: by.get(k) }));
  });

  function whyOf(it) {
    if (it.reason === 'overflow') {
      const where = reviewWhere(it.review);
      return `${reviewReason(it.review)}${where ? ` · ${where}` : ''}`;
    }
    if (it.reason === 'outline') return `${Math.round((it.confidence || 0) * 100)}% sure`;
    if (it.reason === 'font') return it.font;
    if (it.reason === 'unplaced') return `Line ${it.lineN}`;
    return '';
  }

  const here = (it) =>
    it.pageIndex === app.pageIndex && (it.boxId != null ? it.boxId === app.selectedId : !app.selectedId && app.pages[it.pageIndex]?.activeLineN === it.lineN);
</script>

{#if items.length}
  <div class="rv">
    <button class="rv-head" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="rv-mark" aria-hidden="true">!</span>
      <span class="rv-count">{items.length} to check</span>
      <svg class="rv-chev" class:open viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {#if open}
      <div class="rv-list">
        {#each groups as g (g.key)}
          <div class="rv-grp" data-reason={g.key}>
          <div class="rv-group">{g.name} <span class="rv-n">{g.rows.length}</span></div>
          {#each g.rows as r (r.key)}
            <button class="rv-row" class:here={here(r.it)} title={r.title} onclick={() => openCheck(r.it)}>
              <span class="rv-pg">p.{r.it.pageIndex + 1}</span>
              <span class="rv-col">
                <span class="rv-text">{r.text || 'Empty box'}</span>
                {#if r.why}<span class="rv-why">{r.why}</span>{/if}
              </span>
            </button>
          {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .rv {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 2px 0 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }
  .rv-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .rv-head:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-mark {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--warn);
    color: var(--panel);
    font-size: 11px;
    font-weight: 800;
  }
  .rv-count {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-chev {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    opacity: 0.7;
    transition: transform 0.12s;
  }
  .rv-chev.open {
    transform: rotate(180deg);
  }
  .rv-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rv-grp {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rv-group {
    padding: 6px 9px 2px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.2px;
    color: var(--t2);
  }
  .rv-n {
    font-weight: 600;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .rv-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rv-row:hover {
    background: var(--panel2);
  }
  .rv-row.here {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-pg {
    flex: 0 0 auto;
    min-width: 30px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--panel2);
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .rv-col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rv-text {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-why {
    font-size: 10.5px;
    color: var(--warn);
  }
</style>
