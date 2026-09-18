import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfigurationBundleDirectory } from "../dist/bundle-directory.js";
import { ConfigurationPlanRequestToJSON, ConfigurationVerificationRequestToJSON, ConfigurationApplyRequestToJSON } from "@modernedi/sdk";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";

const fixture = path.resolve("test/fixtures/minimal");

test("public certificate files survive SDK round trips and checksum derivation without permitting private keys", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-certificate-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const key = "00000000-0000-0000-0000-000000000011";
    const resourcePath = `as2-connections/${key}/connection.json`;
    const certPath = `as2-connections/${key}/certificates/production.pem`;
    const exported = JSON.parse(await readFile(path.resolve("test/fixtures/integration-api/examples/configuration-export-response.json"), "utf8"));
    const connection = structuredClone(exported.files.find(file => file.role === "RESOURCE" && file.content.kind === "As2Connection").content);
    connection.metadata.key = key;
    delete connection.spec.environments.production.publicCertificatePem;
    Object.assign(connection.spec.environments.production, { publicCertificatePath: "./certificates/production.pem", publicCertificateSha256: "outdated" });
    const pem = await readFile(path.resolve("test/fixtures/certificates/example-a.pem"), "utf8");
    await mkdir(path.dirname(path.join(temporary, certPath)), { recursive: true });
    await writeFile(path.join(temporary, certPath), pem.replace(/\r?\n/g, "\r\n"));
    await writeFile(path.join(temporary, resourcePath), JSON.stringify(connection));
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.resources.push({ kind: "As2Connection", key, path: resourcePath });
    manifest.files.push({ path: resourcePath }, { path: certPath });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const loaded = await loadConfigurationBundleDirectory(temporary);
    const certificate = loaded.request.files.find(file => file.path === certPath);
    assert.equal(certificate.role, "CERTIFICATE");
    assert.equal(certificate.content.includes("\r"), false);
    assert.equal(loaded.request.files.find(file => file.path === resourcePath).content.spec.environments.production.publicCertificateSha256, certificate.contentSha256);
    for (const serialize of [ConfigurationPlanRequestToJSON, ConfigurationVerificationRequestToJSON, ConfigurationApplyRequestToJSON]) {
      const wire = JSON.parse(JSON.stringify(serialize({ ...loaded.request, planSha256: "a".repeat(64), requestId: "00000000-0000-4000-8000-000000000011" })));
      for (const file of wire.files) assert.equal(file.contentSha256, sha256(file.format === "JSON" ? canonicalJson(file.content) : file.content), file.path);
    }
    connection.spec.environments.production.publicCertificatePath = "../other.pem";
    await writeFile(path.join(temporary, resourcePath), JSON.stringify(connection));
    await assert.rejects(loadConfigurationBundleDirectory(temporary), /Invalid production certificate reference/);
    await writeFile(path.join(temporary, certPath), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
    await assert.rejects(loadConfigurationBundleDirectory(temporary), /exactly one public X.509/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("bundle hashes and optional X12 cases survive real SDK serialization for plan, verify and apply", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-wire-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const mappingPath = path.join(temporary, "mappings/8ccf76f0-2701-4d4c-a5c4-94a453feec81/mapping.json");
    const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
    mapping.spec.output = { contentType: "application/json", purpose: "PROCESSING", delivery: "MAPPED_OUTPUTS" };
    mapping.spec.direction = "OUTGOING";
    mapping.spec.regressionCases = [undefined, false, true].map((validateX12, index) => ({
      id: `case-${index}`, name: `Generated document ${index}`, comparison: "EXACT_TEXT",
      input: "{}", contentType: "application/json", params: null,
      functionalGroupIndex: null, transactionIndex: null, expectedOutput: "BEG*00*NE*PO-1**20260913~\n",
      ...(validateX12 === undefined ? {} : { validateX12 }),
    }));
    await writeFile(mappingPath, JSON.stringify(mapping));
    const { request } = await loadConfigurationBundleDirectory(temporary);
    for (const serialize of [ConfigurationPlanRequestToJSON, ConfigurationVerificationRequestToJSON, ConfigurationApplyRequestToJSON]) {
      const wire = JSON.parse(JSON.stringify(serialize({ ...request, planSha256: "a".repeat(64),
        requestId: "11111111-1111-4111-8111-111111111111" })));
      for (const file of wire.files) {
        assert.equal(file.contentSha256, sha256(file.format === "JSON" ? canonicalJson(file.content) : file.content), file.path);
      }
      assert.deepEqual(wire.files.find(file => file.role === "RESOURCE").content.spec.output, mapping.spec.output);
      assert.deepEqual(wire.files.find(file => file.role === "RESOURCE").content.spec.regressionCases, mapping.spec.regressionCases);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("one shared certificate derives both environment hashes and survives plan, verify and apply serialization", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-shared-certificate-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const key = "00000000-0000-0000-0000-000000000011";
    const resourcePath = `as2-connections/${key}/connection.json`;
    const certPath = `as2-connections/${key}/certificates/shared.pem`;
    const exported = JSON.parse(await readFile(path.resolve("test/fixtures/integration-api/examples/configuration-export-response.json"), "utf8"));
    const connection = structuredClone(exported.files.find(file => file.content?.kind === "As2Connection").content);
    connection.metadata.key = key;
    delete connection.spec.environments.production.publicCertificatePem;
    Object.assign(connection.spec.environments.production, { publicCertificatePath: "./certificates/shared.pem", publicCertificateSha256: "stale" });
    connection.spec.environments.test = { ...connection.spec.environments.production, as2Identifier: "TEST" };
    await mkdir(path.dirname(path.join(temporary, certPath)), { recursive: true });
    await cp(path.resolve("test/fixtures/certificates/example-a.pem"), path.join(temporary, certPath));
    const documentBytes = JSON.stringify(connection);
    await writeFile(path.join(temporary, resourcePath), documentBytes);
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.resources.push({ kind: "As2Connection", key, path: resourcePath });
    manifest.files.push({ path: resourcePath }, { path: certPath });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await loadConfigurationBundleDirectory(temporary);
    const check = loaded => {
      assert.equal(loaded.request.files.filter(file => file.role === "CERTIFICATE").length, 1);
      const cert = loaded.request.files.find(file => file.path === certPath);
      for (const serialize of [ConfigurationPlanRequestToJSON, ConfigurationVerificationRequestToJSON, ConfigurationApplyRequestToJSON]) {
        const wire = JSON.parse(JSON.stringify(serialize({ ...loaded.request, planSha256: "a".repeat(64), requestId: "00000000-0000-4000-8000-000000000011" })));
        for (const file of wire.files) assert.equal(file.contentSha256, sha256(file.format === "JSON" ? canonicalJson(file.content) : file.content), file.path);
        for (const name of ["production", "test"]) {
          const environment = wire.files.find(file => file.path === resourcePath).content.spec.environments[name];
          assert.equal(environment.publicCertificatePath, "./certificates/shared.pem");
          assert.equal(environment.publicCertificateSha256, cert.contentSha256);
        }
      }
    };
    check(before);
    await cp(path.resolve("test/fixtures/certificates/example-b.pem"), path.join(temporary, certPath));
    const after = await loadConfigurationBundleDirectory(temporary);
    check(after);
    assert.notEqual(after.bundleSha256, before.bundleSha256);
    assert.notEqual(after.request.files.find(file => file.path === resourcePath).contentSha256, before.request.files.find(file => file.path === resourcePath).contentSha256);
    assert.equal(await readFile(path.join(temporary, resourcePath), "utf8"), documentBytes, "Derivation does not rewrite authored files");
    for (const unsafe of ["./certificates/../shared.pem", "./certificates/shared.pem\n", "./certificates/nested/shared.pem",
      "../../00000000-0000-0000-0000-000000000012/certificates/shared.pem", "https://example.com/shared.pem"]) {
      connection.spec.environments.test.publicCertificatePath = unsafe;
      await writeFile(path.join(temporary, resourcePath), JSON.stringify(connection));
      await assert.rejects(loadConfigurationBundleDirectory(temporary), /Invalid test certificate reference/);
    }
    connection.spec.environments.test.publicCertificatePath = "./certificates/missing.pem";
    await writeFile(path.join(temporary, resourcePath), JSON.stringify(connection));
    await assert.rejects(loadConfigurationBundleDirectory(temporary), /Missing public certificate/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("editable repositories carry definitions and portable bindings without source loss", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-scenarios-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const sources = [
      ["ScenarioDefinition", "scenario-definitions", "definition", "93c113e6-b147-45b5-b42e-f3ce7219c163"],
      ["ScenarioBinding", "scenario-bindings", "binding", "7516d12a-2637-4c8b-b9b4-b106360632df"],
    ];
    const expected = new Map();
    for (const [kind, directory, leaf, key] of sources) {
      const logicalPath = `${directory}/${key}/${leaf}.json`;
      const content = {
        apiVersion: "modernedi.com/v1", kind, metadata: { key },
        spec: { source: { apiVersion: "modernedi.com/v1", kind,
          metadata: { id: "conversation" }, spec: {
            actors: [{ actorId: "buyer", endpoint: { kind: "partner", partnerKey: "4475c516-212c-40d6-8815-5d9d38f1a940" } }],
            steps: [{ stepId: "order", target: { kind: "runtime-mapping", mappingKey: manifest.resources[0].key },
              factSources: [{ fact: "po", source: { kind: "x12-mapper-expression", expression: "ST->BEG(03)" } }] }],
          } } },
      };
      await mkdir(path.join(temporary, directory, key), { recursive: true });
      await writeFile(path.join(temporary, logicalPath), JSON.stringify(content, null, 2));
      manifest.resources.push({ kind, key, path: logicalPath });
      manifest.files.push({ path: logicalPath, role: "RESOURCE", format: "JSON", mediaType: "application/json" });
      expected.set(logicalPath, content);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    const loaded = await loadConfigurationBundleDirectory(temporary);
    for (const [logicalPath, content] of expected) {
      const actual = loaded.request.files.find((file) => file.path === logicalPath);
      assert.deepEqual(actual.content, content);
      assert.match(actual.contentSha256, /^[0-9a-f]{64}$/u);
      assert.equal(Object.hasOwn(actual.content.spec.source.spec.steps[0], "syntaxTree"), false);
    }
    const generatedManifest = loaded.request.files.find((file) => file.role === "MANIFEST").content;
    assert.equal(generatedManifest.resources.length, 3);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).resources[1].contentSha256, undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("loads only manifest-inventoried files in deterministic path order", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-bundle-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    await writeFile(path.join(temporary, "not-uploaded.secret"), "ignore me", "utf8");

    const loaded = await loadConfigurationBundleDirectory(temporary);
    assert.match(loaded.bundleSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      loaded.request.files.map(({ path: logicalPath, role }) => [logicalPath, role]),
      [
        ["mappings/8ccf76f0-2701-4d4c-a5c4-94a453feec81/mapping.json", "RESOURCE"],
        ["mappings/8ccf76f0-2701-4d4c-a5c4-94a453feec81/source.x12mapper", "SOURCE"],
        ["modernedi.json", "MANIFEST"],
      ],
    );
    const source = loaded.request.files.find((file) => file.role === "SOURCE");
    assert.equal(source.content, await readFile(
      path.join(
        temporary,
        "mappings/8ccf76f0-2701-4d4c-a5c4-94a453feec81/source.x12mapper",
      ),
      "utf8",
    ));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("derives stale or omitted checksums from the editable directory without rewriting source files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-hash-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].contentSha256 = "0".repeat(64);
    delete manifest.resources[0].contentSha256;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const before = await readFile(manifestPath, "utf8");
    const loaded = await loadConfigurationBundleDirectory(temporary);
    const prepared = loaded.request.files.find((file) => file.role === "MANIFEST").content;
    const resource = loaded.request.files.find((file) => file.role === "RESOURCE");
    assert.equal(prepared.resources[0].contentSha256, resource.contentSha256);
    assert.equal(prepared.files.find((entry) => entry.path === resource.path).contentSha256, resource.contentSha256);
    assert.equal(await readFile(manifestPath, "utf8"), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("source edits rebuild mapping source, resource, and manifest hashes; formatting alone is a no-op", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-edit-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const before = await loadConfigurationBundleDirectory(temporary);
    for (const file of before.request.files.filter((file) => file.format === "JSON")) {
      await writeFile(path.join(temporary, file.path), JSON.stringify(file.content, null, 2) + "\r\n");
    }
    assert.equal((await loadConfigurationBundleDirectory(temporary)).bundleSha256, before.bundleSha256);
    const source = before.request.files.find((file) => file.role === "SOURCE");
    await writeFile(path.join(temporary, source.path), source.content + "\n");
    const edited = await loadConfigurationBundleDirectory(temporary);
    const editedSource = edited.request.files.find((file) => file.role === "SOURCE");
    const mapping = edited.request.files.find((file) => file.role === "RESOURCE");
    assert.notEqual(edited.bundleSha256, before.bundleSha256);
    assert.equal(mapping.content.spec.transform.sourceSha256, editedSource.contentSha256);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a missing inventoried resource still fails before contacting ModernEDI", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-missing-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files = manifest.files.filter((entry) => entry.path !== manifest.resources[0].path);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadConfigurationBundleDirectory(temporary),
      (error) => error?.code === "BUNDLE_RESOURCE_NOT_INVENTORIED");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("preserves a UTF-8 BOM in source content so local and server hashes agree", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-bom-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const sourceEntry = manifest.files.find((entry) => entry.path.endsWith(".x12mapper"));
    const sourcePath = path.join(temporary, ...sourceEntry.path.split("/"));
    const original = await readFile(sourcePath);
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]);
    sourceEntry.contentSha256 = createHash("sha256").update(withBom).digest("hex");
    await writeFile(sourcePath, withBom);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const loaded = await loadConfigurationBundleDirectory(temporary);
    const source = loaded.request.files.find((file) => file.role === "SOURCE");
    assert.equal(source.content.codePointAt(0), 0xfeff);
    assert.equal(
      createHash("sha256").update(source.content, "utf8").digest("hex"),
      sourceEntry.contentSha256,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects traversal in an inventoried logical path", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-path-"));
  try {
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = path.join(temporary, "modernedi.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].path = "../outside";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await assert.rejects(
      loadConfigurationBundleDirectory(temporary),
      (error) => error?.code === "BUNDLE_PATH_UNSAFE",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
