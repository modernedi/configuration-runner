import {
  ModernEdiApiError,
  ModernEdiClient,
  ConfigurationVerificationResponseToJSON,
} from "@modernedi/sdk";

import {
  readConfigurationApplyResultArtifact,
  readConfigurationPlanArtifact,
  writeArtifact,
} from "./artifacts.js";
import { loadConfigurationBundleDirectory } from "./bundle-directory.js";
import { ConfigurationRunnerError, runnerError } from "./errors.js";
import {
  applyReviewedConfiguration,
  planConfiguration,
  verifyReviewedConfiguration,
  waitForConfigurationApply,
  type ConfigurationRunnerClient,
} from "./runner.js";

const DEFAULT_PLAN_PATH = "plan.json";
const DEFAULT_RESULT_PATH = "result.json";

type RunnerCommand = PlanCommand | VerifyCommand | ApplyReviewedCommand | WaitCommand | HelpCommand;

interface VerifyCommand {
  mode: "verify";
  bundleDirectory: string;
  reviewedPlanPath: string;
  requestId: string;
  artifactPath: string;
}

interface HelpCommand {
  mode: "help";
}

interface PlanCommand {
  mode: "plan";
  bundleDirectory: string;
  artifactPath: string;
}

interface ApplyReviewedCommand {
  mode: "apply-reviewed";
  bundleDirectory: string;
  reviewedPlanPath: string;
  artifactPath: string;
  timeoutMs: number;
  verificationRunId?: string;
}

interface WaitCommand {
  mode: "wait";
  resultPath: string;
  artifactPath: string;
  timeoutMs: number;
}

interface RunnerEnvironment {
  MODERNEDI_API_KEY?: string;
  MODERNEDI_API_URL?: string;
  MODERNEDI_APP_URL?: string;
  MODERNEDI_IDEMPOTENCY_KEY?: string;
}

interface CliDependencies {
  createClient?: (environment: RunnerEnvironment) => ConfigurationRunnerClient;
  stdout?: (message: string) => void;
}

export async function runCli(
  argv: readonly string[],
  environment: RunnerEnvironment = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const command = parseCommand(argv);
  const stdout = dependencies.stdout ?? ((message) => process.stdout.write(message));
  if (command.mode === "help") {
    stdout(`${usageText()}\n`);
    return 0;
  }
  const client = (dependencies.createClient ?? createClient)(environment);

  if (command.mode === "plan") {
    const bundle = await loadConfigurationBundleDirectory(command.bundleDirectory);
    const artifact = await planConfiguration(client, bundle.request);
    if (artifact.desiredBundleSha256 !== bundle.bundleSha256) {
      throw runnerError(
        "BUNDLE_HASH_DISAGREEMENT",
        `Local manifest hash ${bundle.bundleSha256} does not match ModernEDI desired bundle ${artifact.desiredBundleSha256}.`,
        2,
      );
    }
    await writeArtifact(command.artifactPath, artifact);
    stdout(renderPlanSummary(artifact, command.artifactPath));
    return artifact.planSha256 === null ? 2 : 0;
  }

  if (command.mode === "wait") {
    const stored = await readConfigurationApplyResultArtifact(command.resultPath);
    const result = await waitForConfigurationApply({
      client,
      result: stored,
      timeoutMs: command.timeoutMs,
      appUrl: environment.MODERNEDI_APP_URL,
      onResult: (artifact) => writeArtifact(command.artifactPath, artifact),
    });
    await writeArtifact(command.artifactPath, result);
    stdout(renderApplySummary(result, command.artifactPath));
    return 0;
  }

  const reviewed = await readConfigurationPlanArtifact(command.reviewedPlanPath);
  const bundle = await loadConfigurationBundleDirectory(command.bundleDirectory);
  if (bundle.bundleSha256 !== reviewed.desiredBundleSha256) {
    throw runnerError(
      "REVIEWED_BUNDLE_MISMATCH",
      `Protected apply bundle ${bundle.bundleSha256} does not match reviewed bundle ${reviewed.desiredBundleSha256}. No apply was submitted.`,
      3,
    );
  }
  const idempotencyKey = environment.MODERNEDI_IDEMPOTENCY_KEY;
  if (command.mode === "verify") {
    const report = await verifyReviewedConfiguration({ client, request: bundle.request, reviewedPlan: reviewed, requestId: command.requestId });
    await writeArtifact(command.artifactPath, ConfigurationVerificationResponseToJSON(report));
    stdout(`Verification: ${report.run.status} (${report.run.freshness})\nRun: ${report.run.runId}\nCases completed: ${report.run.cases.length}/${report.run.identity.caseCount}\nMappings without cases: ${report.run.identity.untestedMappingCount}\nReport: ${command.artifactPath}\n`);
    return report.run.status === "PASSED" && report.run.freshness === "CURRENT" ? 0 : 5;
  }
  if (idempotencyKey === undefined) {
    throw runnerError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Set MODERNEDI_IDEMPOTENCY_KEY to the persisted deployment identity before apply-reviewed.",
      64,
    );
  }
  const result = await applyReviewedConfiguration({
    client,
    request: bundle.request,
    reviewedPlan: reviewed,
    idempotencyKey,
    verificationRunId: command.verificationRunId,
    timeoutMs: command.timeoutMs,
    appUrl: environment.MODERNEDI_APP_URL,
    onResult: (artifact) => writeArtifact(command.artifactPath, artifact),
  });
  await writeArtifact(command.artifactPath, result);
  stdout(renderApplySummary(result, command.artifactPath));
  return 0;
}

export function parseCommand(argv: readonly string[]): RunnerCommand {
  const [mode, ...tokens] = argv;
  if ((mode === "--help" || mode === "-h" || mode === "help")
    && tokens.length === 0) {
    return { mode: "help" };
  }
  if (mode !== "plan" && mode !== "verify" && mode !== "apply-reviewed" && mode !== "wait") {
    throw usageError();
  }
  const flags = parseFlags(tokens);
  if (mode === "verify") {
    assertAllowedFlags(flags, ["--bundle", "--reviewed-plan", "--request-id", "--result-out"]);
    return { mode, bundleDirectory: requiredFlag(flags, "--bundle"), reviewedPlanPath: requiredFlag(flags, "--reviewed-plan"),
      requestId: requiredFlag(flags, "--request-id"), artifactPath: flags.get("--result-out") ?? "verification.json" };
  }
  if (mode === "plan") {
    assertAllowedFlags(flags, ["--bundle", "--plan-out"]);
    return {
      mode,
      bundleDirectory: requiredFlag(flags, "--bundle"),
      artifactPath: flags.get("--plan-out") ?? DEFAULT_PLAN_PATH,
    };
  }
  if (mode === "wait") {
    assertAllowedFlags(flags, ["--result", "--result-out", "--timeout-seconds"]);
    const resultPath = requiredFlag(flags, "--result");
    return {
      mode,
      resultPath,
      artifactPath: flags.get("--result-out") ?? resultPath,
      timeoutMs: parseTimeout(flags.get("--timeout-seconds")),
    };
  }
  assertAllowedFlags(flags, [
    "--bundle",
    "--reviewed-plan",
    "--result-out",
    "--timeout-seconds",
    "--verification-run-id",
  ]);
  return {
    mode,
    bundleDirectory: requiredFlag(flags, "--bundle"),
    reviewedPlanPath: requiredFlag(flags, "--reviewed-plan"),
    artifactPath: flags.get("--result-out") ?? DEFAULT_RESULT_PATH,
    timeoutMs: parseTimeout(flags.get("--timeout-seconds")),
    ...(flags.has("--verification-run-id") ? { verificationRunId: flags.get("--verification-run-id") } : {}),
  };
}

export function formatCliError(error: unknown): string {
  if (error instanceof ModernEdiApiError) {
    const request = error.requestId ? ` requestId=${error.requestId}` : "";
    const details = error.details === undefined
      ? ""
      : `\nDetails: ${JSON.stringify(error.details)}`;
    return `[${error.code}] ModernEDI returned HTTP ${error.status}: ${error.message}.${request}${details}\n`;
  }
  if (error instanceof ConfigurationRunnerError) {
    return `[${error.code}] ${error.message}\n`;
  }
  return `[UNEXPECTED_ERROR] ${error instanceof Error ? error.message : String(error)}\n`;
}

export function exitCodeForError(error: unknown): number {
  return error instanceof ConfigurationRunnerError ? error.exitCode : 1;
}

function createClient(environment: RunnerEnvironment): ConfigurationRunnerClient {
  const apiKey = environment.MODERNEDI_API_KEY;
  if (!apiKey) {
    throw runnerError(
      "API_KEY_REQUIRED",
      "Set MODERNEDI_API_KEY before running configuration automation.",
      64,
    );
  }
  return new ModernEdiClient({
    apiKey,
    ...(environment.MODERNEDI_API_URL
      ? { baseUrl: environment.MODERNEDI_API_URL }
      : {}),
    retry: { maxAttempts: 3 },
  });
}

function parseFlags(tokens: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw usageError();
    }
    if (flags.has(flag)) {
      throw runnerError(
        "ARGUMENT_DUPLICATE",
        `Argument ${flag} may be supplied only once.`,
        64,
      );
    }
    flags.set(flag, value);
  }
  return flags;
}

function assertAllowedFlags(
  flags: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const flag of flags.keys()) {
    if (!allowed.includes(flag)) {
      throw runnerError(
        "ARGUMENT_UNKNOWN",
        `Unknown argument ${flag}.`,
        64,
      );
    }
  }
}

function requiredFlag(flags: ReadonlyMap<string, string>, flag: string): string {
  const value = flags.get(flag);
  if (!value) {
    throw runnerError(
      "ARGUMENT_REQUIRED",
      `${flag} is required.`,
      64,
    );
  }
  return value;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) {
    return 15 * 60_000;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw runnerError(
      "ARGUMENT_TIMEOUT_INVALID",
      "--timeout-seconds must be a whole number from 1 through 86400.",
      64,
    );
  }
  return seconds * 1_000;
}

function usageError() {
  return runnerError(
    "USAGE",
    usageText(),
    64,
  );
}

function usageText(): string {
  return [
    "Usage:",
    `  modernedi-configuration plan --bundle <directory> [--plan-out ${DEFAULT_PLAN_PATH}]`,
    "  modernedi-configuration verify --bundle <directory> --reviewed-plan <plan.json> --request-id <uuid> [--result-out verification.json]",
    `  modernedi-configuration apply-reviewed --bundle <directory> --reviewed-plan <plan.json> [--verification-run-id <verify-uuid>] [--result-out ${DEFAULT_RESULT_PATH}] [--timeout-seconds 900]`,
    "  modernedi-configuration wait --result <result.json> [--result-out <result.json>] [--timeout-seconds 900]",
  ].join("\n");
}

function renderPlanSummary(
  artifact: Awaited<ReturnType<typeof planConfiguration>>,
  artifactPath: string,
): string {
  const plan = artifact.plan;
  const summary = plan.summary;
  const lines = [
    `Plan: ${plan.applicable === true ? "APPLICABLE" : "NOT APPLICABLE"}`,
    `Desired bundle: ${artifact.desiredBundleSha256}`,
    `Plan identity: ${artifact.planSha256 ?? "none"}`,
  ];
  if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
    lines.push(
      `Changes: create=${String(summary.create)} update=${String(summary.update)} delete=${String(summary.delete)} unchanged=${String(summary.unchanged)}`,
    );
  }
  const operations = Array.isArray(plan.operations) ? plan.operations : [];
  for (const operation of operations) {
    if (operation !== null && typeof operation === "object" && !Array.isArray(operation)) {
      lines.push(
        `  ${String(operation.action)} ${String(operation.kind)} ${String(operation.key)} ${String(operation.path)}`,
      );
    }
  }
  const diagnostics = Array.isArray(plan.diagnostics) ? plan.diagnostics : [];
  for (const diagnostic of diagnostics) {
    if (diagnostic !== null && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
      lines.push(
        `  ${String(diagnostic.severity)} ${String(diagnostic.code)} ${String(diagnostic.pointer)} ${String(diagnostic.message)}`,
      );
    }
  }
  lines.push(`Artifact: ${artifactPath}`, "");
  return lines.join("\n");
}

function renderApplySummary(
  result: Awaited<ReturnType<typeof applyReviewedConfiguration>>,
  artifactPath: string,
): string {
  return [
    "Reviewed plan: VERIFIED",
    `Desired bundle: ${result.reviewed.desiredBundleSha256}`,
    `Plan identity: ${result.reviewed.planSha256}`,
    `Operation: ${String(result.operation.operationId)}`,
    `Status: ${String(result.operation.status)}`,
    `Runtime revision: ${String(result.operation.runtimeConfigurationRevision)}`,
    `Idempotency replayed: ${String(result.idempotencyReplayed)}`,
    `Workspace: ${result.workspaceUrl}`,
    `Artifact: ${artifactPath}`,
    "",
  ].join("\n");
}
