import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { createEnvelope, type LineEnding, type RawEnvelope } from "./envelope.ts";

export interface ClaudeSourceTranscript {
  sourcePath: string;
  contentSha256: string;
  records: RawEnvelope[];
  sessionId: string | null;
  sessionIds: string[];
  cwd: string | null;
  cwds: string[];
  title: string | null;
}

/**
 * Visit a JSONL file one complete line at a time without first materialising
 * the whole file as a Buffer or string. The digest covers the exact bytes on
 * disk, including line terminators, so callers retain byte-level change
 * detection and sidecar guarantees.
 */
export function forEachClaudeUtf8LineSync(
  filePath: string,
  visit: (line: string, lineIndex: number, lineEnding: LineEnding) => void,
): string {
  const fd = fs.openSync(filePath, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = Buffer.alloc(0);
  let lineIndex = 0;

  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const current = chunk.subarray(0, bytesRead);
      hash.update(current);
      const data = pending.length === 0 ? current : Buffer.concat([pending, current]);
      let start = 0;

      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        let end = newline;
        if (end > start && data[end - 1] === 0x0d) end -= 1;
        // A complete line cannot contain a split UTF-8 sequence: if the
        // sequence straddled chunks it was retained in `pending` above.
        const line = decoder.decode(data.subarray(start, end));
        visit(line, lineIndex++, end < newline ? "\r\n" : "\n");
        start = newline + 1;
      }

      pending = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }

    if (pending.length > 0) {
      visit(decoder.decode(pending), lineIndex++, "");
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Read one transcript without normalising or dropping any source record. */
export interface ReadClaudeJsonlOptions {
  /** Keep parsed envelopes for conversion/sidecar generation. Default true. */
  retainRecords?: boolean;
}

export function readClaudeJsonl(
  sourcePath: string,
  options: ReadClaudeJsonlOptions = {},
): ClaudeSourceTranscript {
  const retainRecords = options.retainRecords !== false;
  const records: RawEnvelope[] = [];
  const firstValues = new Map<string, string>();
  const sessionValues = new Set<string>();
  const cwdValues = new Set<string>();
  let firstFallbackTitle: string | null = null;
  const sourceContentSha256 = (() => {
    try {
      return forEachClaudeUtf8LineSync(sourcePath, (raw, recordIndex, lineEnding) => {
        const envelope = createEnvelope("claude", raw, { sourcePath, recordIndex, lineEnding });
        if (retainRecords) records.push(envelope);
        const record = asRecord(envelope.parsed);
        if (record == null) return;
        for (const key of ["sessionId", "cwd"]) {
          const value = record[key];
          if (typeof value === "string" && value !== "") {
            if (!firstValues.has(key)) firstValues.set(key, value);
            (key === "sessionId" ? sessionValues : cwdValues).add(value);
          }
        }
        for (const key of ["customTitle", "aiTitle", "lastPrompt", "summary"]) {
          const value = record[key];
          if (typeof value === "string" && value !== "" && !firstValues.has(key)) firstValues.set(key, value);
        }
        if (firstFallbackTitle == null && record.type === "user" && record.isMeta !== true) {
          const origin = asRecord(record.origin);
          if (typeof origin?.kind !== "string" || origin.kind === "human") {
            const message = asRecord(record.message);
            const content = message?.content;
            if (typeof content === "string" && content.trim() !== "") firstFallbackTitle = content.trim().slice(0, 200);
            else if (Array.isArray(content)) {
              for (const block of content) {
                const item = asRecord(block);
                if (item?.type === "text" && typeof item.text === "string" && item.text.trim() !== "") {
                  firstFallbackTitle = item.text.trim().slice(0, 200);
                  break;
                }
              }
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Claude transcript is not valid UTF-8: ${sourcePath}`);
      throw error;
    }
  })();
  const title = ["customTitle", "aiTitle", "lastPrompt", "summary"]
    .map((key) => firstValues.get(key) ?? null)
    .find((value): value is string => value != null) ?? firstFallbackTitle;
  return {
    sourcePath,
    contentSha256: sourceContentSha256,
    records,
    sessionId: firstValues.get("sessionId") ?? null,
    sessionIds: [...sessionValues].sort(),
    cwd: firstValues.get("cwd") ?? null,
    cwds: [...cwdValues].sort(),
    title,
  };
}

/** Discover every Claude Code transcript; no implicit age or count cap is applied. */
export function discoverClaudeTranscripts(claudeHome: string): string[] {
  const root = path.join(claudeHome, "projects");
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(child);
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

export function scanClaudeSessions(
  claudeHome: string,
  options: ReadClaudeJsonlOptions = { retainRecords: false },
): ClaudeSourceTranscript[] {
  const sessions: ClaudeSourceTranscript[] = [];
  for (const sourcePath of discoverClaudeTranscripts(claudeHome)) {
    try {
      sessions.push(readClaudeJsonl(sourcePath, options));
    } catch {
      // Discovery may race with Claude rotating a file. A direct read still
      // throws; bulk scanning merely omits a path that no longer exists.
    }
  }
  return sessions;
}
