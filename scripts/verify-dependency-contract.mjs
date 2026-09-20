import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertSdkVersion } from "./sdk-contract.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assert.deepEqual(packageJson.bin, {
  "modernedi-configuration": "./dist/main.js",
});
assertSdkVersion(packageJson.dependencies?.["@modernedi/sdk"]);
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
