// Session work only. A finished success disappears; failures stay until they
// are retried or dismissed, without becoming part of a chapter's saved data.
export const jobs = $state({ items: [] });
let nextId = 1;

export function startJob(kind, label, total, current = () => true) {
  const job = $state({
    id: nextId++, kind, label, done: 0, total, failed: [],
    running: true, cancelled: false, current, retry: null,
    cancel() { job.cancelled = true; },
  });
  jobs.items = [...jobs.items.filter((j) => j.current()), job];
  return job;
}

export function dismissJob(job) {
  if (job.running) return;
  jobs.items = jobs.items.filter((j) => j.id !== job.id);
}

export function finishJob(job) {
  job.running = false;
  if (!job.failed.length || !job.current()) dismissJob(job);
}
