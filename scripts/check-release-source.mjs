import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readReleasePackage(root = '.') {
  const read = name => readFileSync(path.join(root, name), 'utf8');
  if (existsSync(path.join(root, 'pyproject.toml'))) {
    const project = read('pyproject.toml').split('[project]')[1]?.split('\n[')[0] ?? '';
    return { name: /^name = "([^"]+)"/m.exec(project)?.[1], version: /^version = "([^"]+)"/m.exec(project)?.[1] };
  }
  if (existsSync(path.join(root, 'src/ModernEdi/ModernEdi.csproj'))) {
    const project = read('src/ModernEdi/ModernEdi.csproj');
    return { name: /<PackageId>([^<]+)<\/PackageId>/.exec(project)?.[1], version: /<Version>([^<]+)<\/Version>/.exec(project)?.[1] };
  }
  return JSON.parse(read('package.json'));
}

export function assertReviewedPublicSource({ manifest, pkg, environment, head, now = Date.now() }) {
  const { EXPECTED_VERSION, EXPECTED_SOURCE_SHA, EXPECTED_SOURCE_REVISION } = environment;
  assert.match(EXPECTED_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(EXPECTED_SOURCE_REVISION ?? '', /^[a-f0-9]{40}$/);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(environment.GITHUB_SHA, EXPECTED_SOURCE_SHA, 'The dispatched main branch moved');
  assert.equal(head, EXPECTED_SOURCE_SHA, 'The checkout is not the reviewed public commit');
  assert.equal(environment.GITHUB_REPOSITORY, manifest.repository);
  assert.equal(manifest.sourceRevision, EXPECTED_SOURCE_REVISION);
  assert.equal(manifest.version, EXPECTED_VERSION);
  assert.equal(pkg.version, EXPECTED_VERSION);
  assert.equal(pkg.name, manifest.package);
  const receipt = manifest.verification;
  assert.equal(receipt?.version, 1, 'A verified upstream export is required');
  assert.equal(receipt.revision, EXPECTED_SOURCE_REVISION);
  assert.equal(receipt.scope, manifest.repository.split('/')[1]);
  assert.ok(Array.isArray(receipt.commands) && receipt.commands.length > 0);
  const age = now - Date.parse(receipt.verifiedAt);
  assert.ok(Number.isFinite(age) && age >= -300_000 && age <= 86_400_000,
    'Re-verify and export: upstream verification is older than 24 hours');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertReviewedPublicSource({
    manifest: JSON.parse(readFileSync('PUBLIC_SOURCE.json', 'utf8')),
    pkg: readReleasePackage(),
    environment: process.env,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  });
  console.log('Verified exact public commit, upstream revision, version, and release-verification receipt.');
}
