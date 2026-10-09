// For the editor check alone: a painter made to refuse some jobs, the way the
// engine refuses one it will not paint (it throws). `marker` is text a job
// must hold to be refused; null puts the painter back as it was.
const wrapped = new WeakMap();
export function flipTestPaint(painter, marker) {
  if (!wrapped.has(painter)) wrapped.set(painter, painter.paint);
  const paint = wrapped.get(painter);
  painter.paint = marker
    ? (ctx, job) => {
        if (job.runs.some((r) => String(r.text).includes(marker))) throw new Error('editor-check: this job is refused');
        return paint(ctx, job);
      }
    : paint;
  return !!marker;
}
