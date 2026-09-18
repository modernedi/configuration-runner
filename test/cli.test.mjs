import assert from "node:assert/strict";
import test from "node:test";

import { ModernEdiApiError } from "@modernedi/sdk";

import {
  formatCliError,
  parseCommand,
  runCli,
} from "../dist/cli.js";

test("parses only the four narrow runner modes", () => {
  assert.deepEqual(parseCommand(["plan", "--bundle", "bundle"]), {
    mode: "plan",
    bundleDirectory: "bundle",
    artifactPath: "plan.json",
  });
  assert.deepEqual(parseCommand([
    "apply-reviewed",
    "--bundle",
    "bundle",
    "--reviewed-plan",
    "reviewed.json",
    "--timeout-seconds",
    "30",
  ]), {
    mode: "apply-reviewed",
    bundleDirectory: "bundle",
    reviewedPlanPath: "reviewed.json",
    artifactPath: "result.json",
    timeoutMs: 30_000,
  });
  assert.deepEqual(parseCommand(["wait", "--result", "result.json"]), {
    mode: "wait",
    resultPath: "result.json",
    artifactPath: "result.json",
    timeoutMs: 900_000,
  });
  assert.deepEqual(parseCommand(["verify", "--bundle", "bundle", "--reviewed-plan", "plan.json", "--request-id", "request-uuid"]), {
    mode: "verify", bundleDirectory: "bundle", reviewedPlanPath: "plan.json", requestId: "request-uuid", artifactPath: "verification.json",
  });
  assert.throws(
    () => parseCommand(["export", "--bundle", "bundle"]),
    (error) => error?.code === "USAGE",
  );
});

test("help exits successfully without credentials or client construction", async () => {
  let clientCalls = 0;
  const output = [];
  assert.equal(await runCli(["--help"], {}, {
    createClient: () => {
      clientCalls += 1;
      throw new Error("must not construct client");
    },
    stdout: (message) => output.push(message),
  }), 0);
  assert.equal(clientCalls, 0);
  assert.match(output.join(""), /apply-reviewed/u);
  assert.match(output.join(""), /wait --result/u);
});

test("API errors retain server recovery message, request ID, and safe details", () => {
  const response = new Response(null, { status: 422 });
  const error = new ModernEdiApiError(
    "Mapping source did not compile",
    422,
    "configuration_mapping_invalid",
    false,
    "req-123",
    [{ filePath: "mappings/example/source.x12mapper", line: 4 }],
    undefined,
    undefined,
    response,
  );
  const rendered = formatCliError(error);
  assert.match(rendered, /Mapping source did not compile/u);
  assert.match(rendered, /requestId=req-123/u);
  assert.match(rendered, /source\.x12mapper/u);
  assert.match(rendered, /"line":4/u);
});
