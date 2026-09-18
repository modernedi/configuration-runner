import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ConfigurationApplyOperationResponseToJSON,
  ConfigurationPlanResponseToJSON,
  type ConfigurationApplyOperationResponse,
  type ConfigurationPlanResponse,
  type ConfigurationVerificationResponse,
} from "@modernedi/sdk";

import {
  deterministicJson,
  isJsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { runnerError } from "./errors.js";

export const RUNNER_ARTIFACT_API_VERSION =
  "modernedi.com/configuration-runner/v1";

export interface ConfigurationPlanArtifact {
  apiVersion: typeof RUNNER_ARTIFACT_API_VERSION;
  kind: "ConfigurationPlanArtifact";
  desiredBundleSha256: string;
  planSha256: string | null;
  plan: Record<string, JsonValue>;
}

export interface ConfigurationApplyResultArtifact {
  apiVersion: typeof RUNNER_ARTIFACT_API_VERSION;
  kind: "ConfigurationApplyResultArtifact";
  reviewed: {
    desiredBundleSha256: string;
    planSha256: string;
  };
  idempotencyReplayed: boolean | null;
  workspaceUrl: string;
  operation: Record<string, JsonValue>;
}

export function configurationPlanArtifact(
  plan: ConfigurationPlanResponse,
): ConfigurationPlanArtifact {
  const wirePlan = plainJsonObject(ConfigurationPlanResponseToJSON(plan));
  return {
    apiVersion: RUNNER_ARTIFACT_API_VERSION,
    kind: "ConfigurationPlanArtifact",
    desiredBundleSha256: plan.desiredBundleSha256,
    planSha256: plan.planSha256,
    plan: wirePlan,
  };
}

export function configurationApplyResultArtifact(
  reviewed: Pick<ConfigurationPlanArtifact, "desiredBundleSha256" | "planSha256">,
  result: ConfigurationApplyOperationResponse,
  idempotencyReplayed: boolean | null,
  appUrl = "https://app.modernedi.com/",
): ConfigurationApplyResultArtifact {
  if (reviewed.planSha256 === null) {
    throw runnerError(
      "REVIEWED_PLAN_NOT_APPLICABLE",
      "Reviewed plan artifact does not contain an applicable plan identity.",
      3,
    );
  }
  const wire = plainJsonObject(ConfigurationApplyOperationResponseToJSON(result));
  const operation = wire.operation;
  if (!isJsonObject(operation)) {
    throw runnerError(
      "APPLY_RESULT_INVALID",
      "ModernEDI returned an invalid configuration apply operation.",
    );
  }
  return {
    apiVersion: RUNNER_ARTIFACT_API_VERSION,
    kind: "ConfigurationApplyResultArtifact",
    reviewed: {
      desiredBundleSha256: reviewed.desiredBundleSha256,
      planSha256: reviewed.planSha256,
    },
    idempotencyReplayed,
    workspaceUrl: configurationOperationUrl(appUrl, String(operation.operationId)),
    operation,
  };
}

export async function readConfigurationApplyResultArtifact(
  artifactPath: string,
): Promise<ConfigurationApplyResultArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw runnerError(
      "APPLY_RESULT_UNREADABLE",
      `Apply result artifact could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      4,
    );
  }
  if (!isJsonObject(parsed)) {
    throw invalidApplyResult("artifact must be a JSON object");
  }
  assertExactKeys(parsed, [
    "apiVersion",
    "kind",
    "reviewed",
    "idempotencyReplayed",
    "workspaceUrl",
    "operation",
  ], invalidApplyResult);
  if (parsed.apiVersion !== RUNNER_ARTIFACT_API_VERSION
    || parsed.kind !== "ConfigurationApplyResultArtifact") {
    throw invalidApplyResult("artifact identity is unsupported");
  }
  if (!isJsonObject(parsed.reviewed)) {
    throw invalidApplyResult("reviewed must be an object");
  }
  assertExactKeys(
    parsed.reviewed,
    ["desiredBundleSha256", "planSha256"],
    invalidApplyResult,
  );
  const desiredBundleSha256 = requireSha256(
    parsed.reviewed.desiredBundleSha256,
    "reviewed.desiredBundleSha256",
    invalidApplyResult,
  );
  const planSha256 = requireSha256(
    parsed.reviewed.planSha256,
    "reviewed.planSha256",
    invalidApplyResult,
  );
  if (parsed.idempotencyReplayed !== null
    && typeof parsed.idempotencyReplayed !== "boolean") {
    throw invalidApplyResult("idempotencyReplayed must be boolean or null");
  }
  if (typeof parsed.workspaceUrl !== "string") {
    throw invalidApplyResult("workspaceUrl must be a string");
  }
  if (!isJsonObject(parsed.operation)) {
    throw invalidApplyResult("operation must be an object");
  }
  assertExactKeys(parsed.operation, [
    "operationId",
    "status",
    "desiredBundleSha256",
    "planSha256",
    "baseSnapshotEtag",
    "appliedSnapshotEtag",
    "runtimeConfigurationRevision",
    "summary",
    "operations",
    "runtimePublication",
    "requestedAt",
    "committedAt",
    "completedAt",
  ], invalidApplyResult);
  if (typeof parsed.operation.operationId !== "string"
    || !/^apply-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(parsed.operation.operationId)) {
    throw invalidApplyResult("operation.operationId is invalid");
  }
  if (parsed.operation.status !== "PENDING"
    && parsed.operation.status !== "SUCCEEDED") {
    throw invalidApplyResult("operation.status is unsupported");
  }
  if (parsed.operation.desiredBundleSha256 !== desiredBundleSha256
    || parsed.operation.planSha256 !== planSha256) {
    throw invalidApplyResult(
      "reviewed identities do not match the stored operation",
    );
  }
  return {
    apiVersion: RUNNER_ARTIFACT_API_VERSION,
    kind: "ConfigurationApplyResultArtifact",
    reviewed: { desiredBundleSha256, planSha256 },
    idempotencyReplayed: parsed.idempotencyReplayed,
    workspaceUrl: parsed.workspaceUrl,
    operation: parsed.operation,
  };
}

export async function readConfigurationPlanArtifact(
  artifactPath: string,
): Promise<ConfigurationPlanArtifact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw runnerError(
      "REVIEWED_PLAN_UNREADABLE",
      `Reviewed plan artifact could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      3,
    );
  }
  if (!isJsonObject(parsed)) {
    throw invalidReviewedPlan("artifact must be a JSON object");
  }
  assertExactKeys(
    parsed,
    ["apiVersion", "kind", "desiredBundleSha256", "planSha256", "plan"],
  );
  if (parsed.apiVersion !== RUNNER_ARTIFACT_API_VERSION
    || parsed.kind !== "ConfigurationPlanArtifact") {
    throw invalidReviewedPlan("artifact identity is unsupported");
  }
  const desiredBundleSha256 = requireSha256(
    parsed.desiredBundleSha256,
    "desiredBundleSha256",
  );
  const planSha256 = requireNullableSha256(parsed.planSha256, "planSha256");
  if (!isJsonObject(parsed.plan)) {
    throw invalidReviewedPlan("plan must be an object");
  }
  if (parsed.plan.desiredBundleSha256 !== desiredBundleSha256
    || parsed.plan.planSha256 !== planSha256) {
    throw invalidReviewedPlan(
      "top-level reviewed identities do not match the embedded plan",
    );
  }
  if (typeof parsed.plan.applicable !== "boolean") {
    throw invalidReviewedPlan("embedded plan applicable must be a boolean");
  }
  if (parsed.plan.applicable !== (planSha256 !== null)) {
    throw invalidReviewedPlan(
      "embedded plan applicability does not match planSha256",
    );
  }
  return {
    apiVersion: RUNNER_ARTIFACT_API_VERSION,
    kind: "ConfigurationPlanArtifact",
    desiredBundleSha256,
    planSha256,
    plan: parsed.plan,
  };
}

export async function writeArtifact(
  artifactPath: string,
  artifact: ConfigurationPlanArtifact | ConfigurationApplyResultArtifact | ConfigurationVerificationResponse,
): Promise<void> {
  const target = path.resolve(artifactPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporary, deterministicJson(artifact as unknown as JsonValue), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function plainJsonObject(value: unknown): Record<string, JsonValue> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(parsed)) {
    throw runnerError(
      "ARTIFACT_SERIALIZATION_INVALID",
      "SDK response could not be represented as a JSON object.",
    );
  }
  return parsed;
}

function assertExactKeys(
  value: Record<string, JsonValue>,
  expected: readonly string[],
  invalid = invalidReviewedPlan,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(
      `artifact fields must be exactly ${wanted.join(", ")}`,
    );
  }
}

function requireSha256(
  value: JsonValue | undefined,
  field: string,
  invalid = invalidReviewedPlan,
): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`${field} must be lowercase SHA-256`);
  }
  return value;
}

function requireNullableSha256(
  value: JsonValue | undefined,
  field: string,
): string | null {
  if (value === null) {
    return null;
  }
  return requireSha256(value, field);
}

function invalidReviewedPlan(detail: string) {
  return runnerError(
    "REVIEWED_PLAN_INVALID",
    `Reviewed plan artifact is invalid: ${detail}.`,
    3,
  );
}

function invalidApplyResult(detail: string) {
  return runnerError(
    "APPLY_RESULT_INVALID",
    `Apply result artifact is invalid: ${detail}.`,
    4,
  );
}

function configurationOperationUrl(appUrl: string, operationId: string): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw runnerError(
      "APP_URL_INVALID",
      "MODERNEDI_APP_URL must be an absolute HTTP or HTTPS URL.",
      64,
    );
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username || url.password) {
    throw runnerError(
      "APP_URL_INVALID",
      "MODERNEDI_APP_URL must be an absolute HTTP or HTTPS URL without credentials.",
      64,
    );
  }
  url.search = "";
  url.searchParams.set("configurationApplyOperationId", operationId);
  url.hash = "configuration-deployments-panel";
  return url.toString();
}
