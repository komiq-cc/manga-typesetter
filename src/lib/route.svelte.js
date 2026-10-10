// ===== Where the app is =====
// A tagged union, not a set of booleans, so invalid combinations (an editor
// route with no chapter, say) cannot be represented.
//
//   { name: 'library' }
//   { name: 'project', projectId }
//   { name: 'editor',  projectId, chapterId }

export const route = $state({
  name: 'library',
  projectId: null,
  chapterId: null,
});

let history = [];
let navigation = 0;

// Set by library.svelte.js. Lives here as a hook rather than an import because
// the home screens navigate, so route -> library would be circular.
let leaveEditorHook = null;
export function setLeaveEditorHook(fn) {
  leaveEditorHook = fn;
}

function same(a, b) {
  return a.name === b.name && a.projectId === b.projectId && a.chapterId === b.chapterId;
}

// Resolves true when the route moved, false when leaving was refused.
async function go(next, { record = true } = {}) {
  const request = ++navigation;
  if (same(route, next)) return true;
  const from = { name: route.name, projectId: route.projectId, chapterId: route.chapterId };
  const current = () => request === navigation && same(route, from);
  if (route.name === 'editor' && leaveEditorHook) {
    try {
      await leaveEditorHook(current);
    } catch {
      // The hook could not put the chapter away safely (a failed save). It has
      // already told the user why; staying put keeps their work on screen.
      return false;
    }
  }
  if (!current()) return false;
  if (record) history.push(from);
  route.name = next.name;
  route.projectId = next.projectId;
  route.chapterId = next.chapterId;
  return true;
}

export function goLibrary() {
  return go({ name: 'library', projectId: null, chapterId: null });
}

export function goProject(projectId) {
  return go({ name: 'project', projectId, chapterId: null });
}

export function goEditor(projectId, chapterId) {
  return go({ name: 'editor', projectId, chapterId });
}

export async function goBack() {
  const prev = history.at(-1);
  if (!prev) return false;
  const pending = go(prev, { record: false });
  const request = navigation;
  const moved = await pending;
  // A refused leave must not eat the history entry the user is trying to reach.
  if (moved && request === navigation && history.at(-1) === prev) history.pop();
  return moved;
}

// Test-only: return to a clean slate between cases.
export function resetRoute() {
  navigation++;
  history = [];
  route.name = 'library';
  route.projectId = null;
  route.chapterId = null;
}
