import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createEnvelope, sha256Utf8, type RawEnvelope } from "./envelope.ts";

export const GROK_BUILD_SOURCE = "grok-build" as const;

export interface GrokBuildSourceSession {
  sourceKind: "grok-build";
  sessionId: string;
  cwd: string;
  title: string;
  archiveState: "unknown";
  archiveProvenance: "grok-build-package-has-no-archive-flag";
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  sourcePath: string;
  transcriptPath: string;
  transcriptExists: true;
  transcriptStatus: "available";
}

export interface GrokBuildInventory {
  sourceRoot: string;
  sessions: GrokBuildSourceSession[];
  unreadableRecords: string[];
}

export interface GrokBuildSummary {
  info?: { id?: unknown; cwd?: unknown };
  agent_id?: unknown;
  agent_name?: unknown;
  attempt_id?: unknown;
  generated_title?: unknown;
  session_summary?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  last_active_at?: unknown;
  grok_home?: unknown;
  chat_format_version?: unknown;
  [key: string]: unknown;
}

export interface GrokBuildSessionPackage {
  sourcePath: string;
  summaryPath: string;
  updatesPath: string;
  chatHistoryPath: string | null;
  contentSha256: string;
  summary: GrokBuildSummary;
  records: RawEnvelope[];
  title: string | null;
  sessionId: string;
  cwd: string;
  firstTsMs: number | null;
  lastTsMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function resolveGrokBuildHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.GROK_HOME?.trim() || process.env.GROK_BUILD_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".grok");
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function isGrokBuildSessionDir(directory: string): boolean {
  return fs.existsSync(path.join(directory, "summary.json")) &&
    fs.existsSync(path.join(directory, "updates.jsonl"));
}

function sessionDirFrom(root: string): string | null {
  const resolved = path.resolve(root);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      const parent = path.dirname(resolved);
      return isGrokBuildSessionDir(parent) ? parent : null;
    }
    if (stat.isDirectory() && isGrokBuildSessionDir(resolved)) return resolved;
  } catch {
    return null;
  }
  return null;
}

function collectSessionDirs(root: string): string[] {
  const direct = sessionDirFrom(root);
  if (direct) return [direct];
  const resolved = path.resolve(root);
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (isGrokBuildSessionDir(directory)) {
      found.push(directory);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        visit(path.join(directory, entry.name), depth + 1);
      }
    }
  };
  if (fs.existsSync(resolved)) visit(resolved, 0);
  return [...new Set(found)].sort();
}

function packageHash(summaryPath: string, updatesPath: string): string {
  return sha256Utf8(`summary:${sha256File(summaryPath)}\0updates:${sha256File(updatesPath)}`);
}

export function readGrokBuildSession(sessionDir: string): GrokBuildSessionPackage {
  const resolved = path.resolve(sessionDir);
  const summaryPath = path.join(resolved, "summary.json");
  const updatesPath = path.join(resolved, "updates.jsonl");
  const chatHistoryPath = path.join(resolved, "chat_history.jsonl");
  if (!fs.existsSync(summaryPath) || !fs.existsSync(updatesPath)) {
    throw new Error(`Grok Build session is missing summary.json or updates.jsonl: ${resolved}`);
  }
  const summaryRaw = fs.readFileSync(summaryPath, "utf8");
  let summary: GrokBuildSummary;
  try {
    summary = JSON.parse(summaryRaw) as GrokBuildSummary;
  } catch (error) {
    throw new Error(`Grok Build summary.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (summary == null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Grok Build summary.json must be a JSON object");
  }
  const info = asRecord(summary.info) ?? {};
  const sessionId = stringOrNull(info.id);
  if (sessionId == null) throw new Error("Grok Build summary.json is missing info.id");
  const cwd = stringOrNull(info.cwd) ?? "";
  const title = stringOrNull(summary.generated_title) ?? stringOrNull(summary.session_summary);
  const updatesRaw = fs.readFileSync(updatesPath, "utf8");
  const records: RawEnvelope[] = [];
  const lines = updatesRaw.split(/\r?\n/);
  let firstTsMs: number | null = parseTimeMs(summary.created_at);
  let lastTsMs: number | null = parseTimeMs(summary.last_active_at) ?? parseTimeMs(summary.updated_at);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (rawLine === "" && index === lines.length - 1) continue;
    if (rawLine === "") continue;
    const lineEnding = updatesRaw.includes("\r\n") ? "\r\n" as const : "\n" as const;
    const envelope = createEnvelope(GROK_BUILD_SOURCE, rawLine, {
      sourcePath: updatesPath,
      recordIndex: records.length,
      lineEnding,
    });
    records.push(envelope);
    const parsed = asRecord(envelope.parsed);
    const timestamp = parseTimeMs(parsed?.timestamp);
    if (timestamp != null) {
      if (firstTsMs == null || timestamp < firstTsMs) firstTsMs = timestamp;
      if (lastTsMs == null || timestamp > lastTsMs) lastTsMs = timestamp;
    }
  }
  return {
    sourcePath: resolved,
    summaryPath,
    updatesPath,
    chatHistoryPath: fs.existsSync(chatHistoryPath) ? chatHistoryPath : null,
    contentSha256: packageHash(summaryPath, updatesPath),
    summary,
    records,
    title,
    sessionId,
    cwd,
    firstTsMs,
    lastTsMs,
  };
}

function sessionFromPackage(pack: GrokBuildSessionPackage): GrokBuildSourceSession {
  return {
    sourceKind: "grok-build",
    sessionId: pack.sessionId,
    cwd: pack.cwd,
    title: pack.title ?? pack.sessionId,
    archiveState: "unknown",
    archiveProvenance: "grok-build-package-has-no-archive-flag",
    createdAtMs: pack.firstTsMs,
    lastActivityAtMs: pack.lastTsMs,
    sourcePath: pack.sourcePath,
    transcriptPath: pack.updatesPath,
    transcriptExists: true,
    transcriptStatus: "available",
  };
}

export function inventoryGrokBuild(root: string): GrokBuildInventory {
  const sourceRoot = path.resolve(root);
  const unreadableRecords: string[] = [];
  const candidates: GrokBuildSourceSession[] = [];
  for (const directory of collectSessionDirs(sourceRoot)) {
    try {
      candidates.push(sessionFromPackage(readGrokBuildSession(directory)));
    } catch {
      unreadableRecords.push(directory);
    }
  }
  const byId = new Map<string, GrokBuildSourceSession[]>();
  for (const session of candidates) {
    const matches = byId.get(session.sessionId) ?? [];
    matches.push(session);
    byId.set(session.sessionId, matches);
  }
  const sessions: GrokBuildSourceSession[] = [];
  for (const matches of byId.values()) {
    if (matches.length !== 1) {
      unreadableRecords.push(...matches.map((session) => session.sourcePath));
      continue;
    }
    sessions.push(matches[0]!);
  }
  sessions.sort((left, right) =>
    (right.lastActivityAtMs ?? -Infinity) - (left.lastActivityAtMs ?? -Infinity) ||
    left.sessionId.localeCompare(right.sessionId));
  return { sourceRoot, sessions, unreadableRecords: unreadableRecords.sort() };
}

export function grokBuildSessionIdentityError(
  source: GrokBuildSourceSession,
  pack: GrokBuildSessionPackage,
): string | null {
  if (pack.sessionId !== source.sessionId) {
    return "Grok Build session id does not match its inventoried identity";
  }
  if (pack.cwd !== source.cwd) {
    return "Grok Build session cwd is missing, inconsistent, or changed after inventory";
  }
  return null;
}
