import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('public README commands and SDK dependency match the package being released', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const commands = [...readme.matchAll(/^npx --yes @modernedi\/configuration-runner@(\S+) (\S+)/gm)];
  assert.deepEqual(new Set(commands.map(([, , command]) => command)), new Set(['plan', 'verify', 'apply-reviewed', 'wait']));
  for (const [, version] of commands) assert.equal(version, manifest.version);
  assert.deepEqual([...readme.matchAll(/@modernedi\/sdk@([\d.]+)/g)].map(([, version]) => version), [manifest.dependencies['@modernedi/sdk']]);
  assert.doesNotMatch(readme, /^modernedi-configuration /m, 'npx users must not need an undocumented global installation');
});
