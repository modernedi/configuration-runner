import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assert.deepEqual(packageJson.bin, {
  "modernedi-configuration": "./dist/main.js",
});
assert.equal(
  packageJson.dependencies?.["@modernedi/sdk"],
  "0.8.1",
  "the runner must require the SDK preserving shared public certificate files, hashed mapping cases, optional X12 validation, and scenario traffic environments",
);
assert.deepEqual(packageJson.repository, {
  type: "git",
  url: "git+https://github.com/modernedi/configuration-runner.git",
});
for (const requiredFile of ["dist", "schemas", "README.md", "LICENSE"]) {
  assert.ok(
    packageJson.files?.includes(requiredFile),
    `published files must include ${requiredFile}`,
  );
}
assert.doesNotMatch(
  packageJson.dependencies["@modernedi/sdk"],
  /^(?:file|link|workspace):/u,
  "the packed runtime dependency must never point at a maintainer checkout",
);
