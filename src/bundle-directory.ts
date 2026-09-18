import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  ConfigurationDesiredFileFormatEnum,
  ConfigurationDesiredFileMediaTypeEnum,
  ConfigurationDesiredFileRoleEnum,
  type ConfigurationDesiredFile,
  type ConfigurationPlanRequest,
} from "@modernedi/sdk";

import {
  canonicalJson,
  isJsonObject,
  sha256,
  type JsonValue,
} from "./canonical-json.js";
import { runnerError } from "./errors.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8_EXACT_TEXT = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const CERTIFICATE_NAME = "[a-z0-9][a-z0-9_-]{0,63}\\.pem";
// Unlike $, the final assertion cannot match before a trailing newline.
const CERTIFICATE_PATH = new RegExp(`^as2-connections/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/certificates/${CERTIFICATE_NAME}(?![\\s\\S])`);
const CERTIFICATE_REFERENCE = new RegExp(`^\\./certificates/${CERTIFICATE_NAME}(?![\\s\\S])`);

interface ManifestFileEntry {
  path: string;
  document: Record<string, JsonValue>;
}

interface ManifestResourceEntry extends ManifestFileEntry {
  kind: string;
  key: string;
}

interface BundleManifest {
  document: Record<string, JsonValue>;
  files: ManifestFileEntry[];
  resources: ManifestResourceEntry[];
}

export interface LoadedConfigurationBundle {
  request: ConfigurationPlanRequest;
  bundleSha256: string;
}

export async function loadConfigurationBundleDirectory(
  bundleDirectory: string,
): Promise<LoadedConfigurationBundle> {
  const root = await resolveBundleRoot(bundleDirectory);
  const manifestBytes = await readContainedFile(root, "modernedi.json");
  const manifestDocument = parseJsonObject(manifestBytes, "modernedi.json");
  const manifest = parseManifest(manifestDocument);
  const files: ConfigurationDesiredFile[] = [];

  const resourcePaths = new Map<string, ManifestResourceEntry>();
  for (const resource of manifest.resources) {
    const folded = resource.path.toLowerCase();
    if (resourcePaths.has(folded)) {
      throw runnerError(
        "BUNDLE_DUPLICATE_RESOURCE_PATH",
        `Manifest resources contain duplicate path ${resource.path}.`,
        2,
      );
    }
    resourcePaths.set(folded, resource);
  }

  const exactPaths = new Set<string>(["modernedi.json"]);
  const foldedPaths = new Set<string>(["modernedi.json"]);
  for (const entry of [...manifest.files].sort((left, right) =>
    compareOrdinal(left.path, right.path))) {
    assertSafeLogicalPath(entry.path);
    const folded = entry.path.toLowerCase();
    if (exactPaths.has(entry.path) || foldedPaths.has(folded)) {
      throw runnerError(
        "BUNDLE_DUPLICATE_PATH",
        `Manifest files contain duplicate path ${entry.path}.`,
        2,
      );
    }
    exactPaths.add(entry.path);
    foldedPaths.add(folded);

    const bytes = await readContainedFile(root, entry.path);
    const resource = resourcePaths.get(folded);
    if (resource) {
      if (resource.path !== entry.path) {
        throw runnerError(
          "BUNDLE_PATH_CASE_MISMATCH",
          `Manifest resource path ${resource.path} does not exactly match file path ${entry.path}.`,
          2,
        );
      }
      const document = parseJsonObject(bytes, entry.path);
      const actualSha256 = sha256(canonicalJson(document));
      files.push(desiredJsonFile(
        entry.path,
        ConfigurationDesiredFileRoleEnum.Resource,
        document,
        actualSha256,
      ));
      continue;
    }

    const certificate = CERTIFICATE_PATH.test(entry.path);
    const content = certificate
      ? canonicalCertificate(decodeUtf8(bytes, entry.path, true), entry.path)
      : decodeUtf8(bytes, entry.path, true);
    const actualSha256 = sha256(content);
    files.push({
      path: entry.path,
      role: certificate ? ConfigurationDesiredFileRoleEnum.Certificate : ConfigurationDesiredFileRoleEnum.Source,
      format: ConfigurationDesiredFileFormatEnum.Text,
      mediaType: ConfigurationDesiredFileMediaTypeEnum.TextPlainCharsetutf8,
      contentSha256: actualSha256,
      content,
    });
  }

  for (const resource of manifest.resources) {
    if (!exactPaths.has(resource.path) || resource.path === "modernedi.json") {
      throw runnerError(
        "BUNDLE_RESOURCE_NOT_INVENTORIED",
        `Manifest resource ${resource.path} is missing from files.`,
        2,
      );
    }
  }

  // A directory is editable source, not an immutable reviewed wire bundle.
  // Hash exact source bytes first, then mapping documents, then the manifest.
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    if (file.role === ConfigurationDesiredFileRoleEnum.Resource
      && isJsonObject(file.content) && file.content.kind === "As2Connection") {
      const spec = file.content.spec;
      const environments = isJsonObject(spec) ? spec.environments : undefined;
      for (const name of ["production", "test"]) {
        const environment = isJsonObject(environments) ? environments[name] : undefined;
        if (!isJsonObject(environment) || typeof environment.publicCertificatePath !== "string") continue;
        if (!CERTIFICATE_REFERENCE.test(environment.publicCertificatePath) || "publicCertificatePem" in environment) {
          throw runnerError("BUNDLE_CERTIFICATE_REFERENCE_INVALID", `Invalid ${name} certificate reference in ${file.path}.`, 2);
        }
        const certificatePath = file.path.replace(/connection\.json$/, environment.publicCertificatePath.slice(2));
        const source = byPath.get(certificatePath);
        if (source?.role !== ConfigurationDesiredFileRoleEnum.Certificate) {
          throw runnerError("BUNDLE_CERTIFICATE_MISSING", `Missing public certificate ${certificatePath}.`, 2);
        }
        environment.publicCertificateSha256 = source.contentSha256;
      }
      file.contentSha256 = sha256(canonicalJson(file.content));
    }
    if (file.role !== ConfigurationDesiredFileRoleEnum.Resource
      || !isJsonObject(file.content) || file.content.kind !== "Mapping") {
      continue;
    }
    const spec = file.content.spec;
    const transform = isJsonObject(spec) ? spec.transform : undefined;
    if (isJsonObject(transform) && typeof transform.sourcePath === "string") {
      const source = byPath.get(transform.sourcePath);
      if (source?.role === ConfigurationDesiredFileRoleEnum.Source) {
        transform.sourceSha256 = source.contentSha256;
        file.contentSha256 = sha256(canonicalJson(file.content));
      }
    }
  }
  for (const entries of [manifest.files, manifest.resources]) {
    entries.sort((left, right) => compareOrdinal(left.path, right.path));
    for (const entry of entries) {
      entry.document.contentSha256 = byPath.get(entry.path)!.contentSha256;
    }
  }
  manifestDocument.files = manifest.files.map((entry) => entry.document);
  manifestDocument.resources = manifest.resources.map((entry) => entry.document);
  const bundleSha256 = sha256(canonicalJson(manifestDocument));
  files.push(desiredJsonFile(
    "modernedi.json", ConfigurationDesiredFileRoleEnum.Manifest, manifestDocument, bundleSha256,
  ));

  files.sort((left, right) => compareOrdinal(left.path, right.path));
  return { request: { files }, bundleSha256 };
}

function canonicalCertificate(content: string, logicalPath: string): string {
  try {
    const pem = content.trim();
    if (!/^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----$/.test(pem)) throw new Error();
    const certificate = new X509Certificate(pem);
    const encoded = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""), "base64");
    if (!encoded.equals(certificate.raw)) throw new Error();
    return `-----BEGIN CERTIFICATE-----\n${certificate.raw.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  } catch {
    throw runnerError("BUNDLE_CERTIFICATE_INVALID", `${logicalPath} must contain exactly one public X.509 PEM certificate, never a private key.`, 2);
  }
}

async function resolveBundleRoot(directory: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(path.resolve(directory));
  } catch {
    throw runnerError(
      "BUNDLE_DIRECTORY_NOT_FOUND",
      `Configuration bundle directory was not found: ${directory}.`,
      2,
    );
  }
  if (!(await stat(root)).isDirectory()) {
    throw runnerError(
      "BUNDLE_DIRECTORY_REQUIRED",
      `Configuration bundle path is not a directory: ${directory}.`,
      2,
    );
  }
  return root;
}

async function readContainedFile(root: string, logicalPath: string): Promise<Uint8Array> {
  assertSafeLogicalPath(logicalPath);
  const components = logicalPath.split("/");
  let candidate = root;
  for (const component of components) {
    candidate = path.join(candidate, component);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch {
      throw runnerError(
        "BUNDLE_FILE_NOT_FOUND",
        `Configuration bundle file was not found: ${logicalPath}.`,
        2,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw runnerError(
        "BUNDLE_SYMLINK_FORBIDDEN",
        `Configuration bundle paths may not traverse symbolic links: ${logicalPath}.`,
        2,
      );
    }
  }
  const resolved = await realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw runnerError(
      "BUNDLE_PATH_ESCAPE",
      `Configuration bundle path escapes its root: ${logicalPath}.`,
      2,
    );
  }
  if (!(await stat(resolved)).isFile()) {
    throw runnerError(
      "BUNDLE_FILE_REQUIRED",
      `Configuration bundle path is not a file: ${logicalPath}.`,
      2,
    );
  }
  return readFile(resolved);
}

function parseJsonObject(bytes: Uint8Array, logicalPath: string): Record<string, JsonValue> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, logicalPath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw runnerError(
        "BUNDLE_JSON_INVALID",
        `Configuration bundle file is not valid JSON: ${logicalPath}.`,
        2,
      );
    }
    throw error;
  }
  if (!isJsonObject(value)) {
    throw runnerError(
      "BUNDLE_JSON_OBJECT_REQUIRED",
      `Configuration JSON file must contain an object: ${logicalPath}.`,
      2,
    );
  }
  return value;
}

function decodeUtf8(
  bytes: Uint8Array,
  logicalPath: string,
  preserveBom = false,
): string {
  try {
    return (preserveBom ? UTF8_EXACT_TEXT : UTF8).decode(bytes);
  } catch {
    throw runnerError(
      "BUNDLE_UTF8_REQUIRED",
      `Configuration bundle file is not valid UTF-8: ${logicalPath}.`,
      2,
    );
  }
}

function parseManifest(document: Record<string, JsonValue>): BundleManifest {
  if (document.apiVersion !== "modernedi.com/v1"
    || document.kind !== "IntegrationConfiguration") {
    throw runnerError(
      "BUNDLE_MANIFEST_IDENTITY_INVALID",
      "modernedi.json must identify modernedi.com/v1 IntegrationConfiguration.",
      2,
    );
  }
  const files = parseManifestEntries(document.files, "files", false);
  const resources = parseManifestEntries(document.resources, "resources", true);
  return { document, files, resources };
}

function parseManifestEntries(
  value: JsonValue | undefined,
  field: string,
  resource: true,
): ManifestResourceEntry[];
function parseManifestEntries(
  value: JsonValue | undefined,
  field: string,
  resource: false,
): ManifestFileEntry[];
function parseManifestEntries(
  value: JsonValue | undefined,
  field: string,
  resource: boolean,
): Array<ManifestFileEntry | ManifestResourceEntry> {
  if (!Array.isArray(value)) {
    throw runnerError(
      "BUNDLE_MANIFEST_INVENTORY_INVALID",
      `modernedi.json ${field} must be an array.`,
      2,
    );
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw runnerError(
        "BUNDLE_MANIFEST_INVENTORY_INVALID",
        `modernedi.json ${field}[${index}] must be an object.`,
        2,
      );
    }
    const logicalPath = requiredString(item.path, `${field}[${index}].path`);
    assertSafeLogicalPath(logicalPath);
    if (!resource) {
      return { path: logicalPath, document: item };
    }
    return {
      path: logicalPath,
      document: item,
      kind: requiredString(item.kind, `${field}[${index}].kind`),
      key: requiredString(item.key, `${field}[${index}].key`),
    };
  });
}

function desiredJsonFile(
  logicalPath: string,
  role: "MANIFEST" | "RESOURCE",
  content: Record<string, JsonValue>,
  contentSha256: string,
): ConfigurationDesiredFile {
  return {
    path: logicalPath,
    role,
    format: ConfigurationDesiredFileFormatEnum.Json,
    mediaType: ConfigurationDesiredFileMediaTypeEnum.ApplicationJson,
    contentSha256,
    content: content as unknown as ConfigurationDesiredFile["content"],
  };
}

function assertSafeLogicalPath(logicalPath: string): void {
  const components = logicalPath.split("/");
  if (!logicalPath
    || logicalPath.startsWith("/")
    || logicalPath.includes("\\")
    || logicalPath.includes(":")
    || components.some((component) => !component || component === "." || component === "..")
    || logicalPath === "_state"
    || logicalPath.startsWith("_state/")) {
    throw runnerError(
      "BUNDLE_PATH_UNSAFE",
      `Configuration path is not a safe portable desired path: ${logicalPath || "<empty>"}.`,
      2,
    );
  }
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value) {
    throw runnerError(
      "BUNDLE_MANIFEST_FIELD_INVALID",
      `modernedi.json ${label} must be a non-empty string.`,
      2,
    );
  }
  return value;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
