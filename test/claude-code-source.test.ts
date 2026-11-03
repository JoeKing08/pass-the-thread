import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inventoryClaudeCode } from "../src/claude-code-source.ts";
import { main } from "../src/matrix-cli.ts";

function writeTranscript(filePath: string, sessionId: string, cwd: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: "user", sessionId, cwd, timestamp: "2026-10-01T12:00:00.000Z",
      message: { role: "user", content: "hello from Claude Code" },
    }),
    JSON.stringify({
      type: "assistant", sessionId, cwd, timestamp: "2026-10-01T12:00:02.000Z",
      message: { role: "assistant", content: "hello" },
    }),
  ].join("\n") + "\n", "utf8");
}

test("Claude Code inventory uses main project transcripts and excludes agent sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-source-"));
  const claudeHome = path.join(root, ".claude");
  const cwd = path.join(root, "repo");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const sessionPath = path.join(claudeHome, "projects", "-repo", `${sessionId}.jsonl`);
  writeTranscript(sessionPath, sessionId, cwd);
  writeTranscript(path.join(claudeHome, "projects", "-repo", "agent-child.jsonl"), sessionId, cwd);
  writeTranscript(path.join(claudeHome, "projects", "-repo", sessionId, "subagents", "agent-child.jsonl"), sessionId, cwd);

  const inventory = inventoryClaudeCode(claudeHome);
  assert.equal(inventory.sessions.length, 1);
  assert.equal(inventory.sessions[0]?.sessionId, sessionId);
  assert.equal(inventory.sessions[0]?.sourceKind, "claude-code");
  assert.equal(inventory.sessions[0]?.wrapperPath, null);
  assert.equal(inventory.sessions[0]?.wrapperSessionId, null);
  assert.equal(inventory.sessions[0]?.archiveState, "unknown");
  assert.equal(inventory.sessions[0]?.archiveProvenance, "claude-code-no-wrapper-archive-metadata");
  assert.equal(inventory.sessions[0]?.createdAtMs, Date.parse("2026-10-01T12:00:00.000Z"));
  assert.equal(inventory.sessions[0]?.lastActivityAtMs, Date.parse("2026-10-01T12:00:02.000Z"));
  assert.deepEqual(inventory.unreadableRecords, []);
});

test("Claude Code inventory fails closed on filename/record identity mismatch and duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-identity-"));
  const claudeHome = path.join(root, ".claude");
  const cwd = path.join(root, "repo");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const wrongId = "33333333-3333-4333-8333-333333333333";
  const mismatchPath = path.join(claudeHome, "projects", "-repo", `${sessionId}.jsonl`);
  writeTranscript(mismatchPath, wrongId, cwd);
  writeTranscript(path.join(claudeHome, "projects", "-worktree-a", `${wrongId}.jsonl`), wrongId, cwd);
  writeTranscript(path.join(claudeHome, "projects", "-worktree-b", `${wrongId}.jsonl`), wrongId, cwd);

  const inventory = inventoryClaudeCode(claudeHome);
  assert.deepEqual(inventory.sessions, []);
  assert.deepEqual(inventory.unreadableRecords.sort(), [
    mismatchPath,
    path.join(claudeHome, "projects", "-worktree-a", `${wrongId}.jsonl`),
    path.join(claudeHome, "projects", "-worktree-b", `${wrongId}.jsonl`),
  ].sort());
});

test("Claude Code scan keeps archive unknown and does not require Desktop wrapper records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-scan-"));
  const claudeHome = path.join(root, ".claude");
  const sessionId = "44444444-4444-4444-8444-444444444444";
  writeTranscript(path.join(claudeHome, "projects", "-repo", `${sessionId}.jsonl`), sessionId, path.join(root, "repo"));
  const out = path.join(root, "scan.json");
  main([
    "scan", "--direction", "claude-to-codex", "--claude-source", "code", "--archive", "all",
    "--claude-home", claudeHome, "--codex-home", path.join(root, "codex"), "--out", out,
  ]);
  const scan = JSON.parse(fs.readFileSync(out, "utf8")) as {
    sourceKind: string;
    inventory: { total: number; selected: number; active: number; archived: number; unknownArchive: number };
    selected: Array<{ sessionId: string; archiveState: string; archiveProvenance: string; sourcePath: string }>;
  };
  assert.equal(scan.sourceKind, "claude-code");
  assert.deepEqual(scan.inventory, { total: 1, selected: 1, active: 0, archived: 0, unknownArchive: 1, unavailable: 0 });
  assert.equal(scan.selected[0]?.sessionId, sessionId);
  assert.equal(scan.selected[0]?.archiveState, "unknown");
  assert.equal(scan.selected[0]?.archiveProvenance, "claude-code-no-wrapper-archive-metadata");
  assert.match(scan.selected[0]?.sourcePath ?? "", /\.claude[\\/]projects[\\/]/);
  assert.throws(() => main([
    "scan", "--claude-source", "code", "--archive", "active",
    "--claude-home", claudeHome, "--codex-home", path.join(root, "codex"),
  ]), /archive state is unknown/);
});
