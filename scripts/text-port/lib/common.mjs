import { resolve, relative, isAbsolute, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const runIdNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export function safeId(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || id.includes('..')) throw new Error(`Unsafe id: ${id}`);
  return id;
}
export function guardedPath(base, path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsafe path: ${path}`);
  const target = resolve(base, path);
  const rel = relative(resolve(base), target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Path escapes data: ${path}`);
  // Lexical containment is insufficient when an existing component is a link.
  let at = resolve(base);
  for (const part of ['', ...rel.split(sep)]) {
    if (part) at = resolve(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) throw new Error(`Symlink in data path: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}
export function flags(allowed, argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Expected ${allowed.join(', ')} with values`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
export function gitInfo() {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}
export const dataDir = (value) => resolve(value || process.env.TP_DATA || resolve(root, 'node_modules/.cache/text-port'));
