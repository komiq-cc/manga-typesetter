// Session-only equivalent of putGroupFace: no persistence, no generic CSS
// family list, and no built-in descriptor that claims an unprovided face.
export function prepareFonts(store, list) {
  const groups = new Map();
  const slots = ['regular', 'bold', 'italic', 'boldItalic'];
  for (const f of list.fonts) {
    if (!f.family || /['\\\r\n]/.test(f.family) || !slots.includes(f.slot)) throw new Error(`Invalid font family/slot: ${JSON.stringify(f)}`);
    let g = groups.get(f.family);
    if (!g) {
      g = { name: f.family, css: `'${f.family}'`, real: true, faces: Object.fromEntries(slots.map((s) => [s, null])) };
      groups.set(f.family, g);
    }
    if (g.faces[f.slot]) throw new Error(`Duplicate font face: ${f.family}/${f.slot}`);
    g.faces[f.slot] = { file: f.file };
  }
  if (!groups.size) throw new Error('fonts.json contains no fonts');
  store.app.fonts = { builtin: [], user: [...groups.values()], system: [] };
  for (const g of groups.values()) {
    if (store.fontByName(g.name)?.name !== g.name || store.fontCssFor(g.name) !== g.css) throw new Error(`Store substituted font '${g.name}'`);
  }
  return [...groups.keys()];
}
