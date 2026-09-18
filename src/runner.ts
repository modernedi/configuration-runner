import {
  ConfigurationPlanResponseToJSON,
  getModernEdiResponseMetadata,
  type ConfigurationApplyOperationResponse,
  type ConfigurationPlanRequest,
  type ConfigurationPlanResponse,
  type ConfigurationVerificationResponse,
  type ModernEdiClient,
} from "@modernedi/sdk";

import {
  configurationApplyResultArtifact,
  configurationPlanArtifact,
  type ConfigurationApplyResultArtifact,
  type ConfigurationPlanArtifact,
} from "./artifacts.js";
import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { runnerError } from "./errors.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_APPLY_TIMEOUT_MS = 15 * 60_000;

type ConfigurationAsCodeClient = Pick<
  ModernEdiClient["configurationAsCode"],
  | "applyIntegrationConfigurationRaw"
  | "getIntegrationConfigurationApplyOperation"
  | "planIntegrationConfiguration"
  | "verifyIntegrationConfiguration"
>;

export interface ConfigurationRunnerClient {
  configurationAsCode: ConfigurationAsCodeClient;
}

export interface ApplyReviewedOptions {
  client: ConfigurationRunnerClient;
  request: ConfigurationPlanRequest;
  reviewedPlan: ConfigurationPlanArtifact;
  idempotencyKey: string;
  verificationRunId?: string;
  timeoutMs?: number;
  appUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onResult?: (result: ConfigurationApplyResultArtifact) => Promise<void>;
}

export interface WaitForConfigurationApplyOptions {
  client: ConfigurationRunnerClient;
  result: ConfigurationApplyResultArtifact;
  timeoutMs?: number;
  appUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onResult?: (result: ConfigurationApplyResultArtifact) => Promise<void>;
}

export async function planConfiguration(
  client: ConfigurationRunnerClient,
  request: ConfigurationPlanRequest,
): Promise<ConfigurationPlanArtifact> {
  const plan = await currentPlan(client, request);
  return configurationPlanArtifact(plan);
}

export async function applyReviewedConfiguration(
  options: ApplyReviewedOptions,
): Promise<ConfigurationApplyResultArtifact> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw runnerError(
      "APPLY_TIMEOUT_INVALID",
      "Apply timeout must be a positive whole number of milliseconds.",
      64,
    );
  }
  assertIdempotencyKey(options.idempotencyKey);
  assertReviewedPlanApplicable(options.reviewedPlan);
  if (options.verificationRunId !== undefined && !/^verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.verificationRunId)) {
    throw runnerError("VERIFICATION_RUN_ID_INVALID", "verificationRunId must identify a server verification run.", 64);
  }

  const replanned = await currentPlan(options.client, options.request);
  assertReviewedPlanMatches(options.reviewedPlan, replanned);
  const submitted = await options.client.configurationAsCode
    .applyIntegrationConfigurationRaw({
      idempotencyKey: options.idempotencyKey,
      ifMatch: replanned.currentSnapshotEtag,
      configurationApplyRequest: {
        planSha256: replanned.planSha256 as string,
        files: options.request.files,
        refreshScenarioBindings: options.request.refreshScenarioBindings,
        verificationRunId: options.verificationRunId,
      },
    });
  const metadata = getModernEdiResponseMetadata(submitted.raw);
  let result = await submitted.value();
  assertOperationMatchesReviewedPlan(options.reviewedPlan, result);
  const submittedOperationId = result.operation.operationId;
  let artifact = configurationApplyResultArtifact(
    options.reviewedPlan,
    result,
    metadata.idempotencyReplayed ?? false,
    options.appUrl,
  );
  await options.onResult?.(artifact);
  result = await waitForApplyOperation(options.client, result, {
    timeoutMs,
    initialPollIntervalMs: retryAfterMilliseconds(metadata.retryAfter),
    now: options.now,
    sleep: options.sleep,
    onOperation: async (operation) => {
      assertOperationMatchesReviewedPlan(
        options.reviewedPlan,
        operation,
        submittedOperationId,
      );
      artifact = configurationApplyResultArtifact(
        options.reviewedPlan,
        operation,
        metadata.idempotencyReplayed ?? false,
        options.appUrl,
      );
      await options.onResult?.(artifact);
    },
  });
  return artifact;
}

export async function waitForConfigurationApply(
  options: WaitForConfigurationApplyOptions,
): Promise<ConfigurationApplyResultArtifact> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw runnerError(
      "APPLY_TIMEOUT_INVALID",
      "Apply timeout must be a positive whole number of milliseconds.",
      64,
    );
  }
  const operationId = requireStoredOperationString(
    options.result,
    "operationId",
  );
  const storedStatus = requireStoredOperationString(options.result, "status");
  if (storedStatus !== "PENDING" && storedStatus !== "SUCCEEDED") {
    throw runnerError(
      "APPLY_RESULT_STATUS_INVALID",
      `Stored configuration apply ${operationId} has unsupported status ${storedStatus}.`,
      4,
    );
  }

  let response = await options.client.configurationAsCode
    .getIntegrationConfigurationApplyOperation({ operationId });
  assertOperationMatchesStoredResult(options.result, response);
  let artifact = configurationApplyResultArtifact(
    options.result.reviewed,
    response,
    options.result.idempotencyReplayed,
    options.appUrl,
  );
  await options.onResult?.(artifact);
  response = await waitForApplyOperation(options.client, response, {
    timeoutMs,
    now: options.now,
    sleep: options.sleep,
    onOperation: async (operation) => {
      assertOperationMatchesStoredResult(options.result, operation);
      artifact = configurationApplyResultArtifact(
        options.result.reviewed,
        operation,
        options.result.idempotencyReplayed,
        options.appUrl,
      );
      await options.onResult?.(artifact);
    },
  });
  return artifact;
}

export async function verifyReviewedConfiguration(options: {
  client: ConfigurationRunnerClient;
  request: ConfigurationPlanRequest;
  reviewedPlan: ConfigurationPlanArtifact;
  requestId: string;
}): Promise<ConfigurationVerificationResponse> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.requestId)) {
    throw runnerError("VERIFICATION_REQUEST_ID_INVALID", "Persist a canonical UUID for this verification request and its retries.", 64);
  }
  assertReviewedPlanApplicable(options.reviewedPlan);
  const fresh = await currentPlan(options.client, options.request);
  assertReviewedPlanMatches(options.reviewedPlan, fresh);
  const response = await options.client.configurationAsCode.verifyIntegrationConfiguration({
    configurationVerificationRequest: {
      ...options.request,
      requestId: options.requestId,
      planSha256: fresh.planSha256 as string,
    },
  });
  const run = response.run;
  if (run.runId !== `verify-${options.requestId}`
      || run.identity.planSha256 !== options.reviewedPlan.planSha256
      || run.identity.desiredBundleSha256 !== options.reviewedPlan.desiredBundleSha256
      || run.identity.baseSnapshotEtag !== fresh.currentSnapshotEtag) {
    throw runnerError("VERIFICATION_IDENTITY_MISMATCH", "Server verification does not match the exact reviewed plan and request.", 3);
  }
  return response;
}

async function currentPlan(
  client: ConfigurationRunnerClient,
  request: ConfigurationPlanRequest,
): Promise<ConfigurationPlanResponse> {
  return client.configurationAsCode.planIntegrationConfiguration({
    configurationPlanRequest: request,
  });
}

interface WaitOptions {
  timeoutMs: number;
  initialPollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onOperation?: (
    operation: ConfigurationApplyOperationResponse,
  ) => Promise<void>;
}

async function waitForApplyOperation(
  client: ConfigurationRunnerClient,
  initial: ConfigurationApplyOperationResponse,
  options: WaitOptions,
): Promise<ConfigurationApplyOperationResponse> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  const pollIntervalMs = options.initialPollIntervalMs
    ?? DEFAULT_POLL_INTERVAL_MS;
  let current = initial;
  const operationId = initial.operation.operationId;

  while (current.operation.status === "PENDING") {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw runnerError(
        "APPLY_POLL_TIMEOUT",
        `Configuration apply ${current.operation.operationId} is still PENDING after ${options.timeoutMs} ms. The database change may already be committed; resume polling this operation instead of submitting another apply.`,
        4,
      );
    }
    await sleep(Math.min(pollIntervalMs, remaining));
    current = await client.configurationAsCode
      .getIntegrationConfigurationApplyOperation({
        operationId,
      });
    if (current.operation.operationId !== operationId) {
      throw runnerError(
        "APPLY_OPERATION_IDENTITY_MISMATCH",
        `ModernEDI returned operation ${current.operation.operationId} while polling ${operationId}.`,
        4,
      );
    }
    await options.onOperation?.(current);
  }

  if (current.operation.status !== "SUCCEEDED") {
    throw runnerError(
      "APPLY_STATUS_UNSUPPORTED",
      `Configuration apply ${current.operation.operationId} returned unsupported status ${current.operation.status}.`,
    );
  }
  return current;
}

function assertOperationMatchesReviewedPlan(
  reviewed: Pick<ConfigurationPlanArtifact, "desiredBundleSha256" | "planSha256">,
  current: ConfigurationApplyOperationResponse,
  operationId?: string,
): void {
  if ((operationId !== undefined && current.operation.operationId !== operationId)
    || current.operation.desiredBundleSha256 !== reviewed.desiredBundleSha256
    || current.operation.planSha256 !== reviewed.planSha256) {
    throw runnerError(
      "APPLY_OPERATION_IDENTITY_MISMATCH",
      "ModernEDI returned an apply operation that does not match the reviewed bundle and plan identities.",
      4,
    );
  }
}

function assertOperationMatchesStoredResult(
  stored: ConfigurationApplyResultArtifact,
  current: ConfigurationApplyOperationResponse,
): void {
  const operationId = requireStoredOperationString(stored, "operationId");
  if (current.operation.operationId !== operationId
    || current.operation.desiredBundleSha256
      !== stored.reviewed.desiredBundleSha256
    || current.operation.planSha256 !== stored.reviewed.planSha256) {
    throw runnerError(
      "APPLY_OPERATION_IDENTITY_MISMATCH",
      `ModernEDI returned an operation that does not match stored apply ${operationId}.`,
      4,
    );
  }
}

function requireStoredOperationString(
  stored: ConfigurationApplyResultArtifact,
  field: string,
): string {
  const value = stored.operation[field];
  if (typeof value !== "string" || !value) {
    throw runnerError(
      "APPLY_RESULT_INVALID",
      `Stored apply operation ${field} must be a non-empty string.`,
      4,
    );
  }
  return value;
}

function assertReviewedPlanApplicable(reviewed: ConfigurationPlanArtifact): void {
  if (reviewed.planSha256 === null
    || reviewed.plan.applicable !== true) {
    throw runnerError(
      "REVIEWED_PLAN_NOT_APPLICABLE",
      "Reviewed plan is not applicable and cannot authorize configuration changes.",
      3,
    );
  }
}

function assertReviewedPlanMatches(
  reviewed: ConfigurationPlanArtifact,
  current: ConfigurationPlanResponse,
): void {
  if (!current.applicable || current.planSha256 === null) {
    throw runnerError(
      "REVIEWED_PLAN_NO_LONGER_APPLICABLE",
      "Protected apply re-plan is not applicable. Review the new diagnostics; no apply was submitted.",
      3,
    );
  }
  if (current.desiredBundleSha256 !== reviewed.desiredBundleSha256) {
    throw runnerError(
      "REVIEWED_BUNDLE_MISMATCH",
      `Protected apply bundle ${current.desiredBundleSha256} does not match reviewed bundle ${reviewed.desiredBundleSha256}. No apply was submitted.`,
      3,
    );
  }
  if (current.planSha256 !== reviewed.planSha256) {
    throw runnerError(
      "REVIEWED_PLAN_MISMATCH",
      `Protected apply plan ${current.planSha256} does not match reviewed plan ${reviewed.planSha256}. Workspace state or validation context changed; review a fresh plan before applying.`,
      3,
    );
  }
  const currentWire = JSON.parse(
    JSON.stringify(ConfigurationPlanResponseToJSON(current)),
  ) as JsonValue;
  if (canonicalJson(currentWire) !== canonicalJson(reviewed.plan)) {
    throw runnerError(
      "REVIEWED_PLAN_CONTENT_MISMATCH",
      "Fresh protected apply plan does not exactly match the complete reviewed plan artifact. No apply was submitted.",
      3,
    );
  }
}

function assertIdempotencyKey(value: string): void {
  if (!value.trim()
    || value !== value.trim()
    || value.length > 200
    || /[\r\n]/u.test(value)) {
    throw runnerError(
      "IDEMPOTENCY_KEY_INVALID",
      "MODERNEDI_IDEMPOTENCY_KEY must be a persisted non-empty value of at most 200 characters without surrounding whitespace or line breaks.",
      64,
    );
  }
}

function retryAfterMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.max(1, Math.ceil(seconds * 1_000));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
