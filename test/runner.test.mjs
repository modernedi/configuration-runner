import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configurationApplyResultArtifact,
  configurationPlanArtifact,
  readConfigurationApplyResultArtifact,
  writeArtifact,
} from "../dist/artifacts.js";
import {
  applyReviewedConfiguration,
  waitForConfigurationApply,
  verifyReviewedConfiguration,
} from "../dist/runner.js";

const DESIRED_SHA = "a".repeat(64);
const PLAN_SHA = "b".repeat(64);
const CURRENT_ETAG = `"${"c".repeat(64)}"`;
const APPLIED_ETAG = `"${"d".repeat(64)}"`;
const RESOURCE_SHA = "e".repeat(64);
const MAPPING_KEY = "8ccf76f0-2701-4d4c-a5c4-94a453feec81";
const OPERATION_ID = "apply-3ee360bd-7e41-4c55-80f8-3f1e5839804d";

function planResponse() {
  return {
    success: true,
    applicable: true,
    desiredBundleSha256: DESIRED_SHA,
    currentSnapshotEtag: CURRENT_ETAG,
    runtimeConfigurationRevision: 7,
    validationContext: {
      syntaxTreeCatalogRevision: "catalog-4",
      syntaxTreeCatalogManifestSha256: "f".repeat(64),
    },
    planSha256: PLAN_SHA,
    summary: { create: 1, update: 0, _delete: 0, unchanged: 2 },
    operations: [{
      action: "CREATE",
      kind: "Mapping",
      key: MAPPING_KEY,
      path: `mappings/${MAPPING_KEY}/mapping.json`,
      desired: { contentSha256: RESOURCE_SHA },
    }],
    diagnostics: [{
      severity: "WARNING",
      code: "review_this",
      message: "Review this operation.",
      pointer: "/files/1",
    }],
    scenarioImpactComplete: true,
    affectedScenarios: [],
    affectedRuns: [],
  };
}

function applyResponse(status) {
  return {
    success: true,
    operation: {
      operationId: OPERATION_ID,
      status,
      desiredBundleSha256: DESIRED_SHA,
      planSha256: PLAN_SHA,
      baseSnapshotEtag: CURRENT_ETAG,
      appliedSnapshotEtag: APPLIED_ETAG,
      runtimeConfigurationRevision: 8,
      summary: { create: 1, update: 0, _delete: 0, unchanged: 2 },
      operations: planResponse().operations,
      runtimePublication: {
        state: status === "SUCCEEDED" ? "published" : "pending",
        retrying: status === "PENDING",
      },
      requestedAt: "2026-09-01T08:00:00Z",
      committedAt: "2026-09-01T08:00:01Z",
      completedAt: status === "SUCCEEDED" ? "2026-09-01T08:00:03Z" : null,
    },
  };
}

function request() {
  return {
    files: [{
      path: "modernedi.json",
      role: "MANIFEST",
      format: "JSON",
      mediaType: "application/json",
      contentSha256: DESIRED_SHA,
      content: { apiVersion: "modernedi.com/v1", kind: "IntegrationConfiguration" },
    }],
  };
}

const VERIFICATION_REQUEST_ID = "6c3f1cc0-5957-4828-9b91-4c24ea515f5c";
function verificationResponse(overrides = {}) {
  return { success: true, run: { runId: `verify-${VERIFICATION_REQUEST_ID}`, status: "PASSED", freshness: "CURRENT",
    identity: { planSha256: PLAN_SHA, desiredBundleSha256: DESIRED_SHA, baseSnapshotEtag: CURRENT_ETAG }, ...overrides } };
}

test("optional verification re-plans and sends the exact reviewed request without applying", async () => {
  const calls = [];
  const desired = { ...request(), refreshScenarioBindings: [MAPPING_KEY] };
  const report = verificationResponse();
  const client = { configurationAsCode: {
    planIntegrationConfiguration: async () => planResponse(),
    verifyIntegrationConfiguration: async input => { calls.push(input); return report; },
    applyIntegrationConfigurationRaw: async () => { throw new Error("Verification must never apply"); },
  } };
  assert.deepEqual(await verifyReviewedConfiguration({ client, request: desired,
    reviewedPlan: configurationPlanArtifact(planResponse()), requestId: VERIFICATION_REQUEST_ID }), report);
  assert.deepEqual(calls, [{ configurationVerificationRequest: { ...desired, requestId: VERIFICATION_REQUEST_ID, planSha256: PLAN_SHA } }]);
});

test("verification rejects reviewed-plan drift before execution and mismatched server identities", async () => {
  const options = { request: request(), reviewedPlan: configurationPlanArtifact(planResponse()), requestId: VERIFICATION_REQUEST_ID };
  let calls = 0;
  const client = { configurationAsCode: {
    planIntegrationConfiguration: async () => ({ ...planResponse(), planSha256: "f".repeat(64) }),
    verifyIntegrationConfiguration: async () => { calls++; return verificationResponse(); },
  } };
  await assert.rejects(verifyReviewedConfiguration({ ...options, client }), error => error.code === "REVIEWED_PLAN_MISMATCH");
  assert.equal(calls, 0);
  client.configurationAsCode.planIntegrationConfiguration = async () => planResponse();
  client.configurationAsCode.verifyIntegrationConfiguration = async () => verificationResponse({ runId: "wrong-run" });
  await assert.rejects(verifyReviewedConfiguration({ ...options, client }), error => error.code === "VERIFICATION_IDENTITY_MISMATCH");
});

test("explicit verification selection and scenario refresh intent reach server-side apply", async () => {
  const id = `verify-${VERIFICATION_REQUEST_ID}`;
  const calls = [];
  const desired = { ...request(), refreshScenarioBindings: [MAPPING_KEY] };
  const client = { configurationAsCode: {
    planIntegrationConfiguration: async () => planResponse(),
    applyIntegrationConfigurationRaw: async input => { calls.push(input); return rawResponse(applyResponse("SUCCEEDED")); },
  } };
  await applyReviewedConfiguration({ client, request: desired, reviewedPlan: configurationPlanArtifact(planResponse()),
    idempotencyKey: "optional-evidence", verificationRunId: id });
  assert.equal(calls[0].configurationApplyRequest.verificationRunId, id);
  assert.deepEqual(calls[0].configurationApplyRequest.refreshScenarioBindings, [MAPPING_KEY]);
  await assert.rejects(applyReviewedConfiguration({ client, request: desired, reviewedPlan: configurationPlanArtifact(planResponse()),
    idempotencyKey: "optional-evidence", verificationRunId: "not-a-run" }), error => error.code === "VERIFICATION_RUN_ID_INVALID");
  assert.equal(calls.length, 1);
});

function rawResponse(value, headers = {}) {
  return {
    raw: new Response(null, { status: 202, headers }),
    value: async () => value,
  };
}

test("protected apply re-plans, uses exact guards, persists PENDING, and reaches SUCCEEDED", async () => {
  const planned = planResponse();
  const reviewed = configurationPlanArtifact(planned);
  assert.deepEqual(reviewed.plan.summary, {
    create: 1,
    update: 0,
    delete: 0,
    unchanged: 2,
  });
  const desired = request();
  const applyCalls = [];
  const observed = [];
  let now = 0;
  const client = {
    configurationAsCode: {
      planIntegrationConfiguration: async () => planned,
      applyIntegrationConfigurationRaw: async (input) => {
        applyCalls.push(input);
        return rawResponse(applyResponse("PENDING"), {
          "Idempotency-Replayed": "true",
          "Retry-After": "0.001",
        });
      },
      getIntegrationConfigurationApplyOperation: async ({ operationId }) => {
        assert.equal(operationId, OPERATION_ID);
        return applyResponse("SUCCEEDED");
      },
    },
  };

  const result = await applyReviewedConfiguration({
    client,
    request: desired,
    reviewedPlan: reviewed,
    idempotencyKey: "production:configuration:build-1842",
    appUrl: "https://staging.example.test/workspace?old=1#old",
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    onResult: async (artifact) => { observed.push(artifact.operation.status); },
  });

  assert.deepEqual(observed, ["PENDING", "SUCCEEDED"]);
  assert.equal(applyCalls.length, 1);
  assert.equal(applyCalls[0].idempotencyKey, "production:configuration:build-1842");
  assert.equal(applyCalls[0].ifMatch, CURRENT_ETAG);
  assert.equal(applyCalls[0].configurationApplyRequest.planSha256, PLAN_SHA);
  assert.strictEqual(applyCalls[0].configurationApplyRequest.files, desired.files);
  assert.equal(result.operation.status, "SUCCEEDED");
  assert.deepEqual(result.operation.summary, {
    create: 1,
    update: 0,
    delete: 0,
    unchanged: 2,
  });
  assert.equal(result.idempotencyReplayed, true);
  assert.equal(
    result.workspaceUrl,
    `https://staging.example.test/workspace?configurationApplyOperationId=${OPERATION_ID}#configuration-deployments-panel`,
  );
});

test("tampered embedded plan cannot authorize apply even when top hashes are unchanged", async () => {
  const planned = planResponse();
  const reviewed = configurationPlanArtifact(planned);
  reviewed.plan.operations[0].path = "mappings/tampered/mapping.json";
  let applyCalls = 0;
  const client = {
    configurationAsCode: {
      planIntegrationConfiguration: async () => planned,
      applyIntegrationConfigurationRaw: async () => {
        applyCalls += 1;
        throw new Error("must not apply");
      },
      getIntegrationConfigurationApplyOperation: async () => applyResponse("SUCCEEDED"),
    },
  };

  await assert.rejects(
    applyReviewedConfiguration({
      client,
      request: request(),
      reviewedPlan: reviewed,
      idempotencyKey: "build-1842",
    }),
    (error) => error?.code === "REVIEWED_PLAN_CONTENT_MISMATCH",
  );
  assert.equal(applyCalls, 0);
});

test("rejects surrounding whitespace in a caller-supplied idempotency key before re-plan", async () => {
  let planCalls = 0;
  const client = {
    configurationAsCode: {
      planIntegrationConfiguration: async () => {
        planCalls += 1;
        return planResponse();
      },
      applyIntegrationConfigurationRaw: async () => rawResponse(applyResponse("SUCCEEDED")),
      getIntegrationConfigurationApplyOperation: async () => applyResponse("SUCCEEDED"),
    },
  };

  await assert.rejects(
    applyReviewedConfiguration({
      client,
      request: request(),
      reviewedPlan: configurationPlanArtifact(planResponse()),
      idempotencyKey: " build-1842 ",
    }),
    (error) => error?.code === "IDEMPOTENCY_KEY_INVALID",
  );
  assert.equal(planCalls, 0);
});

test("timeout leaves a PENDING artifact that wait resumes and updates to SUCCEEDED", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "modernedi-runner-result-"));
  const resultPath = path.join(temporary, "result.json");
  try {
    const planned = planResponse();
    let now = 0;
    const applyingClient = {
      configurationAsCode: {
        planIntegrationConfiguration: async () => planned,
        applyIntegrationConfigurationRaw: async () => rawResponse(applyResponse("PENDING"), {
          "Retry-After": "0.001",
        }),
        getIntegrationConfigurationApplyOperation: async () => applyResponse("PENDING"),
      },
    };
    await assert.rejects(
      applyReviewedConfiguration({
        client: applyingClient,
        request: request(),
        reviewedPlan: configurationPlanArtifact(planned),
        idempotencyKey: "build-1842",
        timeoutMs: 1,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
        onResult: (artifact) => writeArtifact(resultPath, artifact),
      }),
      (error) => error?.code === "APPLY_POLL_TIMEOUT",
    );

    const pending = await readConfigurationApplyResultArtifact(resultPath);
    assert.equal(pending.operation.status, "PENDING");
    assert.match(pending.workspaceUrl, /configurationApplyOperationId=apply-/u);

    const waitingClient = {
      configurationAsCode: {
        planIntegrationConfiguration: async () => { throw new Error("not used"); },
        applyIntegrationConfigurationRaw: async () => { throw new Error("not used"); },
        getIntegrationConfigurationApplyOperation: async ({ operationId }) => {
          assert.equal(operationId, OPERATION_ID);
          return applyResponse("SUCCEEDED");
        },
      },
    };
    const succeeded = await waitForConfigurationApply({
      client: waitingClient,
      result: pending,
      onResult: (artifact) => writeArtifact(resultPath, artifact),
    });
    assert.equal(succeeded.operation.status, "SUCCEEDED");
    assert.equal(
      (await readConfigurationApplyResultArtifact(resultPath)).operation.status,
      "SUCCEEDED",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("wait authenticates a stored SUCCEEDED result before reporting success", async () => {
  const reviewed = configurationPlanArtifact(planResponse());
  const stored = configurationApplyResultArtifact(
    reviewed,
    applyResponse("SUCCEEDED"),
    false,
  );
  let getCalls = 0;
  const client = {
    configurationAsCode: {
      planIntegrationConfiguration: async () => { throw new Error("not used"); },
      applyIntegrationConfigurationRaw: async () => { throw new Error("not used"); },
      getIntegrationConfigurationApplyOperation: async ({ operationId }) => {
        getCalls += 1;
        assert.equal(operationId, OPERATION_ID);
        return applyResponse("SUCCEEDED");
      },
    },
  };

  const result = await waitForConfigurationApply({ client, result: stored });

  assert.equal(getCalls, 1);
  assert.equal(result.operation.status, "SUCCEEDED");
});
