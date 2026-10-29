/**
 * CLI help-system tests.
 *
 * The command table in `commands.ts` is now the single source of truth for the
 * surface, so these tests pin the contract that motivated it: `--help` on a
 * destructive command must never execute it, unknown flags are usage errors,
 * and every command is fully documented (a meta-check, so help cannot decay
 * silently as commands are added).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  COMMANDS,
  VERSION,
  flagsFor,
  parseFolderRef,
  renderCommand,
  renderOverview,
} from "../commands.ts";
import * as manifestIo from "../core/manifest.ts";

const CLI = path.join(import.meta.dirname, "..", "cli.ts");

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "gdp-home-")),
      GDRIVE_PUBLISH_CLIENT_ID: "test-client-id",
      GDRIVE_PUBLISH_CLIENT_SECRET: "test-secret",
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("--version prints the tool version, nothing else", () => {
  const { status, stdout } = run(["--version"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), `gdrive-publish ${VERSION}`);
});

test("-h works as a short form", () => {
  const { status, stdout } = run(["-h"]);
  assert.equal(status, 0);
  assert.match(stdout, /Commands/);
});

test("no arguments shows the overview", () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  for (const command of COMMANDS) {
    assert.match(stdout, new RegExp(`\\b${command.name}\\b`), `overview mentions ${command.name}`);
  }
});

test("help <command> and <command> --help print the same thing, for every command", () => {
  // `help --help` deliberately shows the overview rather than help-about-help,
  // so the help command itself is excluded from this equivalence check.
  for (const command of COMMANDS.filter((c) => c.name !== "help")) {
    const viaHelp = run(["help", command.name]);
    const viaFlag = run([command.name, "--help"]);
    assert.equal(viaHelp.status, 0, `help ${command.name} exits 0`);
    assert.equal(viaFlag.status, 0, `${command.name} --help exits 0`);
    assert.equal(viaFlag.stdout, viaHelp.stdout, `${command.name}: both help forms match`);
  }
});

test("per-command help documents every accepted flag and at least one example", () => {
  for (const command of COMMANDS) {
    const text = renderCommand(command);
    for (const flag of command.flags) {
      assert.match(text, new RegExp(`--${flag.name}`), `${command.name} help shows --${flag.name}`);
    }
    assert.ok(command.examples.length > 0, `${command.name} has an example`);
    for (const example of command.examples) {
      assert.match(text, new RegExp(example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("--help on publish never publishes, even in a configured directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-help-"));
  try {
    fs.writeFileSync(path.join(root, "a.md"), "# A\n");
    manifestIo.save(root, manifestIo.emptyManifest("fldROOT", "Docs"));
    const before = fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8");

    const { status, stdout } = run(["publish", root, "--help"]);
    assert.equal(status, 0);
    assert.match(stdout, /publish <dir>/);

    assert.equal(
      fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8"),
      before,
      "--help must not touch the manifest",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown flag is a usage error that lists the valid flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-help-"));
  try {
    fs.writeFileSync(path.join(root, "a.md"), "# A\n");
    manifestIo.save(root, manifestIo.emptyManifest("fldROOT", "Docs"));
    const before = fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8");

    const { status, stderr } = run(["publish", root, "--prunee"]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown flag --prunee for 'publish'/);
    for (const flag of flagsFor(
      COMMANDS.find((c) => c.name === "publish") as { name: string } as never,
    )) {
      void flag;
    }
    assert.match(
      stderr,
      /valid: --dry-run --prune --repair --concurrency --json --remote --help --version/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8"),
      before,
      "a rejected flag must not fall through to publishing",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a flag from another command is rejected where it does not belong", () => {
  // --prune belongs to publish, not to plan
  const { status, stderr } = run(["plan", os.tmpdir(), "--prune"]);
  assert.equal(status, 2);
  assert.match(stderr, /unknown flag --prune for 'plan'/);
});

test("a typo'd command suggests the nearest match", () => {
  const { status, stderr } = run(["publsih"]);
  assert.equal(status, 2);
  assert.match(stderr, /did you mean "publish"/);
});

test("a missing directory argument is a usage error", () => {
  assert.equal(run(["plan"]).status, 2);
  assert.equal(run(["publish"]).status, 2);
  assert.equal(run(["status"]).status, 2);
});

test("init without --name is a usage error naming the option", () => {
  const { status, stderr } = run(["init", os.tmpdir()]);
  assert.equal(status, 2);
  assert.match(stderr, /init requires --name/);
});

test("--name without a value is a usage error", () => {
  const { status, stderr } = run(["init", os.tmpdir(), "--name"]);
  assert.equal(status, 2);
  assert.match(stderr, /--name requires a value/);
});

test("extra positional arguments are rejected", () => {
  const { status, stderr } = run(["plan", os.tmpdir(), "extra"]);
  assert.equal(status, 2);
  assert.match(stderr, /unexpected argument/);
});

test("parseFolderRef accepts folder URLs and bare ids, rejects garbage", () => {
  assert.equal(
    parseFolderRef("https://drive.google.com/drive/folders/1AbCdEfGhIjK"),
    "1AbCdEfGhIjK",
  );
  assert.equal(
    parseFolderRef("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjK/"),
    "1AbCdEfGhIjK",
  );
  assert.equal(
    parseFolderRef("https://drive.google.com/drive/u/2/folders/xyz_-12345678"),
    "xyz_-12345678",
  );
  assert.equal(parseFolderRef("1AbCdEfGhIjK"), "1AbCdEfGhIjK");
  assert.equal(parseFolderRef("  1AbCdEfGhIjK  "), "1AbCdEfGhIjK");
  assert.equal(parseFolderRef("not a ref"), null);
  assert.equal(parseFolderRef("https://docs.google.com/document/d/1AbCdEfGhIjK/edit"), null);
  assert.equal(parseFolderRef("short"), null);
});

test("the overview documents every environment variable and exit code", () => {
  const overview = renderOverview();
  for (const env of [
    "GDRIVE_PUBLISH_CLIENT_ID",
    "GDRIVE_PUBLISH_CLIENT_SECRET",
    "GDRIVE_PUBLISH_CLIENT_SECRET_FILE",
    "GDRIVE_PUBLISH_RCLONE_REMOTE",
  ]) {
    assert.match(overview, new RegExp(env));
  }
  for (const code of [0, 1, 2, 3]) {
    assert.match(overview, new RegExp(String(code)));
  }
});

// ---------------------------------------------------------------------------
// Meta: the command table must stay self-consistent
// ---------------------------------------------------------------------------

test("every command is fully documented (meta)", () => {
  for (const command of COMMANDS) {
    assert.ok(command.summary.length > 0, `${command.name}: summary`);
    assert.ok(!command.summary.endsWith("."), `${command.name}: summaries are not sentences`);
    if (command.needsTarget) {
      // any documented placeholder (browse takes a dir-or-file path)
      assert.ok(command.args.includes("<"), `${command.name}: args document a placeholder`);
    }
    for (const flag of command.flags) {
      assert.ok(flag.summary.length > 0, `${command.name} --${flag.name}: summary`);
      assert.ok(!flag.summary.endsWith("."), `${command.name} --${flag.name}: not a sentence`);
      if (flag.takesValue) {
        assert.ok(
          flag.valueLabel !== undefined,
          `${command.name} --${flag.name}: value-taking flags declare a value label`,
        );
      }
    }
    // rendered output stays within a sane width
    for (const line of renderCommand(command).split("\n")) {
      assert.ok(line.length <= 100, `${command.name}: help line too long (${line.length})`);
    }
  }
});
