import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const DEFAULT_PACKAGE_DIRECTORY = process.cwd();
const RELEASE_TAG = 'latest';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const DEPLOYED_OPENAPI_URLS = [
  'https://app.modernedi.com/integration-api/openapi.yaml',
  'https://www.modernedi.com/integration-api/openapi.yaml',
];

function parseArgs(argv, defaultPackageDirectory = DEFAULT_PACKAGE_DIRECTORY) {
  const options = {
    packageDirectory: defaultPackageDirectory,
    expectedVersion: undefined,
    dryRun: false,
    planOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--package-directory':
        options.packageDirectory = requireValue(argv, ++index, argument);
        break;
      case '--expected-version':
        options.expectedVersion = requireValue(argv, ++index, argument);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--plan-only':
        options.planOnly = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument ${argument}. Use --help for usage.`);
    }
  }

  if (options.dryRun && options.planOnly) {
    throw new Error('--dry-run and --plan-only are mutually exclusive.');
  }
  return options;
}

function requireValue(argv, index, flagName) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

async function releaseNpmPackage(profile, options = {}, dependencies = {}) {
  const packageDirectory = path.resolve(
    options.packageDirectory ?? profile.defaultPackageDirectory,
  );
  const manifest = readPackageManifest(packageDirectory, dependencies.fs ?? fs);
  profile.assertManifest(manifest);
  if (options.expectedVersion !== undefined && manifest.version !== options.expectedVersion) {
    throw new Error(
      `Expected ${profile.packageLabel} version ${options.expectedVersion}, but package.json declares ${manifest.version}.`,
    );
  }
  const packageLock = readPackageLock(packageDirectory, dependencies.fs ?? fs);
  profile.assertLock(packageLock, manifest);
  const packageSpec = `${manifest.name}@${manifest.version}`;
  const plan = profile.plan(packageSpec, manifest, packageLock);

  if (options.planOnly) {
    return {
      mode: 'plan',
      package: packageSpec,
      mutatesRegistry: false,
      plan,
    };
  }

  const npm = dependencies.npm ?? createNpmClient({
    packageDirectory,
    ...(profile.npmClientOptions ?? {}),
  });
  const temporaryDirectory = (dependencies.makeTemporaryDirectory ?? makeTemporaryDirectory)();
  const sleep = dependencies.sleep ?? defaultSleep;
  const logger = dependencies.logger ?? profile.logger ?? defaultLogger;

  try {
    logger(`Verifying ${packageSpec}.`);
    await npm.verify();
    const packed = await npm.pack(temporaryDirectory);
    assertPackedPackage(packed, manifest, temporaryDirectory);
    logger(`Installing and importing local tarball for ${packageSpec} before registry mutation.`);
    await npm.smokeInstallTarball(packed.tarballPath, manifest.name, manifest.version);

    const prerequisiteResult = await profile.verifyPrerequisites({
      dependencies,
      manifest,
      packageLock,
      npm,
      packed,
    });

    logger(`Checking public npm state for ${packageSpec}.`);
    const initialTags = await npm.readDistTags(manifest.name);
    let registryVersion = await npm.lookupVersion(manifest.name, manifest.version);
    if (!initialTags) {
      const missingResult = await profile.handleMissingPackage?.({
        options,
        manifest,
        packageLock,
        packed,
        prerequisiteResult,
      });
      if (missingResult !== undefined) return missingResult;
      throw new Error(profile.missingPackageMessage(packageSpec, manifest));
    }

    if (registryVersion) {
      assertSameIntegrity(packed, registryVersion, packageSpec);
      assertExistingVersionTagState(initialTags.latest, manifest.version, profile.packageName);
      logger(`${packageSpec} already has the same packed integrity; publication is a no-op.`);
      if (options.dryRun) {
        return {
          mode: 'dry-run',
          package: packageSpec,
          integrity: packed.integrity,
          publication: 'already-published',
          localTarballSmoke: 'passed',
          registryInstallSmoke: 'would-run',
          ...prerequisiteResult,
          latest: initialTags.latest,
          mutatesRegistry: false,
        };
      }
      await npm.smokeInstallRegistry(manifest.name, manifest.version);
      return {
        mode: 'release',
        package: packageSpec,
        integrity: packed.integrity,
        publication: 'already-published',
        localTarballSmoke: 'passed',
        registryInstallSmoke: 'passed',
        ...prerequisiteResult,
        latest: initialTags.latest,
        mutatesRegistry: false,
      };
    }

    (profile.assertCanPublishAfter ?? assertCanPublishAfter)(
      initialTags.latest,
      manifest.version,
      profile.packageName,
      initialTags,
    );
    if (options.dryRun) {
      return {
        mode: 'dry-run',
        package: packageSpec,
        integrity: packed.integrity,
        publication: 'would-publish-latest',
        localTarballSmoke: 'passed',
        registryInstallSmoke: 'after-publication',
        ...prerequisiteResult,
        latest: { from: initialTags.latest, to: manifest.version },
        mutatesRegistry: false,
      };
    }

    profile.assertTrustedRuntime(dependencies.environment ?? process.env);
    logger(`Publishing ${packageSpec} directly under ${RELEASE_TAG} using npm Trusted Publishing.`);
    let publishError;
    try {
      await npm.publish(packed.tarballPath);
    } catch (error) {
      publishError = error;
      logger('npm publish did not return success; re-querying exact integrity and latest before classifying it.');
    }
    const publishedState = await awaitPublishedRelease(
      npm,
      manifest.name,
      manifest.version,
      { sleep, attempts: publishError === undefined ? 25 : 15, tolerateLookupErrors: publishError !== undefined },
    );
    if (!publishedState?.version || publishedState.tags?.latest !== manifest.version) {
      const diagnostic = publishError ? `: ${safeMessage(publishError)}` : '';
      throw new Error(
        `Could not verify ${packageSpec} at exact integrity with ${RELEASE_TAG}=${manifest.version}${diagnostic}`,
      );
    }
    assertSameIntegrity(packed, publishedState.version, packageSpec);
    logger(`Installing and importing exact ${packageSpec} from public npm.`);
    await npm.smokeInstallRegistry(manifest.name, manifest.version);
    return {
      mode: 'release',
      package: packageSpec,
      integrity: packed.integrity,
      publication: publishError ? 'published-after-ambiguous-result' : 'published',
      localTarballSmoke: 'passed',
      registryInstallSmoke: 'passed',
      ...prerequisiteResult,
      latest: { from: initialTags.latest, to: manifest.version },
      mutatesRegistry: true,
    };
  } finally {
    removeTemporaryDirectory(temporaryDirectory, dependencies.fs ?? fs, logger);
  }
}

function readPackageManifest(packageDirectory, fileSystem = fs) {
  const manifestPath = path.join(packageDirectory, 'package.json');
  try {
    return JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read npm package metadata at ${manifestPath}: ${safeMessage(error)}`);
  }
}

function readPackageLock(packageDirectory, fileSystem = fs) {
  const lockPath = path.join(packageDirectory, 'package-lock.json');
  try {
    return JSON.parse(fileSystem.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read npm package lockfile at ${lockPath}: ${safeMessage(error)}`);
  }
}

function assertPackageLock(packageLock, manifest) {
  const rootPackage = packageLock?.packages?.[''];
  const mismatches = [];
  if (packageLock?.name !== manifest.name) {
    mismatches.push(`top-level name is ${String(packageLock?.name)}`);
  }
  if (packageLock?.version !== manifest.version) {
    mismatches.push(`top-level version is ${String(packageLock?.version)}`);
  }
  if (rootPackage?.name !== manifest.name) {
    mismatches.push(`packages[""] name is ${String(rootPackage?.name)}`);
  }
  if (rootPackage?.version !== manifest.version) {
    mismatches.push(`packages[""] version is ${String(rootPackage?.version)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `package-lock.json does not match ${manifest.name}@${manifest.version}: ${mismatches.join('; ')}. `
      + 'Run npm install in the package directory after changing its version.',
    );
  }
}

function assertPackedPackage(packed, manifest, temporaryDirectory) {
  if (!packed || typeof packed !== 'object') {
    throw new Error('npm pack did not return package metadata.');
  }
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error(
      `npm packed ${String(packed.name)}@${String(packed.version)} instead of ${manifest.name}@${manifest.version}.`,
    );
  }
  if (typeof packed.integrity !== 'string' || !packed.integrity.startsWith('sha512-')) {
    throw new Error('npm pack did not report a sha512 integrity for the exact tarball.');
  }
  if (!isWithin(packed.tarballPath, temporaryDirectory)) {
    throw new Error('npm pack wrote the package tarball outside the temporary release directory.');
  }
}

function assertSameIntegrity(packed, registryVersion, packageSpec) {
  if (typeof registryVersion.integrity !== 'string' || registryVersion.integrity.length === 0) {
    throw new Error(`Registry metadata for ${packageSpec} does not include dist.integrity; refusing to guess.`);
  }
  if (registryVersion.integrity !== packed.integrity) {
    throw new Error(
      `Version collision for ${packageSpec}: the registry integrity differs from the exact packed tarball. `
      + 'npm versions are immutable; increment the package version instead of overwriting it.',
    );
  }
}

async function verifyDeployedOpenApi(options = {}) {
  if (typeof options.fetch !== 'function') {
    throw new Error('No fetch implementation is available for deployed OpenAPI verification.');
  }
  const localBytes = canonicalOpenApiBytes(options.readLocalFile());
  const expectedSha256 = sha256(localBytes);
  for (const url of DEPLOYED_OPENAPI_URLS) {
    let response;
    try {
      response = await options.fetch(url, { redirect: 'error' });
    } catch (error) {
      throw new Error(`Could not fetch deployed OpenAPI document ${url}: ${safeMessage(error)}`);
    }
    if (!response?.ok) {
      throw new Error(
        `Could not verify deployed OpenAPI document ${url}: HTTP ${String(response?.status ?? 'unknown')}.`,
      );
    }
    const actualSha256 = sha256(canonicalOpenApiBytes(await response.arrayBuffer()));
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Deployed OpenAPI document ${url} does not match the bundled local Integration API specification `
        + 'after CRLF/LF normalization by SHA-256.',
      );
    }
  }
  return {
    status: 'matched',
    sha256: expectedSha256,
    urls: [...DEPLOYED_OPENAPI_URLS],
  };
}

function canonicalOpenApiBytes(value) {
  return Buffer.from(Buffer.from(value).toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function awaitPublishedRelease(npm, name, version, options = {}) {
  // Accepted npm uploads have taken over six minutes to reach public metadata.
  // Allow about ten minutes after success, five after an error; never re-upload.
  const attempts = options.attempts ?? 15;
  let lastLookupError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const [found, tags] = await Promise.all([
        npm.lookupVersion(name, version),
        npm.readDistTags(name),
      ]);
      if (found && tags?.latest === version) {
        return { version: found, tags };
      }
    } catch (error) {
      lastLookupError = error;
      if (!options.tolerateLookupErrors) {
        throw error;
      }
    }
    if (attempt + 1 < attempts) {
      await options.sleep(retryDelay(attempt));
    }
  }
  if (lastLookupError && options.tolerateLookupErrors) {
    return undefined;
  }
  return undefined;
}

function retryDelay(attempt) {
  return Math.min(30_000, 1_000 * (2 ** attempt));
}

function assertCanPublishAfter(currentLatest, version, packageName) {
  const candidate = parseSemver(version);
  if (candidate.prerelease.length > 0) {
    throw new Error(`Refusing to publish prerelease ${version} under the latest dist-tag.`);
  }
  if (!currentLatest) {
    throw new Error(
      `Public npm package ${packageName} has no latest dist-tag; reconcile it manually before automated publication.`,
    );
  }
  const comparison = compareSemver(candidate, parseSemver(currentLatest));
  if (comparison <= 0) {
    throw new Error(
      `Refusing to publish ${version}: public npm latest is ${currentLatest}, which is not older than the candidate.`,
    );
  }
}

function assertExistingVersionTagState(currentLatest, version, packageName) {
  if (!currentLatest) {
    throw new Error(
      `${packageName}@${version} exists, but the latest dist-tag is missing. `
      + 'Trusted Publishing cannot repair dist-tags; reconcile latest manually.',
    );
  }
  if (compareSemver(parseSemver(currentLatest), parseSemver(version)) < 0) {
    throw new Error(
      `${packageName}@${version} exists, but latest still points to older ${currentLatest}. `
      + 'Trusted Publishing cannot repair dist-tags; reconcile latest manually.',
    );
  }
}

function parseSemver(value) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid semantic version ${String(value)}.`);
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) {
    throw new Error(`Invalid semantic version ${value}.`);
  }
  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => {
        if (/^\d+$/.test(identifier)) {
          if (identifier.length > 1 && identifier.startsWith('0')) {
            throw new Error(`Invalid semantic version ${value}: numeric prerelease identifiers cannot have leading zeroes.`);
          }
          return Number(identifier);
        }
        return identifier;
      })
    : [];
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemver(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) {
      return left[field] > right[field] ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    if (typeof leftPart === 'number' && typeof rightPart === 'string') {
      return -1;
    }
    if (typeof leftPart === 'string' && typeof rightPart === 'number') {
      return 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function createNpmClient(options = {}) {
  const packageDirectory = path.resolve(options.packageDirectory ?? DEFAULT_PACKAGE_DIRECTORY);
  const execute = options.execute ?? executeCommand;
  const packageLabel = options.packageLabel ?? 'TypeScript SDK';
  const smokeSource = options.smokeSource ?? ((name) =>
    `import * as sdk from ${JSON.stringify(name)};\n`
    + `if (typeof sdk.ModernEdiClient !== 'function') throw new Error('ModernEdiClient export is missing');\n`
    + `if (sdk.MODERNEDI_API_BASE_URL !== 'https://api.modernedi.com') throw new Error('API base URL export is invalid');\n`);
  const smokeDirectoryPrefix = options.smokeDirectoryPrefix ?? 'modernedi-sdk-install-smoke-';
  const registryArgs = ['--registry', DEFAULT_NPM_REGISTRY];

  const npmResult = async (args, commandOptions = {}) => execute(
    npmExecutable(),
    [...args, ...registryArgs],
    {
      cwd: commandOptions.cwd ?? packageDirectory,
      allowFailure: commandOptions.allowFailure,
      action: commandOptions.action,
    },
  );

  return {
    async verify() {
      await npmResult(['run', 'verify'], { action: `verify the ${packageLabel}` });
    },

    async pack(destination) {
      const result = await npmResult(
        ['pack', '--json', '--pack-destination', destination],
        { action: `pack the ${packageLabel}` },
      );
      const parsed = parseJsonOutput(result.stdout, 'npm pack');
      const entries = normalizePackResult(parsed);
      if (entries.length !== 1) {
        throw new Error('npm pack did not return exactly one packed package.');
      }
      const entry = entries[0];
      return {
        name: entry.name,
        version: entry.version,
        integrity: entry.integrity,
        shasum: entry.shasum,
        tarballPath: path.resolve(destination, entry.filename),
      };
    },

    async lookupVersion(name, version) {
      const result = await npmResult(
        ['view', `${name}@${version}`, 'dist.integrity', '--json'],
        { allowFailure: true, action: `inspect exact ${name}@${version}` },
      );
      if (result.status !== 0) {
        const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
        if (/\bE404\b|\b404\s+Not\s+Found\b/i.test(diagnostic)) {
          return undefined;
        }
        throw commandFailure(`inspect exact ${name}@${version}`, result);
      }
      const integrity = normalizeNpmViewResult(
        parseJsonOutput(result.stdout, 'npm view dist.integrity'),
        'npm view dist.integrity',
      );
      if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
        throw new Error(`npm returned invalid dist.integrity for ${name}@${version}.`);
      }
      return { integrity };
    },

    async publish(tarballPath) {
      await npmResult(
        ['publish', tarballPath, '--access', 'public', '--tag', RELEASE_TAG],
        { action: `publish the ${packageLabel} under ${RELEASE_TAG}` },
      );
    },

    async smokeInstallTarball(tarballPath, name, version) {
      await smokeInstall(tarballPath, name, version, 'local tarball');
    },

    async smokeInstallRegistry(name, version) {
      await smokeInstall(`${name}@${version}`, name, version, 'public npm');
    },

    async readDistTags(name) {
      const result = await npmResult(
        ['view', name, 'dist-tags', '--json'],
        { allowFailure: true, action: `inspect ${name} dist-tags` },
      );
      if (result.status !== 0) {
        const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
        if (/\bE404\b|\b404\s+Not\s+Found\b/i.test(diagnostic)) {
          return undefined;
        }
        throw commandFailure(`inspect ${name} dist-tags`, result);
      }
      const parsed = normalizeNpmViewResult(
        parseJsonOutput(result.stdout, 'npm view dist-tags'),
        'npm view dist-tags',
      );
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`npm returned invalid dist-tags for ${name}.`);
      }
      return parsed;
    },
  };

  async function smokeInstall(installSpec, name, version, source) {
    const smokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), smokeDirectoryPrefix));
    try {
      fs.writeFileSync(
        path.join(smokeDirectory, 'package.json'),
        `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(smokeDirectory, 'smoke.mjs'),
        smokeSource(name, version),
        'utf8',
      );
      await npmResult(
        [
          'install',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--save-exact',
          installSpec,
        ],
        { cwd: smokeDirectory, action: `install exact ${name}@${version} from ${source}` },
      );
      const installedManifest = JSON.parse(
        fs.readFileSync(path.join(smokeDirectory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
      );
      if (installedManifest.name !== name || installedManifest.version !== version) {
        throw new Error(
          `Installed ${String(installedManifest.name)}@${String(installedManifest.version)} instead of ${name}@${version}.`,
        );
      }
      await execute(process.execPath, ['smoke.mjs'], {
        cwd: smokeDirectory,
        action: `import exact ${name}@${version}`,
      });
    } finally {
      fs.rmSync(smokeDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

function executeCommand(command, args, options = {}) {
  const invocation = nativeCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  if (result.error) {
    throw new Error(`Could not ${options.action ?? 'run npm'}: ${safeMessage(result.error)}`);
  }
  if (!options.allowFailure && result.status !== 0) {
    throw commandFailure(options.action ?? 'run npm', result);
  }
  return result;
}

function nativeCommandInvocation(command, args) {
  if (process.platform !== 'win32' || command.toLowerCase() !== 'npm.cmd') {
    return { command, args };
  }
  return {
    command: process.execPath,
    args: [resolveWindowsNpmCli(), ...args],
  };
}

function resolveWindowsNpmCli() {
  const bundledNpmDirectory = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  const candidates = [];
  const prefixScript = path.join(bundledNpmDirectory, 'bin', 'npm-prefix.js');
  if (fs.existsSync(prefixScript)) {
    const prefix = spawnSync(process.execPath, [prefixScript], {
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: false,
    });
    if (!prefix.error && prefix.status === 0 && prefix.stdout.trim().length > 0) {
      candidates.push(path.join(prefix.stdout.trim(), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  if (typeof process.env.npm_execpath === 'string' && process.env.npm_execpath.length > 0) {
    candidates.push(process.env.npm_execpath);
  }
  candidates.push(path.join(bundledNpmDirectory, 'bin', 'npm-cli.js'));
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) {
    throw new Error('Could not locate npm-cli.js for native npm execution on Windows.');
  }
  return npmCli;
}

function commandFailure(action, result) {
  const diagnostic = redactSecrets(`${result.stderr ?? ''}\n${result.stdout ?? ''}`).trim();
  return new Error(`Could not ${action}: ${diagnostic || `command exited with status ${String(result.status)}`}`);
}

function parseJsonOutput(output, action) {
  try {
    return JSON.parse(String(output).trim());
  } catch (error) {
    throw new Error(`${action} returned malformed JSON: ${safeMessage(error)}`);
  }
}

function normalizePackResult(parsed) {
  if (Array.isArray(parsed)) {
    for (const metadata of parsed) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('npm pack returned non-object package metadata.');
      }
    }
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const entries = Object.entries(parsed);
  for (const [packageName, metadata] of entries) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('npm pack returned non-object package metadata.');
    }
    if (metadata.name !== packageName) {
      throw new Error('npm pack returned keyed package metadata whose key did not match its package name.');
    }
  }
  return entries.map(([, metadata]) => metadata);
}

function normalizeNpmViewResult(parsed, action) {
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed.length !== 1) {
    throw new Error(`${action} did not return exactly one result.`);
  }
  return parsed[0];
}

function makeTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'modernedi-npm-release-'));
}

function removeTemporaryDirectory(directory, fileSystem = fs, logger = defaultLogger) {
  try {
    fileSystem.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    logger(`Warning: could not remove temporary npm release directory: ${safeMessage(error)}`);
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function redactSecrets(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:npm_[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(?<=Bearer\s+)[^\s]+/gi, '[redacted]')
    .replace(/((?:NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|_auth|_password|npm_session|connect\.sid|session(?:id)?|sid|access_token|id_token|refresh_token|token|cookie)\s*["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/(\/\/[A-Za-z0-9_.:/-]+\/:_authToken=)[^\s]+/gi, '$1[redacted]');
}

function safeMessage(error) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function defaultLogger(message) {
  process.stdout.write(`[release:npm] ${redactSecrets(message)}\n`);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


export { assertPackageLock, assertPackedPackage, compareSemver, createNpmClient, parseArgs, parseSemver, redactSecrets, releaseNpmPackage, verifyDeployedOpenApi };
