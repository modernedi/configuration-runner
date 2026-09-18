# ModernEDI configuration runner

`@modernedi/configuration-runner` is a small, vendor-neutral automation runner for ModernEDI configuration as code. It turns a portable bundle directory into a reviewable plan, then applies only the exact plan that was reviewed. It is intentionally not a general ModernEDI CLI and does not duplicate server-side validation.

The runner works in any CI system that can run Node.js 20 or later. Vendor-specific workflows should remain thin adapters around these four commands.

## Install and run

Use an exact package version in protected automation:

```sh
npx --yes @modernedi/configuration-runner@0.5.0 plan \
  --bundle ./modernedi \
  --plan-out ./artifacts/plan.json
```

The package depends on the exact `@modernedi/sdk@0.8.0` API contract, including shared public certificate files, scenario bindings for Production or Test traffic, and optional generated-X12 checks for saved mapping cases.

Set these environment variables through your CI secret store:

- `MODERNEDI_API_KEY` — required; a read-capable key is sufficient for `plan` and `wait`, while `apply-reviewed` requires configuration write access.
- `MODERNEDI_API_URL` — optional API base URL override.
- `MODERNEDI_APP_URL` — optional workspace base URL override. Result artifacts otherwise link to `https://app.modernedi.com/`.
- `MODERNEDI_IDEMPOTENCY_KEY` — required only for `apply-reviewed`. Persist one stable, non-secret deployment identity and reuse it when retrying the same apply. Leading or trailing whitespace is rejected.

## Bundle boundary

The same bundle can contain AS2 connections, partners, mappings, scenario definitions, and scenario bindings. Scenarios remain optional. Binding source uses portable `partnerKey` and `mappingKey` references; resolved runtime IDs, automatic syntax-tree pins, and run evidence are not authored repository configuration. See the [scenario configuration guide](https://www.modernedi.com/docs/scenarios/reference#configuration-and-git).

`--bundle` names an editable directory containing `modernedi.json`. The runner submits only the files inventoried by that manifest. It rejects absolute paths, traversal, Windows drive/stream syntax, `_state`, invalid UTF-8, missing files, duplicate case-folded paths, and any symlink in an inventoried path. Extra files are ignored rather than uploaded.

JSON manifest and resource hashes are calculated from recursively key-sorted compact JSON. Source-file hashes use their exact bytes. Paths are ordered by a stable code-unit comparison, independent of the host locale.

Edit JSON with your usual indentation, property ordering, and final newline. Edit mapping source directly. The runner derives `transform.sourceSha256` and both manifest inventories' `contentSha256` values in memory; you do not update checksums by hand, and your files are not rewritten. Automatic external Git synchronization uses the same preparation rules. Formatting-only JSON edits produce the same desired configuration; whitespace changes in mapping source remain real source changes.

AS2 connection exports keep the partner's public certificates in `as2-connections/<key>/certificates/production.pem` and, when configured, `test.pem`. When both certificates are identical, exports use one `shared.pem`. Production and Test may both use `publicCertificatePath: "./certificates/shared.pem"` in `connection.json`, with a derived `publicCertificateSha256`; replacing that file updates both environments' certificate hashes without changing their independent transport settings. Other connection-local names are supported (1-64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit). These files use manifest role `CERTIFICATE`. The runner accepts one public PEM X.509 certificate per file, normalizes its line endings/base64 wrapping, and derives its hashes before the connection and manifest hashes. It rejects private keys, traversal, subdirectories, URLs, and references outside that connection. Keep secret values out of Git; use managed credential references. Inline `publicCertificatePem` is also supported, but cannot coexist with a file reference in the same environment. See the [partner-file guide and generated schemas](https://www.modernedi.com/docs/configuration-in-git#partner-files).

Keep resource keys and paths stable. When adding or removing resources or source files, update the explicit `modernedi.json` inventory too. Missing inventoried files still fail validation; they are not interpreted as accidental deletions. The prepared API request and reviewed plan remain strict, checksummed artifacts, and `apply-reviewed` still rejects semantic changes made after review.

ModernEDI remains authoritative for document shape, mapping compilation, semantic validation, scenario impact, and the resulting plan identity.

## Plan in review automation

Run with a read-capable key on a proposed bundle:

```sh
npx --yes @modernedi/configuration-runner@0.5.0 plan \
  --bundle ./modernedi \
  --plan-out ./artifacts/plan.json
```

The command prints a human summary and writes deterministic `plan.json`. Preserve that file as the reviewed build artifact. A plan with validation errors is still written, but the command exits `2` and the artifact has `planSha256: null`.

`plan.json` contains both identities that later authorize deployment and the complete wire plan reviewers saw. Editing the embedded operations or diagnostics without changing the top-level hashes does not authorize an apply: protected apply compares the entire freshly generated wire plan exactly.

## Optionally verify saved mapping cases

Mappings can carry optional `spec.regressionCases`; author them in the browser or edit the same portable JSON. A partner and mapping remain sufficient without tests, scenarios, or automation.

An outgoing case can set `validateX12: true` to check its generated document against the mapping's selected X12 version and document type, as well as matching the expected text. Leave it unset for intentional fragments. The same setting travels through browser-authored cases, Git, and this runner. The report includes a separate `x12ValidationStatus` when the check was requested; matching expected text alone cannot turn a failed X12 check into a pass.

After reviewing a plan, execute its saved cases on ModernEDI's server:

```sh
npx --yes @modernedi/configuration-runner@0.5.0 verify \
  --bundle ./modernedi \
  --reviewed-plan ./artifacts/plan.json \
  --request-id 43c4a774-911c-47b6-a9f5-5bf2cde68157 \
  --result-out ./artifacts/verification.json
```

Generate a UUID for each new verification and retain it for retries; do not reuse the example UUID across builds. Verification needs `configuration:read`, re-plans before execution, and never applies configuration. The report identifies the exact desired bundle, plan, baseline, evaluator, and grammar for each tested mapping. Mappings without saved cases are counted explicitly.

The suite supports 25 tested mappings and 100 cases, with a 30-second total deadline. It shares browser verification capacity: one active run per workspace and 30 starts per hour. Results retain hashes and outcomes, not raw input/output. The latest 200 runs are retained for up to 90 days.

`verification.json` uses the server response contract and the packaged `schemas/configuration-verification-result.schema.json`, generated from OpenAPI. Exit `0` means the result is `PASSED` and `CURRENT`; exit `5` means otherwise, including incomplete execution. A lost response does not mean cancellation: use the SDK or `GET /v1/configuration/verification-runs/verify-{requestId}` to inspect the persisted result. The initiating key can cancel using `POST /v1/configuration/verification-runs/{runId}/cancel`.

To explicitly require the result during apply, add `--verification-run-id <runId>` to `apply-reviewed`. The server checks its own stored, current passing result against this exact plan and links it to Change history. It does not trust statuses edited in a downloaded report. Omit the flag to apply normally without a test gate. A protected write-capable key may apply a run produced by a read-capable key in the same workspace.

A pass proves exact output and any requested X12 validation for the selected saved cases in the backend evaluator. It does not establish live runtime activation, AS2 delivery, partner acceptance, or scenario success.

## Apply after protected merge

Download the reviewed `plan.json`, check out the exact protected revision, and supply a persisted idempotency key:

```sh
export MODERNEDI_IDEMPOTENCY_KEY="production:configuration:build-1842"

npx --yes @modernedi/configuration-runner@0.5.0 apply-reviewed \
  --bundle ./modernedi \
  --reviewed-plan ./artifacts/plan.json \
  --result-out ./artifacts/result.json \
  --timeout-seconds 900
```

Before applying, the runner reloads the bundle, re-plans against the workspace's current state, and requires an exact match of:

- the desired bundle SHA-256;
- the plan SHA-256;
- the complete plan JSON, including operations, diagnostics, validation context, and scenario impact.

It then submits the exact desired files with the fresh plan's exact `If-Match` ETag and the caller's idempotency key. Drift fails closed without an apply call.

As soon as the server accepts the apply, `result.json` is written atomically with the `PENDING` operation. It is updated after every poll and on `SUCCEEDED`. If polling times out, the database transaction may already be committed; do not submit a new apply merely to resume observation.

## Resume a pending operation

Use the stored result artifact and a read-capable key:

```sh
npx --yes @modernedi/configuration-runner@0.5.0 wait \
  --result ./artifacts/result.json \
  --timeout-seconds 900
```

`wait` reads only the recorded operation ID, verifies returned bundle and plan identities, and atomically updates the same file. Use `--result-out <path>` to preserve the input separately. A completed result includes a deep link to the corresponding deployment in the ModernEDI workspace.

## Artifact schemas

Both public automation artifacts use `apiVersion: modernedi.com/configuration-runner/v1` and have closed JSON Schemas:

- [`schemas/configuration-plan-artifact.schema.json`](./schemas/configuration-plan-artifact.schema.json)
- [`schemas/configuration-apply-result-artifact.schema.json`](./schemas/configuration-apply-result-artifact.schema.json)

The schemas are included in the npm package for editor, policy, and artifact-validation tooling. The result schema references definitions in the adjacent plan schema, so keep both files together.

## Exit codes

- `0` — plan applicable, apply succeeded, or wait observed success.
- `2` — local bundle problem or server plan not applicable.
- `3` — reviewed evidence mismatch or drift.
- `4` — stored/pending apply could not be observed to completion within the bound.
- `5` — verification did not finish with a current passing result; inspect the stored report.
- `64` — usage or required environment configuration error.
- `1` — API or unexpected runtime failure.

## Build and test this repository

This repository contains the complete public package source, runtime helpers,
examples or schemas, and offline tests. No ModernEDI account, API key, private
repository, code generator, or Java installation is needed to build it.

```sh
npm ci
npm run verify
```

Generated API files are produced from ModernEDI's canonical API contract. Report
issues here; generated files should be corrected in the upstream contract/tooling
and regenerated. The public source is exported as a reviewed snapshot, without
private application code, generators, deployment credentials, or Git history.
PUBLIC_SOURCE.json records the source revision and exported file hashes.

Publishing npm packages is a separate, protected maintainer operation. The CI
workflow in this repository only builds, tests, and checks package contents.
