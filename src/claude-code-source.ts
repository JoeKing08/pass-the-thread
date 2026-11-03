import path from "node:path";

import { discoverClaudeTranscripts, readClaudeJsonl } from "./claude-source.ts";

export interface ClaudeCodeSourceSession {
  sourceKind: "claude-code";
  wrapperPath: null;
  wrapperSessionId: null;
  cliSessionId: string;
  sessionId: string;
  cwd: string;
  title: string;
  archiveState: "unknown";
  archiveProvenance: "claude-code-no-wrapper-archive-metadata";
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  transcriptPath: string | null;
  transcriptExists: boolean;
  transcriptStatus: "available" | "missing" | "unavailable" | "ambiguous";
}

export interface ClaudeCodeInventory {
  sourceRoot: string;
  sessions: ClaudeCodeSourceSession[];
  unreadableRecords: string[];
}

/**
 * Inventory native Claude Code project transcripts. Agent sidecars are already
 * excluded by discovery; the transcript identity must still agree with its
 * filename before it can be selected for import.
 */
export function inventoryClaudeCode(claudeHome: string): ClaudeCodeInventory {
  const sourceRoot = path.join(claudeHome, "projects");
  const unreadableRecords: string[] = [];
  const candidates: ClaudeCodeSourceSession[] = [];

  for (const transcriptPath of discoverClaudeTranscripts(claudeHome)) {
    let transcript: ReturnType<typeof readClaudeJsonl>;
    try {
      transcript = readClaudeJsonl(transcriptPath, { retainRecords: false });
    } catch {
      unreadableRecords.push(transcriptPath);
      continue;
    }
    const filenameId = path.basename(transcriptPath, ".jsonl");
    if (transcript.sessionId !== filenameId || transcript.sessionIds.length !== 1 ||
      transcript.sessionIds[0] !== filenameId || transcript.cwds.length !== 1 ||
      transcript.cwd == null) {
      unreadableRecords.push(transcriptPath);
      continue;
    }
    candidates.push({
      sourceKind: "claude-code",
      wrapperPath: null,
      wrapperSessionId: null,
      cliSessionId: filenameId,
      sessionId: filenameId,
      cwd: transcript.cwd,
      title: transcript.title ?? filenameId,
      archiveState: "unknown",
      archiveProvenance: "claude-code-no-wrapper-archive-metadata",
      createdAtMs: transcript.firstTsMs,
      lastActivityAtMs: transcript.lastTsMs,
      transcriptPath,
      transcriptExists: true,
      transcriptStatus: "available",
    });
  }

  const byId = new Map<string, ClaudeCodeSourceSession[]>();
  for (const session of candidates) {
    const matches = byId.get(session.sessionId) ?? [];
    matches.push(session);
    byId.set(session.sessionId, matches);
  }
  const sessions: ClaudeCodeSourceSession[] = [];
  for (const [sessionId, matches] of byId) {
    if (matches.length !== 1) {
      unreadableRecords.push(...matches.map((session) => session.transcriptPath!));
      continue;
    }
    sessions.push(matches[0]!);
  }
  sessions.sort((left, right) =>
    (right.lastActivityAtMs ?? -Infinity) - (left.lastActivityAtMs ?? -Infinity) ||
    left.sessionId.localeCompare(right.sessionId));
  return { sourceRoot, sessions, unreadableRecords: unreadableRecords.sort() };
}

export function claudeCodeTranscriptIdentityError(
  source: ClaudeCodeSourceSession,
  transcript: ReturnType<typeof readClaudeJsonl>,
): string | null {
  if (transcript.sessionIds.length !== 1 || transcript.sessionIds[0] !== source.cliSessionId) {
    return "transcript session id does not match its Claude Code source identity";
  }
  if (transcript.cwds.length !== 1 || transcript.cwd !== source.cwd) {
    return "transcript cwd is missing, inconsistent, or changed after inventory";
  }
  return null;
}
