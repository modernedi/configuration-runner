#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareSemver,
  createNpmClient,
  parseArgs,
  parseSemver,
  redactSecrets,
  releaseNpmPackage,
} from './npm-package-release.mjs';

const PROVISION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIRECTORY = PROVISION_ROOT;
const PACKAGE_NAME = '@modernedi/configuration-runner';
const SDK_VERSION = '0.8.2';
const REGISTRY = 'https://registry.npmjs.org/';
const REPOSITORY = 'git+https://github.com/modernedi/configuration-runner.git';
const WORKFLOW_REF =
  'modernedi/configuration-runner/.github/workflows/publish.yml@refs/heads/main';

async function main() {
  const options = parseArgs(process.argv.slice(2), PACKAGE_DIRECTORY);
  if (options.help) {
    printHelp();
    return;
  }
  const packageDirectory = path.resolve(options.packageDirectory);
  const npm = createConfigurationRunnerNpmClient(packageDirectory);
  const result = await releaseConfigurationRunner({ ...options, packageDirectory }, { npm });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function releaseConfigurationRunner(options = {}, dependencies = {}) {
  const result = await releaseNpmPackage(configurationRunnerProfile(), options, dependencies);
  if (options.planOnly) {
    return { ...result, firstPackageBootstrap: bootstrapGuidance(result.package.split('@').at(-1)) };
  }
  return result;
}

function configurationRunnerProfile() {
  return {
    packageName: PACKAGE_NAME,
    packageLabel: 'configuration runner',
    defaultPackageDirectory: PACKAGE_DIRECTORY,
    assertManifest: assertReleaseManifest,
    assertLock: assertRegistryBackedPackageLock,
    assertTrustedRuntime: assertTrustedPublishingRuntime,
    assertCanPublishAfter: assertRunnerCanPublishAfter,
    logger(message) {
      process.stdout.write(`[release:configuration-runner] ${redactSecrets(message)}\n`);
    },
    npmClientOptions: runnerNpmClientOptions(),
    plan(packageSpec) {
      return [
        `require a registry-backed lockfile with exact @modernedi/sdk@${SDK_VERSION}`,
        `verify, pack, and smoke-test exact ${packageSpec}`,
        `if ${PACKAGE_NAME} is absent, complete the reviewed prerelease bootstrap before automation`,
        'publish stable versions from the canonical protected Trusted Publishing workflow',
        'verify immutable registry integrity and smoke-test the exact registry version',
      ];
    },
    async verifyPrerequisites({ npm, packageLock }) {
      const lockedSdk = packageLock.packages['node_modules/@modernedi/sdk'];
      const registrySdk = await npm.lookupVersion('@modernedi/sdk', SDK_VERSION);
      if (!registrySdk) {
        throw new Error(`Public @modernedi/sdk@${SDK_VERSION} must be published first.`);
      }
      if (registrySdk.integrity !== lockedSdk.integrity) {
        throw new Error(
          `The lockfile does not pin public @modernedi/sdk@${SDK_VERSION} integrity. `
          + `Regenerate it against ${REGISTRY}.`,
        );
      }
      return { sdk: { version: SDK_VERSION, integrity: registrySdk.integrity } };
    },
    handleMissingPackage({ options, manifest, packed, prerequisiteResult }) {
      if (!options.dryRun) return undefined;
      return {
        mode: 'dry-run',
        package: `${manifest.name}@${manifest.version}`,
        integrity: packed.integrity,
        publication: 'bootstrap-required',
        localTarballSmoke: 'passed',
        registryInstallSmoke: 'after-bootstrap',
        ...prerequisiteResult,
        mutatesRegistry: false,
        firstPackageBootstrap: bootstrapGuidance(manifest.version),
      };
    },
    missingPackageMessage(packageSpec) {
      return `${PACKAGE_NAME} is absent from public npm. Automated publication of ${packageSpec} is intentionally `
        + `disabled until the reviewed one-time bootstrap is complete. ${bootstrapGuidance(packageSpec.split('@').at(-1)).summary}`;
    },
  };
}

function createConfigurationRunnerNpmClient(packageDirectory, execute) {
  return createNpmClient({
    packageDirectory,
    execute,
    ...runnerNpmClientOptions(),
  });
}

function runnerNpmClientOptions() {
  return {
    packageLabel: 'configuration runner',
    smokeDirectoryPrefix: 'modernedi-runner-install-smoke-',
    smokeSource: (name) =>
      `import * as runner from ${JSON.stringify(name)};\n`
      + "if (typeof runner.planConfiguration !== 'function') throw new Error('planConfiguration export is missing');\n"
      + "if (typeof runner.verifyReviewedConfiguration !== 'function') throw new Error('verifyReviewedConfiguration export is missing');\n",
  };
}

function assertReleaseManifest(manifest) {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(`Refusing to publish ${String(manifest?.name)}; expected ${PACKAGE_NAME}.`);
  }
  const version = parseSemver(manifest.version);
  if (version.prerelease.length > 0) {
    throw new Error(`Automated publication accepts stable versions only, not ${manifest.version}.`);
  }
  if (manifest.private === true) throw new Error(`${PACKAGE_NAME} is marked private.`);
  if (manifest.dependencies?.['@modernedi/sdk'] !== SDK_VERSION) {
    throw new Error(`${PACKAGE_NAME} must depend on exact @modernedi/sdk@${SDK_VERSION}.`);
  }
  if (
    manifest.repository?.type !== 'git'
    || manifest.repository?.url !== REPOSITORY
    || manifest.repository?.directory !== undefined
  ) {
    throw new Error(`${PACKAGE_NAME} must declare its public package repository.`);
  }
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== REGISTRY) {
    throw new Error(`${PACKAGE_NAME} must publish publicly only to ${REGISTRY}.`);
  }
  if (Object.keys(manifest.publishConfig ?? {}).some((key) => /auth|password|token|username/iu.test(key))) {
    throw new Error(`${PACKAGE_NAME} publishConfig must not contain credentials.`);
  }
  const installHooks = ['preinstall', 'install', 'postinstall']
    .filter((name) => Object.hasOwn(manifest.scripts ?? {}, name));
  if (installHooks.length > 0) {
    throw new Error(`Consumer installation hooks are not allowed: ${installHooks.join(', ')}.`);
  }
}

function assertRegistryBackedPackageLock(packageLock, manifest) {
  const root = packageLock?.packages?.[''];
  const sdk = packageLock?.packages?.['node_modules/@modernedi/sdk'];
  const problems = [];
  if (packageLock?.lockfileVersion !== 3) problems.push('lockfileVersion must be 3');
  if (packageLock?.name !== manifest.name || root?.name !== manifest.name) problems.push('package name mismatch');
  if (packageLock?.version !== manifest.version || root?.version !== manifest.version) {
    problems.push('package version mismatch');
  }
  if (root?.dependencies?.['@modernedi/sdk'] !== SDK_VERSION || sdk?.version !== SDK_VERSION) {
    problems.push(`SDK dependency must be exact ${SDK_VERSION}`);
  }
  for (const field of ['dependencies', 'devDependencies']) {
    if (JSON.stringify(root?.[field] ?? {}) !== JSON.stringify(manifest?.[field] ?? {})) {
      problems.push(`root ${field} do not match package.json`);
    }
  }
  for (const [name, entry] of Object.entries(packageLock?.packages ?? {})) {
    if (name === '') continue;
    if (entry?.link === true) problems.push(`${name} must not be linked`);
    if (!isRegistryResolution(entry?.resolved)) problems.push(`${name} is not registry-backed`);
    if (typeof entry?.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      problems.push(`${name} lacks sha512 integrity`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Configuration runner package-lock.json is not clean and registry-backed: ${problems.join('; ')}. `
      + `Publish @modernedi/sdk@${SDK_VERSION}, remove repository links, then regenerate with npm install.`,
    );
  }
}

function isRegistryResolution(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'registry.npmjs.org'
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function assertTrustedPublishingRuntime(environment) {
  const expected = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'modernedi/configuration-runner',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
  };
  const invalid = Object.entries(expected)
    .filter(([key, value]) => environment?.[key] !== value)
    .map(([key]) => key);
  for (const key of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    if (typeof environment?.[key] !== 'string' || environment[key].trim() === '') invalid.push(key);
  }
  for (const key of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'npm_config__authToken']) {
    if (typeof environment?.[key] === 'string' && environment[key].trim() !== '') invalid.push(key);
  }
  if (invalid.length > 0) {
    throw new Error(`Refusing publication outside the canonical runner Trusted Publishing workflow: ${invalid.join(', ')}.`);
  }
}

function assertRunnerCanPublishAfter(currentLatest, candidateVersion, _packageName, tags) {
  const candidate = parseSemver(candidateVersion);
  if (currentLatest) {
    if (compareSemver(candidate, parseSemver(currentLatest)) <= 0) {
      throw new Error(`Refusing to publish ${candidateVersion}: public npm latest is ${currentLatest}.`);
    }
    return;
  }
  const bootstrapVersion = tags?.next;
  if (!bootstrapVersion) {
    throw new Error(`${PACKAGE_NAME} has neither latest nor the reviewed next bootstrap tag.`);
  }
  const bootstrap = parseSemver(bootstrapVersion);
  if (bootstrap.prerelease.length === 0 || compareSemver(candidate, bootstrap) <= 0) {
    throw new Error(
      `Refusing first stable publication ${candidateVersion}: next=${bootstrapVersion} is not an older prerelease.`,
    );
  }
}

function bootstrapGuidance(finalVersion) {
  const version = parseSemver(finalVersion);
  const prereleaseVersion = `${version.major}.${version.minor}.${version.patch}-rc.0`;
  return {
    required: true,
    prereleaseVersion,
    summary: `Publish reviewed ${PACKAGE_NAME}@${prereleaseVersion} once with maintainer npm 2FA under next; `
      + 'then configure the npm Trusted Publisher for modernedi/configuration-runner, '
      + 'publish.yml, and npm-production before running the stable workflow.',
  };
}

function printHelp() {
  process.stdout.write('Verify and publish @modernedi/configuration-runner using the shared npm release engine.\n\n'
    + 'Usage: node scripts/release-configuration-runner.mjs '
    + '[--expected-version <semver>] [--dry-run|--plan-only]\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}

export {
  assertRegistryBackedPackageLock,
  assertReleaseManifest,
  assertTrustedPublishingRuntime,
  bootstrapGuidance,
  createConfigurationRunnerNpmClient,
  releaseConfigurationRunner,
};
