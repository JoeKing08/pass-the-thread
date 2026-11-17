import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { inventoryDsh, readDshSessionLog } from "../src/dsh-source.ts";
import { dshSessionToIr } from "../src/dsh-to-ir.ts";
import { parseRollout } from "../src/codex-source.ts";
import { main } from "../src/matrix-cli.ts";

const SESSION_ID = "session-11111111-1111-4111-8111-111111111111";

function syntheticDshLog(cwd: string, sessionId = SESSION_ID): string {
  return [
    { type: "session", version: 4, id: sessionId, createdAt: 1760000000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard" },
    {
      type: "user/message", seq: 0, time: 1760000001000, surfaceOp: "append",
      data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Hello from a synthetic user" }] },
    },
    {
      type: "user/message", seq: 1, time: 1760000001500, surfaceOp: "append",
      data: { id: "u2", role: "user", source: { kind: "runtime-context" }, content: [{ type: "text", text: "workspace snapshot" }] },
    },
    {
      type: "assistant/message", seq: 2, time: 1760000002000, surfaceOp: "append",
      data: {
        turn: 1, step: 1, stream: [], usage: {},
        message: {
          id: "a1", role: "assistant", source: { kind: "assistant" },
          content: [{ type: "reasoning", text: "planning a lookup" }, { type: "text", text: "I will look that up." }],
        },
      },
    },
    {
      type: "tool/call", seq: 3, time: 1760000003000,
      data: { callId: "call_1", name: "read", arguments: '{"path":"README.md"}', step: 1, turn: 1 },
    },
    {
      type: "tool/result", seq: 4, time: 1760000004000, sourceEventSeqs: [3], surfaceOp: "append",
      data: {
        message: {
          id: "tr1", role: "tool", toolCallId: "call_1", isError: false, source: { kind: "tool" },
          content: [{ type: "text", text: "ok" }],
        },
      },
    },
    {
      type: "session/title", seq: 5, time: 1760000005000,
      data: { title: "Synthetic DSH session", source: { kind: "fallback" }, messageSeqs: [0] },
    },
    {
      type: "compaction/summary", seq: 6, time: 1760000006000,
      data: { compactionId: "c1", summary: "Earlier turns were compacted.", shadowedTokenCount: 12, turn: 1 },
    },
    {
      type: "goal/change", seq: 7, time: 1760000007000,
      data: { operation: "create", kind: "goal/change", goal: "Finish the import", version: 1, createdAt: 1760000007000, updatedAt: 1760000007000, roundsStarted: 0 },
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function writeDshSession(root: string, cwd: string, compressed = true): string {
  const sessionDir = path.join(root, "sessions", "--tmp-demo-repo--", SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const jsonl = syntheticDshLog(cwd);
  const filePath = path.join(sessionDir, compressed ? "session.v4.jsonl.zstd" : "session.v4.jsonl");
  if (compressed) {
    const headerLine = jsonl.slice(0, jsonl.indexOf("\n") + 1);
    const rest = jsonl.slice(headerLine.length);
    fs.writeFileSync(filePath, Buffer.concat([zstdCompressSync(Buffer.from(headerLine)), zstdCompressSync(Buffer.from(rest))]));
  } else {
    fs.writeFileSync(filePath, jsonl);
  }
  return filePath;
}

test("DSH inventory reads the highest session log and reports unknown archive state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-source-"));
  const cwd = path.join(root, "demo-repo");
  const logPath = writeDshSession(root, cwd, true);
  const inventory = inventoryDsh(root);
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0]?.sessionId, SESSION_ID);
  assert.equal(inventory.sessions[0]?.sourceKind, "dsh");
  assert.equal(inventory.sessions[0]?.cwd, cwd);
  assert.equal(inventory.sessions[0]?.title, "Synthetic DSH session");
  assert.equal(inventory.sessions[0]?.archiveState, "unknown");
  assert.equal(inventory.sessions[0]?.sourcePath, logPath);
  assert.deepEqual(inventory.unreadableRecords, []);
});

test("DSH IR maps user, context, assistant, tools, compaction, and goals without executing tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ir-"));
  const cwd = path.join(root, "demo-repo");
  const filePath = writeDshSession(root, cwd, false);
  const log = readDshSessionLog(filePath);
  const bundle = dshSessionToIr(log);
  assert.equal(bundle.conversation.source, "dsh");
  assert.equal(bundle.conversation.sourceSessionId, SESSION_ID);
  assert.equal(bundle.conversation.title, "Synthetic DSH session");
  const texts = bundle.conversation.events.filter((event) => event.kind === "text");
  assert.deepEqual(texts.map((event) => ({ role: event.role, authoredByHuman: event.authoredByHuman, text: event.text })), [
    { role: "user", authoredByHuman: true, text: "Hello from a synthetic user" },
    { role: "system", authoredByHuman: false, text: "workspace snapshot" },
    { role: "assistant", authoredByHuman: false, text: "I will look that up." },
  ]);
  assert.equal(bundle.conversation.events.filter((event) => event.kind === "reasoning").length, 1);
  const toolUse = bundle.conversation.events.find((event) => event.kind === "tool_use");
  const toolResult = bundle.conversation.events.find((event) => event.kind === "tool_result");
  assert.equal(toolUse?.kind === "tool_use" && toolUse.toolUseId, "call_1");
  assert.equal(toolUse?.kind === "tool_use" && toolUse.name, "read");
  assert.deepEqual(toolUse?.kind === "tool_use" ? toolUse.input : null, { path: "README.md" });
  assert.equal(toolResult?.kind === "tool_result" && toolResult.toolUseId, "call_1");
  assert.equal(toolResult?.kind === "tool_result" && toolResult.content, "ok");
  const compact = bundle.conversation.events.find((event) => event.kind === "compact_boundary");
  assert.equal(compact?.kind === "compact_boundary" && compact.activeContextStartsAfter, true);
  assert.equal(bundle.conversation.goalState?.objective, "Finish the import");
  assert.equal(bundle.conversation.goalState?.status, "active");
  assert.equal(bundle.conversation.events.every((event) => event.safety.execute === false), true);
});

test("DSH to Codex CLI plan v7 applies in an isolated CODEX_HOME", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cli-matrix-"));
  const dshHome = path.join(root, ".dsh");
  const cwd = path.join(root, "demo-repo");
  writeDshSession(dshHome, cwd, true);
  const codexHome = path.join(root, ".codex");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");
  const codexBin = path.join(root, "codex-version");
  fs.writeFileSync(codexBin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.166.0'\n", "utf8");
  fs.chmodSync(codexBin, 0o700);
  const planPath = path.join(root, "plan.json");
  main([
    "plan", "--source", "dsh", "--dsh-home", dshHome, "--archive", "all",
    "--codex-home", codexHome, "--bridge-root", bridgeRoot,
    "--codex-cli-bin", codexBin, "--out", planPath,
  ]);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    schema: string; digest: string; sourceKind: string; targetKind: string; direction: string;
    target: { cliVersion: string; modelProvider: string; sourceHome: string };
    plan: { sessions: Array<{ sessionId: string; archiveState: string }> };
  };
  assert.equal(plan.schema, "agentryx.import-plan/v7");
  assert.equal(plan.direction, "dsh-to-codex");
  assert.equal(plan.sourceKind, "dsh");
  assert.equal(plan.targetKind, "codex-cli");
  assert.equal(plan.target.cliVersion, "0.166.0");
  assert.equal(plan.target.modelProvider, "custom");
  assert.equal(plan.plan.sessions[0]?.sessionId, SESSION_ID);
  assert.equal(plan.plan.sessions[0]?.archiveState, "unknown");
  main([
    "apply", "--plan", planPath, "--confirm", plan.digest,
    "--codex-cli-bin", codexBin, "--out", path.join(root, "apply.json"),
  ]);
  const apply = JSON.parse(fs.readFileSync(path.join(root, "apply.json"), "utf8")) as {
    applied: number; sessions: Array<{ threadId: string; rolloutPath: string }>;
  };
  assert.equal(apply.applied, 1);
  const parsed = parseRollout(apply.sessions[0]!.rolloutPath, { useCodexCompaction: false });
  assert.ok(parsed);
  assert.equal(parsed.sessionId, apply.sessions[0]!.threadId);
  assert.equal(parsed.meta.source, "cli");
  assert.ok(parsed.messageCount >= 2);
});
