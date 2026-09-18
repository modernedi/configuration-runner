import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'PUBLIC_SOURCE.json'), 'utf8'));
assert.equal(manifest.formatVersion, 1);
assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
for (const [name, expected] of Object.entries(manifest.files)) {
  const target = resolve(root, name);
  const child = relative(root, target);
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
  const bytes = readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
}
console.log('Verified ' + Object.keys(manifest.files).length + ' exported source files.');
