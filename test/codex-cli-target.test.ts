import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseRollout } from "../src/codex-source.ts";
import { main } from "../src/matrix-cli.ts";
import { detectCodexCliRuntime, planCodexCliTarget, applyCodexCliTarget } from "../src/codex-cli-target.ts";

test("Codex CLI rollout publishing is atomic, idempotent, and never overwrites collisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-target-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const runtime = {
    version: "0.166.0", modelProvider: "custom",
    executablePath: "/usr/bin/codex", executableSha256: "b".repeat(64),
  };
  const plan = planCodexCliTarget(codexHome, "source-session", "a".repeat(64), {
    cwd: root,
    title: "Imported history",
    createdAt: "2026-11-03T00:00:00.000Z",
    messages: [
      { role: "user", text: "original question" },
      { role: "assistant", text: "original answer" },
    ],
  }, runtime);

  assert.equal(fs.existsSync(plan.rolloutPath), false);
  assert.equal(applyCodexCliTarget(plan), "applied");
  const parsed = parseRollout(plan.rolloutPath, { useCodexCompaction: false });
  assert.ok(parsed);
  assert.equal(parsed.sessionId, plan.targetThreadId);
  assert.equal(parsed.meta.cli_version, "0.166.0");
  assert.equal(parsed.meta.originator, "codex_cli_rs");
  assert.equal(parsed.meta.source, "cli");
  assert.equal(parsed.meta.model_provider, "custom");
  assert.equal(parsed.messageCount, 2);
  assert.equal(applyCodexCliTarget(plan), "already-applied");

  fs.writeFileSync(plan.rolloutPath, "external content\n", "utf8");
  assert.throws(() => applyCodexCliTarget(plan), /rollout collision/);
  assert.equal(fs.readFileSync(plan.rolloutPath, "utf8"), "external content\n");
});

test("Codex CLI source-to-target plan v6 applies in an isolated CODEX_HOME", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-matrix-"));
  const claudeHome = path.join(root, ".claude");
  const codexHome = path.join(root, ".codex");
  const bridgeRoot = path.join(root, "bridge");
  const cwd = path.join(root, "repo");
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const transcript = path.join(claudeHome, "projects", "-repo", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "user", sessionId, cwd, timestamp: "2026-11-02T23:59:00.000Z",
      message: { role: "user", content: "How does this session resume?" },
    }),
    JSON.stringify({
      type: "assistant", sessionId, cwd, timestamp: "2026-11-02T23:59:05.000Z",
      message: { role: "assistant", content: "From the native rollout file." },
    }),
  ].join("\n") + "\n", "utf8");

  const codexBin = path.join(root, "codex-version");
  fs.writeFileSync(codexBin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.166.0'\n", "utf8");
  fs.chmodSync(codexBin, 0o700);
  const planPath = path.join(root, "plan.json");
  main([
    "plan", "--claude-source", "code", "--codex-target", "cli", "--archive", "all",
    "--claude-home", claudeHome, "--codex-home", codexHome, "--bridge-root", bridgeRoot,
    "--codex-cli-bin", codexBin, "--out", planPath,
  ]);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    schema: string; digest: string; sourceKind: string; targetKind: string;
    target: {
      cliVersion: string; modelProvider: string; cliExecutablePath: string; cliExecutableSha256: string;
      sessions: Array<{ rolloutPath: string }>;
    };
    plan: { losses: { sessions: Array<{ sessionId: string; byKind: Array<{ kind: string }> }> } };
  };
  assert.equal(plan.schema, "agentryx.import-plan/v6");
  assert.equal(plan.sourceKind, "claude-code");
  assert.equal(plan.targetKind, "codex-cli");
  assert.equal(plan.target.cliVersion, "0.166.0");
  assert.equal(plan.target.modelProvider, "custom");
  assert.equal(plan.target.cliExecutablePath, fs.realpathSync.native(codexBin));
  assert.match(plan.target.cliExecutableSha256, /^[0-9a-f]{64}$/);
  assert.ok(plan.plan.losses.sessions[0]?.byKind.some((loss) => loss.kind === "source_archive_state_unknown"));
  assert.equal(fs.existsSync(plan.target.sessions[0]!.rolloutPath), false);

  main([
    "apply", "--plan", planPath, "--confirm", plan.digest,
    "--codex-cli-bin", codexBin,
  ]);
  const rollout = parseRollout(plan.target.sessions[0]!.rolloutPath, { useCodexCompaction: false });
  assert.ok(rollout);
  assert.equal(rollout.sessionId, rollout.meta.id);
  assert.equal(rollout.source, "cli");
  assert.equal(rollout.messageCount, 2);
  assert.equal(fs.existsSync(path.join(bridgeRoot, "conversations", sessionId, "latest.json")), true);
  assert.throws(() => main([
    "apply", "--plan", planPath, "--confirm", plan.digest,
    "--codex-cli-bin", codexBin, "--allow-overwrite",
  ]), /never overwrites/);
});

test("Codex CLI runtime detection captures a simple top-level model provider", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-"));
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    'model_provider = "custom"',
    "[model_providers]",
    'openai = { name = "ignored" }',
    "",
  ].join("\n"), "utf8");
  const codexBin = path.join(root, "codex-version");
  fs.writeFileSync(codexBin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.166.0'\n", "utf8");
  fs.chmodSync(codexBin, 0o700);
  const runtime = detectCodexCliRuntime(codexHome, { executable: codexBin });
  assert.equal(runtime.version, "0.166.0");
  assert.equal(runtime.modelProvider, "custom");
  assert.equal(runtime.executablePath, fs.realpathSync.native(codexBin));
  assert.match(runtime.executableSha256, /^[0-9a-f]{64}$/);
});
