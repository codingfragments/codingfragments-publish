/**
 * Extension readiness and write-gating tests (decision 16).
 *
 * The safety property under test: a tool that can write to Google Drive must
 * not exist in sessions that have nothing to do with publishing. This repo
 * auto-loads every extension under `extensions/`, so without this gate any pi
 * session in any repository would expose it.
 *
 * The extension factory is driven with a stub ExtensionAPI/ExtensionContext -
 * no pi runtime, no Drive traffic. Earlier these checks lived in throwaway
 * scripts under /tmp; they belong here.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as manifestIo from "../core/manifest.ts";

const EXTENSION = path.join(import.meta.dirname, "..", "index.ts");

interface StubTool {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
}

interface Loaded {
  tools: StubTool[];
  commands: string[];
  events: string[];
}

let workspace: string;
let home: string;
const originalCwd = process.cwd();
const TOUCHED_ENV = [
  "HOME",
  "PATH",
  "GDRIVE_PUBLISH_CLIENT_ID",
  "GDRIVE_PUBLISH_CLIENT_SECRET",
  "GDRIVE_PUBLISH_CLIENT_SECRET_FILE",
  "GDRIVE_PUBLISH_RCLONE_REMOTE",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-ext-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-exthome-"));
  savedEnv.clear();
  for (const key of TOUCHED_ENV) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  process.chdir(originalCwd);
  // Restore keys individually: assigning `process.env = {...}` swaps the magic
  // env object for a plain one, after which os.homedir() (which reads the real
  // OS environment) stops observing HOME changes and later tests silently see
  // the developer's real home directory.
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Load the extension factory fresh (cache-busted) with the given cwd/env and
 * report what it registered.
 */
async function load(cwd: string): Promise<Loaded> {
  const loaded: Loaded = { tools: [], commands: [], events: [] };
  const pi = {
    registerTool: (t: StubTool) => loaded.tools.push(t),
    registerCommand: (name: string) => loaded.commands.push(name),
    on: (event: string) => loaded.events.push(event),
    registerShortcut: () => {},
    registerFlag: () => {},
  };
  process.chdir(cwd);
  const mod = (await import(`${EXTENSION}?t=${Date.now()}-${Math.random()}`)) as {
    default: (api: unknown) => void | Promise<void>;
  };
  await mod.default(pi);
  return loaded;
}

function seedManifest(dir: string): void {
  manifestIo.save(dir, manifestIo.emptyManifest("fldROOT", "Test Docs"));
}

test("no manifest: the writing tool is NOT registered", async () => {
  process.env.HOME = home;
  const loaded = await load(workspace);
  assert.deepEqual(
    loaded.tools.map((t) => t.name),
    [],
  );
  assert.ok(loaded.commands.includes("gdrive-publish-init"), "setup command stays available");
  assert.ok(loaded.commands.includes("gdrive-publish-status"));
});

test("manifest present but no credentials/token: still NOT registered", async () => {
  seedManifest(workspace);
  process.env.HOME = home; // empty config dir -> no token
  process.env.PATH = path.join(home, "empty-bin"); // and no rclone to fall back on
  fs.mkdirSync(path.join(home, "empty-bin"), { recursive: true });
  // The keys must be absent, not empty strings: resolveCredentials() checks
  // presence, and "" would still be falsy but would change os-level env state.
  // biome-ignore lint/performance/noDelete: intentional env removal
  delete process.env.GDRIVE_PUBLISH_CLIENT_ID;
  // biome-ignore lint/performance/noDelete: intentional env removal
  delete process.env.GDRIVE_PUBLISH_CLIENT_SECRET;
  const loaded = await load(workspace);
  assert.deepEqual(
    loaded.tools.map((t) => t.name),
    [],
  );
});

test("manifest + cached token: the tool IS registered", async () => {
  seedManifest(workspace);
  const { clientHash } = await import("../core/auth.ts");
  process.env.HOME = home;
  process.env.GDRIVE_PUBLISH_CLIENT_ID = "ext-test-client";
  process.env.GDRIVE_PUBLISH_CLIENT_SECRET = "ext-test-secret";
  const dir = path.join(home, ".config", "gdrive-publish");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `token-${clientHash("ext-test-client")}.json`),
    JSON.stringify({
      clientHash: clientHash("ext-test-client"),
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    }),
  );
  const loaded = await load(workspace);
  assert.deepEqual(
    loaded.tools.map((t) => t.name),
    ["gdrive_publish"],
  );
  assert.ok(loaded.events.includes("session_start"));
  assert.ok(loaded.events.includes("session_shutdown"));
});

test("a manifest in a parent directory also counts", async () => {
  seedManifest(workspace);
  const { clientHash } = await import("../core/auth.ts");
  process.env.HOME = home;
  process.env.GDRIVE_PUBLISH_CLIENT_ID = "ext-test-client";
  process.env.GDRIVE_PUBLISH_CLIENT_SECRET = "ext-test-secret";
  const cfg = path.join(home, ".config", "gdrive-publish");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, `token-${clientHash("ext-test-client")}.json`),
    JSON.stringify({
      clientHash: "x",
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    }),
  );
  const nested = path.join(workspace, "guide", "deeper");
  fs.mkdirSync(nested, { recursive: true });
  const loaded = await load(nested);
  assert.deepEqual(
    loaded.tools.map((t) => t.name),
    ["gdrive_publish"],
  );
});

test("a .git boundary stops the upward manifest search", async () => {
  // repo/  (has .git, no manifest)  <- search must stop here
  //   docs/ (cwd)
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  const docs = path.join(workspace, "docs");
  fs.mkdirSync(docs, { recursive: true });
  process.env.HOME = home;
  const loaded = await load(docs);
  assert.deepEqual(
    loaded.tools.map((t) => t.name),
    [],
  );
});

// ---------------------------------------------------------------------------
// write gating on the registered tool
// ---------------------------------------------------------------------------

async function readyTool(): Promise<StubTool> {
  seedManifest(workspace);
  const { clientHash } = await import("../core/auth.ts");
  process.env.HOME = home;
  process.env.GDRIVE_PUBLISH_CLIENT_ID = "ext-test-client";
  process.env.GDRIVE_PUBLISH_CLIENT_SECRET = "ext-test-secret";
  const cfg = path.join(home, ".config", "gdrive-publish");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, `token-${clientHash("ext-test-client")}.json`),
    JSON.stringify({
      clientHash: clientHash("ext-test-client"),
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
    }),
  );
  fs.writeFileSync(path.join(workspace, "a.md"), "# A\n");
  const loaded = await load(workspace);
  const tool = loaded.tools[0];
  assert.ok(tool, "expected the tool to be registered");
  return tool;
}

function stubCtx(hasUI: boolean, confirmAnswer: boolean) {
  const prompts: string[] = [];
  return {
    ctx: {
      cwd: workspace,
      hasUI,
      ui: {
        notify: () => {},
        setStatus: () => {},
        confirm: async (title: string, message: string) => {
          prompts.push(`${title}|${message}`);
          return confirmAnswer;
        },
      },
    },
    prompts,
  };
}

const firstText = (r: { content: { text: string }[] }) => r.content[0]?.text ?? "";

test("mode=plan is read-only and never prompts", async () => {
  const tool = await readyTool();
  const { ctx, prompts } = stubCtx(true, false);
  const result = await tool.execute("1", { mode: "plan" }, undefined, undefined, ctx);
  assert.match(firstText(result), /1 to create/);
  assert.deepEqual(prompts, [], "planning must not ask for confirmation");
});

test("mode=publish refuses in a non-interactive session without assumeYes", async () => {
  const tool = await readyTool();
  const { ctx } = stubCtx(false, false);
  const result = await tool.execute("2", { mode: "publish" }, undefined, undefined, ctx);
  assert.match(firstText(result), /refusing to publish without confirmation/);
  assert.match(firstText(result), /assumeYes/);
});

test("mode=publish cancels when the user declines the prompt", async () => {
  const tool = await readyTool();
  const { ctx, prompts } = stubCtx(true, false);
  const result = await tool.execute("3", { mode: "publish" }, undefined, undefined, ctx);
  assert.match(firstText(result), /cancelled by the user/);
  assert.equal(prompts.length, 1, "exactly one confirmation prompt");
  assert.match(prompts[0] ?? "", /Publish to Google Drive\?/);
});

test("the confirmation prompt states what will happen, including prune", async () => {
  const tool = await readyTool();
  const { ctx, prompts } = stubCtx(true, false);
  await tool.execute("4", { mode: "publish", prune: true }, undefined, undefined, ctx);
  assert.match(prompts[0] ?? "", /to create/);
  assert.match(prompts[0] ?? "", /will be trashed/, "prune must be spelled out before approval");
});

test("the tool description tells the model plan is read-only", async () => {
  const tool = await readyTool();
  assert.match(tool.description, /plan/i);
  assert.match(tool.description, /read-only|no writes/i);
});
