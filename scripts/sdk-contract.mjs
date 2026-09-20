// Capability floor, not the current release pin. The manifest owns the exact pin.
const MINIMUM_SDK_VERSION = '0.9.1';

export function assertSdkVersion(version) {
  const exact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
  if (typeof version !== 'string' || !exact.test(version)) {
    throw new Error('The runner must depend on an exact stable @modernedi/sdk version.');
  }
  const parts = version.split('.').map(BigInt);
  const minimum = MINIMUM_SDK_VERSION.split('.').map(BigInt);
  const difference = parts.map((part, index) => part - minimum[index]).find(part => part !== 0n) ?? 0n;
  if (difference < 0n) {
    throw new Error(`The runner requires @modernedi/sdk >= ${MINIMUM_SDK_VERSION} for its public contract and safe retries.`);
  }
  return version;
}
