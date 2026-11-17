import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inventoryGrokBuild, readGrokBuildSession } from "../src/grok-build-source.ts";
import { grokBuildSessionToIr } from "../src/grok-build-to-ir.ts";
import { parseRollout } from "../src/codex-source.ts";
import { main } from "../src/matrix-cli.ts";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function writeGrokBuildSession(root: string, cwd: string): string {
  const sessionDir = path.join(root, SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
    info: { id: SESSION_ID, cwd },
    agent_id: "ag1.test",
    agent_name: "synthetic-agent",
    attempt_id: "at1.test",
    chat_format_version: 1,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:30Z",
    last_active_at: "2026-11-01T00:00:30Z",
    generated_title: "Synthetic Grok Build session",
    session_summary: "A redacted fixture",
    num_messages: 6,
    num_chat_messages: 3,
    current_model_id: "grok-4.7",
    next_trace_turn: 0,
    grok_home: "/tmp/.grok",
    sandbox_profile: "off",
  }, null, 2) + "\n", "utf8");
  const toolMeta = { name: "Shell", kind: "execute", label: "Shell", namespace: "cursor", read_only: false, version: "1" };
  const updates = [
    { timestamp: 1761955200, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e1", agentTimestampMs: 1761955200000 }, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Please inspect the repo." }, _meta: { modelId: "grok-4.7", promptIndex: 0 } } } },
    { timestamp: 1761955201, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e2", agentTimestampMs: 1761955201000 }, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should list files first." } } } },
    { timestamp: 1761955202, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e3", agentTimestampMs: 1761955202000 }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I will " } } } },
    { timestamp: 1761955203, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e4", agentTimestampMs: 1761955203000 }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "run a listing." } } } },
    { timestamp: 1761955204, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e5", agentTimestampMs: 1761955204000 }, update: { sessionUpdate: "tool_call", toolCallId: "call_ls", title: "Shell", rawInput: { command: "ls", description: "list files" }, _meta: { "x.ai/tool": toolMeta } } } },
    { timestamp: 1761955205, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e6", agentTimestampMs: 1761955205000 }, update: { sessionUpdate: "tool_call_update", toolCallId: "call_ls", kind: "execute", title: "Shell", status: "completed", rawInput: { command: "ls", description: "list files" }, content: [{ type: "content", content: { type: "text", text: "README.md" } }], _meta: { "x.ai/tool": toolMeta } } } },
    { timestamp: 1761955206, method: "session/update", params: { sessionId: SESSION_ID, _meta: { eventId: "e7", agentTimestampMs: 1761955206000 }, update: { sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" } } },
  ];
  fs.writeFileSync(path.join(sessionDir, "updates.jsonl"), updates.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return sessionDir;
}

test("Grok Build inventory uses summary.json plus updates.jsonl as the package identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-build-source-"));
  const cwd = path.join(root, "repo");
  const sessionDir = writeGrokBuildSession(root, cwd);
  const inventory = inventoryGrokBuild(root);
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0]?.sessionId, SESSION_ID);
  assert.equal(inventory.sessions[0]?.sourceKind, "grok-build");
  assert.equal(inventory.sessions[0]?.cwd, cwd);
  assert.equal(inventory.sessions[0]?.title, "Synthetic Grok Build session");
  assert.equal(inventory.sessions[0]?.archiveState, "unknown");
  assert.equal(inventory.sessions[0]?.sourcePath, sessionDir);
  assert.deepEqual(inventory.unreadableRecords, []);
});

test("Grok Build IR concatenates message chunks and pairs tool calls by id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-build-ir-"));
  const pack = readGrokBuildSession(writeGrokBuildSession(root, path.join(root, "repo")));
  const bundle = grokBuildSessionToIr(pack);
  assert.equal(bundle.conversation.source, "grok-build");
  assert.equal(bundle.conversation.sourceSessionId, SESSION_ID);
  const texts = bundle.conversation.events.filter((event) => event.kind === "text");
  assert.deepEqual(texts.map((event) => ({ role: event.role, text: event.text })), [
    { role: "user", text: "Please inspect the repo." },
    { role: "assistant", text: "I will run a listing." },
  ]);
  const thought = bundle.conversation.events.find((event) => event.kind === "reasoning");
  assert.equal(thought?.kind === "reasoning" && thought.summary, "I should list files first.");
  const toolUse = bundle.conversation.events.find((event) => event.kind === "tool_use");
  const toolResult = bundle.conversation.events.find((event) => event.kind === "tool_result");
  assert.equal(toolUse?.kind === "tool_use" && toolUse.name, "Shell");
  assert.equal(toolUse?.kind === "tool_use" && toolUse.toolUseId, "call_ls");
  assert.equal(toolResult?.kind === "tool_result" && toolResult.content, "README.md");
  assert.equal(bundle.conversation.events.every((event) => event.safety.execute === false), true);
});

test("Grok Build to Codex CLI plan v7 applies in an isolated CODEX_HOME", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-build-cli-matrix-"));
  const grokHome = path.join(root, ".grok");
  const cwd = path.join(root, "repo");
  writeGrokBuildSession(grokHome, cwd);
  const codexHome = path.join(root, ".codex");
  const bridgeRoot = path.join(root, "bridge");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");
  const codexBin = path.join(root, "codex-version");
  fs.writeFileSync(codexBin, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.166.0'\n", "utf8");
  fs.chmodSync(codexBin, 0o700);
  const planPath = path.join(root, "plan.json");
  main([
    "plan", "--source", "grok-build", "--grok-build-home", grokHome, "--archive", "all",
    "--codex-home", codexHome, "--bridge-root", bridgeRoot,
    "--codex-cli-bin", codexBin, "--out", planPath,
  ]);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    schema: string; digest: string; sourceKind: string; direction: string; targetKind: string;
    plan: { sessions: Array<{ sessionId: string }> };
  };
  assert.equal(plan.schema, "agentryx.import-plan/v7");
  assert.equal(plan.direction, "grok-build-to-codex");
  assert.equal(plan.sourceKind, "grok-build");
  assert.equal(plan.targetKind, "codex-cli");
  assert.equal(plan.plan.sessions[0]?.sessionId, SESSION_ID);
  main([
    "apply", "--plan", planPath, "--confirm", plan.digest,
    "--codex-cli-bin", codexBin, "--out", path.join(root, "apply.json"),
  ]);
  const apply = JSON.parse(fs.readFileSync(path.join(root, "apply.json"), "utf8")) as {
    applied: number; sessions: Array<{ rolloutPath: string }>;
  };
  assert.equal(apply.applied, 1);
  const parsed = parseRollout(apply.sessions[0]!.rolloutPath, { useCodexCompaction: false });
  assert.ok(parsed);
  assert.equal(parsed.meta.originator, "codex_cli_rs");
  assert.ok(parsed.messageCount >= 2);
});
