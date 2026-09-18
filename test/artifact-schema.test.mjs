import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RUNNER_ARTIFACT_API_VERSION,
  configurationApplyResultArtifact,
  configurationPlanArtifact,
} from "../dist/artifacts.js";

const planSchemaPath = new URL(
  "../schemas/configuration-plan-artifact.schema.json",
  import.meta.url,
);
const resultSchemaPath = new URL(
  "../schemas/configuration-apply-result-artifact.schema.json",
  import.meta.url,
);

test("artifact schemas stay closed, version-aligned, and packaged", async () => {
  const [planSchema, resultSchema, packageJson] = await Promise.all([
    readJson(planSchemaPath),
    readJson(resultSchemaPath),
    readJson(new URL("../package.json", import.meta.url)),
  ]);

  assert.equal(planSchema.properties.apiVersion.const, RUNNER_ARTIFACT_API_VERSION);
  assert.equal(resultSchema.properties.apiVersion.const, RUNNER_ARTIFACT_API_VERSION);
  assert.equal(
    planSchema.$id,
    'https://www.modernedi.com/schemas/configuration-runner/v1/configuration-plan-artifact.schema.json',
  );
  assert.equal(
    resultSchema.$id,
    'https://www.modernedi.com/schemas/configuration-runner/v1/configuration-apply-result-artifact.schema.json',
  );
  assert.deepEqual(
    [...planSchema.required].sort(),
    Object.keys(planSchema.properties).sort(),
  );
  assert.deepEqual(
    [...resultSchema.required].sort(),
    Object.keys(resultSchema.properties).sort(),
  );
  assert.deepEqual(
    [...planSchema.$defs.plan.required].sort(),
    Object.keys(planSchema.$defs.plan.properties).sort(),
  );
  assert.deepEqual(
    [...resultSchema.$defs.applyOperation.required].sort(),
    Object.keys(resultSchema.$defs.applyOperation.properties).sort(),
  );
  assert.equal(packageJson.files.includes("schemas"), true);
  assertClosedObjectSchemas(planSchema, "plan schema");
  assertClosedObjectSchemas(resultSchema, "result schema");
  assert.equal(resultSchema.$defs.applyOperation.allOf.length, 2);
});

test("SDK-shaped emitted artifacts satisfy every required closed object surface", async () => {
  const [planSchema, resultSchema] = await Promise.all([
    readJson(planSchemaPath),
    readJson(resultSchemaPath),
  ]);
  const sdkPlan = sdkPlanResponse();
  const planArtifact = configurationPlanArtifact(sdkPlan);
  const resultArtifact = configurationApplyResultArtifact(
    planArtifact,
    sdkApplyResponse(sdkPlan),
    false,
  );

  assertObjectSurface(planArtifact, planSchema, "plan artifact");
  assertObjectSurface(planArtifact.plan, planSchema.$defs.plan, "embedded plan");
  assertObjectSurface(
    planArtifact.plan.validationContext,
    planSchema.$defs.validationContext,
    "validation context",
  );
  assertObjectSurface(planArtifact.plan.summary, planSchema.$defs.summary, "plan summary");
  assertObjectSurface(
    planArtifact.plan.operations[0],
    planSchema.$defs.operation,
    "plan operation",
  );
  assertObjectSurface(
    planArtifact.plan.operations[0].desired,
    planSchema.$defs.desiredValue,
    "desired operation value",
  );

  assertObjectSurface(resultArtifact, resultSchema, "result artifact");
  assertObjectSurface(
    resultArtifact.reviewed,
    resultSchema.properties.reviewed,
    "reviewed identities",
  );
  assertObjectSurface(
    resultArtifact.operation,
    resultSchema.$defs.applyOperation,
    "apply operation",
  );
  assertObjectSurface(
    resultArtifact.operation.summary,
    planSchema.$defs.summary,
    "apply summary",
  );
  assertObjectSurface(
    resultArtifact.operation.runtimePublication,
    resultSchema.$defs.runtimePublication,
    "runtime publication",
  );
  assert.equal(planArtifact.plan.summary.delete, 0);
  assert.equal(resultArtifact.operation.summary.delete, 0);
  assert.doesNotMatch(JSON.stringify([planArtifact, resultArtifact]), /"_delete"/u);
});

test("aggregate scenario artifacts preserve all resource kinds, authority fences, and revision-zero effects", async () => {
  const schema = await readJson(planSchemaPath);
  const kinds = ["As2Connection", "Partner", "Mapping", "ScenarioDefinition", "ScenarioBinding"];
  const effects = ["REAPPLY_REQUIRED", "REAPPLIED_BY_APPLY", "RETIRED_BY_APPLY"];
  const plan = sdkPlanResponse();
  plan.validationContext.scenarioAuthorityEtag = `"${"9".repeat(64)}"`;
  plan.operations = kinds.map((kind, index) => ({ ...plan.operations[0], kind,
    key: `00000000-0000-0000-0000-00000000000${index}`, path: `${kind}/source.json` }));
  plan.summary.create = kinds.length;
  const resources = [{ kind: "ScenarioBinding", key: plan.operations[4].key, action: "UPDATE" }];
  plan.affectedScenarios = effects.map((effect) => ({ bindingId: "warehouse", revision: 0,
    name: "Warehouse", environment: "test", definition: { namespace: "example", key: "warehouse", version: "1" },
    effect, resources }));
  plan.affectedRuns = [{ runId: "run-example", bindingId: "warehouse", bindingRevision: 0,
    effect: "CANCEL_OR_COMPLETE_REQUIRED", resources }];
  const artifact = configurationPlanArtifact(plan);
  const result = configurationApplyResultArtifact(artifact, sdkApplyResponse(plan), false);
  assert.deepEqual(schema.$defs.resourceKind.enum, kinds);
  assert.deepEqual(artifact.plan.operations.map(({ kind }) => kind), kinds);
  assert.deepEqual(result.operation.operations.map(({ kind }) => kind), kinds);
  assertObjectSurface(artifact.plan.validationContext, schema.$defs.validationContext, "scenario authority");
  assert.equal(artifact.plan.validationContext.scenarioAuthorityEtag, plan.validationContext.scenarioAuthorityEtag);
  assert.equal(schema.$defs.validationContext.properties.scenarioAuthorityEtag.$ref, "#/$defs/etag");
  assert.deepEqual(schema.$defs.affectedScenario.properties.effect.enum, effects);
  assert.deepEqual(artifact.plan.affectedScenarios, plan.affectedScenarios);
  assert.deepEqual(artifact.plan.affectedRuns, plan.affectedRuns);
  assert.equal(schema.$defs.affectedScenario.properties.revision.minimum, 0);
  assert.equal(schema.$defs.affectedRun.properties.bindingRevision.minimum, 0);
  for (const affected of artifact.plan.affectedScenarios) {
    assertObjectSurface(affected, schema.$defs.affectedScenario, "affected scenario");
  }
  assertObjectSurface(artifact.plan.affectedRuns[0], schema.$defs.affectedRun, "affected run");
});

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function assertClosedObjectSchemas(value, location) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjectSchemas(item, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (value.type === "object") {
    assert.equal(
      value.additionalProperties,
      false,
      `${location} must set additionalProperties:false`,
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertClosedObjectSchemas(child, `${location}.${key}`);
  }
}

function assertObjectSurface(value, schema, location) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${location} must be an object`);
  for (const field of schema.required ?? []) {
    assert.equal(Object.hasOwn(value, field), true, `${location} is missing required ${field}`);
  }
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      assert.equal(Object.hasOwn(schema.properties ?? {}, field), true, `${location} has undeclared ${field}`);
    }
  }
}

function sdkPlanResponse() {
  const desiredBundleSha256 = "a".repeat(64);
  const planSha256 = "b".repeat(64);
  return {
    success: true,
    applicable: true,
    desiredBundleSha256,
    currentSnapshotEtag: `"${"c".repeat(64)}"`,
    runtimeConfigurationRevision: 7,
    validationContext: {
      syntaxTreeCatalogRevision: "catalog-4",
      syntaxTreeCatalogManifestSha256: "d".repeat(64),
    },
    planSha256,
    summary: { create: 1, update: 0, _delete: 0, unchanged: 0 },
    operations: [{
      action: "CREATE",
      kind: "Partner",
      key: "00000000-0000-0000-0000-000000000007",
      path: "partners/example.json",
      desired: { contentSha256: "e".repeat(64) },
    }],
    diagnostics: [],
    scenarioImpactComplete: true,
    affectedScenarios: [],
    affectedRuns: [],
  };
}

function sdkApplyResponse(plan) {
  return {
    success: true,
    operation: {
      operationId: "apply-3ee360bd-7e41-4c55-80f8-3f1e5839804d",
      status: "SUCCEEDED",
      desiredBundleSha256: plan.desiredBundleSha256,
      planSha256: plan.planSha256,
      baseSnapshotEtag: plan.currentSnapshotEtag,
      appliedSnapshotEtag: `"${"f".repeat(64)}"`,
      runtimeConfigurationRevision: 8,
      summary: plan.summary,
      operations: plan.operations,
      runtimePublication: { state: "published", retrying: false },
      requestedAt: "2026-09-01T08:00:00Z",
      committedAt: "2026-09-01T08:00:01Z",
      completedAt: "2026-09-01T08:00:03Z",
    },
  };
}
