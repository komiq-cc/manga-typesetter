// The element structure of a mounted component, as text: one line per element
// with its tag, classes, attributes and inline style, indented by depth, and
// the text it holds. Comments are left out (Svelte's block anchors are not
// structure) and so is the scoped-style class Svelte adds, which is a hash of
// the stylesheet and not something a user or a selector of ours can see.
export function domOutline(node, depth = 0) {
  const out = [];
  const pad = '  '.repeat(depth);
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // Whitespace between elements is the template's formatting; whitespace
      // that is all an element holds is its text (a space on a curve, the
      // zero-width space of an empty line).
      if (child.nodeValue.trim() !== '' || !node.children.length) out.push(`${pad}${JSON.stringify(child.nodeValue)}`);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const classes = [...child.classList].filter((c) => !/^svelte-/.test(c)).join('.');
    const attrs = [...child.attributes]
      .filter((a) => a.name !== 'class')
      .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
      .join(' ');
    out.push(`${pad}${child.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${attrs ? ` ${attrs}` : ''}`);
    out.push(...domOutline(child, depth + 1));
  }
  return depth === 0 ? out.join('\n') : out;
}
