import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'PUBLIC_SOURCE.json'), 'utf8'));
assert.equal(manifest.formatVersion, 1);
assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
if (existsSync(resolve(root, '.git'))) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  assert.deepEqual(tracked, [...Object.keys(manifest.files), 'PUBLIC_SOURCE.json'].sort(), 'Tracked source inventory differs from the reviewed export');
}
for (const [name, expected] of Object.entries(manifest.files)) {
  const target = resolve(root, name);
  const child = relative(root, target);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
  const bytes = readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
}
console.log('Verified ' + Object.keys(manifest.files).length + ' exported source files.');
