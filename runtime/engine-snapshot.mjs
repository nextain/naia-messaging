import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ROOTS = ['LICENSE', 'package.json', 'core', 'adapters', 'engine', 'runtime'];
const digest = value => createHash('sha256').update(value).digest('hex');

export function snapshotFiles(root) {
  const files = [];
  function visit(relative) {
    const full = join(root, relative), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('package snapshot contains a symbolic link');
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push({ path: relative, sha256: digest(readFileSync(full)), bytes: stat.size });
    } else throw new Error('package snapshot contains an unsupported entry');
  }
  for (const relative of ROOTS) visit(relative);
  return files;
}

export function engineSnapshotDigest(root) {
  return digest(JSON.stringify(snapshotFiles(root)));
}

export function validateEngineLock(lock) {
  if (lock?.schemaVersion !== 1 || lock.repository !== 'nextain/naia-messaging'
      || !/^[a-f0-9]{40}$/.test(lock.revision ?? '')
      || !/^[a-f0-9]{64}$/.test(lock.snapshotSha256 ?? '')) throw new Error('invalid pinned engine lock');
  return lock;
}

export function verifyEngineSnapshot(root, lock) {
  validateEngineLock(lock);
  if (!isAbsolute(root) || realpathSync(root) !== resolve(root) || lstatSync(root).isSymbolicLink()) throw new Error('invalid engine snapshot root');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'naia-messaging' || pkg.dependencies && Object.keys(pkg.dependencies).length) {
    throw new Error('engine dependency closure is not self-contained');
  }
  if (engineSnapshotDigest(root) !== lock.snapshotSha256) throw new Error('engine snapshot digest mismatch');
  return lock;
}

/** Install only into a new versioned destination; callers own activation/rollback. */
export function installEngineSnapshot({ sourceRoot, destination, lock }) {
  sourceRoot = resolve(sourceRoot); destination = resolve(destination);
  verifyEngineSnapshot(sourceRoot, lock);
  if (existsSync(destination)) { verifyEngineSnapshot(destination, lock); return destination; }
  const parent = dirname(destination);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== resolve(parent) || lstatSync(parent).isSymbolicLink()) throw new Error('engine destination parent is a symbolic link');
  const stage = `${destination}.${randomUUID()}.stage`;
  mkdirSync(stage, { mode: 0o700 });
  // A failed stage remains available for diagnosis and is never activated.
  for (const file of snapshotFiles(sourceRoot)) {
    const target = join(stage, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(join(sourceRoot, file.path), target, { errorOnExist: true, force: false });
    chmodSync(target, 0o600);
  }
  verifyEngineSnapshot(stage, lock);
  // A deployment lock in the caller serializes installation and activation.
  if (existsSync(destination)) throw new Error('engine destination appeared during installation');
  renameSync(stage, destination);
  return destination;
}
