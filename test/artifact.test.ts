/**
 * Installed-artifact tests.
 *
 * These exist because of a real shipping failure: version 0.2.0 (and the
 * manually published 0.1.0) were broken when installed via npx/npm - Node
 * refuses to type-strip `.ts` files that live inside `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which worked fine from the
 * repo and from `npm pack`, and only failed once installed. The package now
 * ships compiled JS in `dist/`; these tests build that artifact and exercise
 * it in exactly the shape an installed package takes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const DIST_CLI = path.join(ROOT, "dist", "cli.js");

/** Build the dist artifact (the release workflow does the same before publish). */
function build(): void {
  const result = spawnSync(
    process.execPath,
    [
      path.join(path.parse(process.execPath).dir, "tsc"),
      "-p",
      path.join(ROOT, "tsconfig.build.json"),
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  // tsc may not sit next to node (npx setups); fall back to the repo's copy.
  if (result.status !== 0) {
    const retry = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", ".bin", "tsc"),
        "-p",
        path.join(ROOT, "tsconfig.build.json"),
      ],
      { encoding: "utf8" },
    );
    if (retry.status !== 0) {
      throw new Error(`build failed: ${retry.stderr || result.stderr}`);
    }
  }
}

before(() => {
  build();
});

function run(bin: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the compiled CLI runs and reports the package version", () => {
  const { status, stdout } = run(process.execPath, [DIST_CLI, "--version"]);
  assert.equal(status, 0);
  assert.match(stdout.trim(), /^gdrive-publish \d+\.\d+\.\d+$/);
});

test("the compiled CLI propagates exit codes and prints help", () => {
  const bad = run(process.execPath, [DIST_CLI, "no-such-command"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command/);
  const help = run(process.execPath, [DIST_CLI, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands/);
});

test("the compiled output is plain JS (no .ts imports left behind)", () => {
  // If a .ts import survived compilation, the package would break exactly the
  // way 0.2.0 did the moment it lands in node_modules.
  const check = fs.readdirSync(path.join(ROOT, "dist", "core"), { recursive: true });
  for (const entry of check) {
    assert.ok(!String(entry).endsWith(".ts"), `stray .ts in dist: ${entry}`);
  }
  const cli = fs.readFileSync(DIST_CLI, "utf8");
  assert.doesNotMatch(cli, /from "\.[^"]*\.ts"/, "compiled cli.js still imports a .ts file");
});

test("REGRESSION 0.2.0: the artifact runs from inside node_modules", () => {
  // Reproduce the installed-package layout: dist/ + package.json under a
  // node_modules path, executed exactly as an installed bin would be.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-artifact-"));
  try {
    const pkgDir = path.join(tmp, "node_modules", "gdrive-publish");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.cpSync(path.join(ROOT, "dist"), path.join(pkgDir, "dist"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(pkgDir, "package.json"));
    const { status, stdout } = run(process.execPath, [
      path.join(pkgDir, "dist", "cli.js"),
      "--version",
    ]);
    assert.equal(status, 0, "must run under node_modules (Node forbids TS there)");
    assert.match(stdout.trim(), /^gdrive-publish \d+\.\d+\.\d+$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
