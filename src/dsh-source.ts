import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createEnvelope, sha256Utf8, type RawEnvelope } from "./envelope.ts";
import { decodeZstdFrameConcat } from "./zstd-frames.ts";

export const DSH_SOURCE = "dsh" as const;

const SESSION_LOG = /^(session(?:\.v(\d+))?\.jsonl)(\.zstd)?$/;

export interface DshSourceSession {
  sourceKind: "dsh";
  sessionId: string;
  cwd: string;
  title: string;
  archiveState: "unknown";
  archiveProvenance: "dsh-session-log-has-no-archive-flag";
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  sourcePath: string;
  transcriptPath: string;
  transcriptExists: true;
  transcriptStatus: "available";
  formatVersion: number;
}

export interface DshInventory {
  sourceRoot: string;
  sessions: DshSourceSession[];
  unreadableRecords: string[];
}

export interface DshSessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number | null;
  cwd: string | null;
  isSeeded?: boolean;
  delegationDepth?: number;
  agentPreset?: string | null;
}

export interface DshSessionRecord {
  type: string;
  seq: number;
  time: number | null;
  data: Record<string, unknown>;
  sourceEventSeqs?: unknown;
  surfaceOp?: unknown;
}

export interface DshSessionLog {
  sourcePath: string;
  contentSha256: string;
  raw: string;
  header: DshSessionHeader;
  records: RawEnvelope[];
  events: DshSessionRecord[];
  replacedSeqs: Set<number>;
  title: string | null;
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveDshHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.DSH_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".dsh");
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionLogName(fileName: string): { version: number; compressed: boolean } | null {
  const match = fileName.match(SESSION_LOG);
  if (!match) return null;
  return {
    version: match[2] == null ? 0 : Number(match[2]),
    compressed: match[3] != null,
  };
}

function preferredLogInDirectory(directory: string): string | null {
  let best: { path: string; version: number } | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const parsed = parseSessionLogName(entry.name);
    if (!parsed) continue;
    if (best == null || parsed.version > best.version ||
      (parsed.version === best.version && entry.name.endsWith(".zstd") && !best.path.endsWith(".zstd"))) {
      best = { path: path.join(directory, entry.name), version: parsed.version };
    }
  }
  return best?.path ?? null;
}

function collectCandidateLogs(root: string): string[] {
  const resolved = path.resolve(root);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return parseSessionLogName(path.basename(resolved)) ? [resolved] : [];
  }
  if (!stat.isDirectory()) return [];
  const direct = preferredLogInDirectory(resolved);
  if (direct) return [direct];

  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const preferred = preferredLogInDirectory(directory);
    if (preferred) {
      found.push(preferred);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        walk(path.join(directory, entry.name), depth + 1);
      }
    }
  };
  const sessionsRoot = path.join(resolved, "sessions");
  walk(fs.existsSync(sessionsRoot) ? sessionsRoot : resolved, 0);
  return found.sort();
}

function decodeSessionText(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  if (filePath.endsWith(".zstd")) {
    return decodeZstdFrameConcat(buffer).toString("utf8");
  }
  if (buffer.subarray(0, 4).readUInt32LE(0) === 0xFD2FB528) {
    return decodeZstdFrameConcat(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function parseHeader(value: unknown): DshSessionHeader {
  const record = asRecord(value);
  if (!record || record.type !== "session") {
    throw new Error("DSH session log is missing a type=session header");
  }
  const id = stringOrNull(record.id);
  const version = numberOrNull(record.version);
  if (id == null || version == null) {
    throw new Error("DSH session header is missing id or version");
  }
  return {
    type: "session",
    version,
    id,
    createdAt: numberOrNull(record.createdAt),
    cwd: stringOrNull(record.cwd),
    isSeeded: typeof record.isSeeded === "boolean" ? record.isSeeded : undefined,
    delegationDepth: numberOrNull(record.delegationDepth) ?? undefined,
    agentPreset: stringOrNull(record.agentPreset),
  };
}

function parseEvent(value: unknown): DshSessionRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string" || record.type === "") return null;
  const seq = numberOrNull(record.seq);
  if (seq == null || !Number.isInteger(seq)) return null;
  return {
    type: record.type,
    seq,
    time: numberOrNull(record.time),
    data: asRecord(record.data) ?? {},
    ...(record.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: record.sourceEventSeqs }),
    ...(record.surfaceOp === undefined ? {} : { surfaceOp: record.surfaceOp }),
  };
}

function replacedSeqsFrom(events: DshSessionRecord[]): Set<number> {
  const replaced = new Set<number>();
  for (const event of events) {
    const op = event.surfaceOp;
    if (typeof op === "string") continue;
    const record = asRecord(op);
    if (record?.op !== "replace") continue;
    const start = numberOrNull(record.startSeq);
    const end = numberOrNull(record.endSeq);
    if (start == null || end == null || end < start) continue;
    for (let seq = start; seq <= end; seq += 1) replaced.add(seq);
  }
  return replaced;
}

function titleFrom(events: DshSessionRecord[]): string | null {
  let title: string | null = null;
  for (const event of events) {
    if (event.type !== "session/title") continue;
    const next = stringOrNull(event.data.title);
    if (next) title = next;
  }
  return title;
}

export function readDshSessionLog(sourcePath: string): DshSessionLog {
  const resolved = path.resolve(sourcePath);
  const raw = decodeSessionText(resolved);
  const contentSha256 = sha256File(resolved);
  const lines = raw.split(/\r?\n/);
  const records: RawEnvelope[] = [];
  let recordIndex = 0;
  let header: DshSessionHeader | null = null;
  const events: DshSessionRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    if (rawLine === "" && index === lines.length - 1) continue;
    const lineEnding = index === lines.length - 1 && !raw.endsWith("\n") && !raw.endsWith("\r\n")
      ? "" as const
      : raw.includes("\r\n") ? "\r\n" as const : "\n" as const;
    const envelope = createEnvelope(DSH_SOURCE, rawLine, {
      sourcePath: resolved,
      recordIndex,
      lineEnding,
    });
    records.push(envelope);
    recordIndex += 1;
    if (envelope.parseError || envelope.parsed == null) {
      if (header == null) throw new Error(`DSH session header is not valid JSON: ${resolved}`);
      continue;
    }
    if (header == null) {
      header = parseHeader(envelope.parsed);
      continue;
    }
    const event = parseEvent(envelope.parsed);
    if (event) events.push(event);
  }
  if (header == null) throw new Error(`DSH session log is empty: ${resolved}`);
  let firstTsMs = header.createdAt;
  let lastTsMs = header.createdAt;
  for (const event of events) {
    if (event.time == null) continue;
    if (firstTsMs == null || event.time < firstTsMs) firstTsMs = event.time;
    if (lastTsMs == null || event.time > lastTsMs) lastTsMs = event.time;
  }
  return {
    sourcePath: resolved,
    contentSha256,
    raw,
    header,
    records,
    events,
    replacedSeqs: replacedSeqsFrom(events),
    title: titleFrom(events),
    firstTsMs,
    lastTsMs,
  };
}

function sessionFromLog(log: DshSessionLog): DshSourceSession {
  return {
    sourceKind: "dsh",
    sessionId: log.header.id,
    cwd: log.header.cwd ?? "",
    title: log.title ?? log.header.id,
    archiveState: "unknown",
    archiveProvenance: "dsh-session-log-has-no-archive-flag",
    createdAtMs: log.firstTsMs,
    lastActivityAtMs: log.lastTsMs,
    sourcePath: log.sourcePath,
    transcriptPath: log.sourcePath,
    transcriptExists: true,
    transcriptStatus: "available",
    formatVersion: log.header.version,
  };
}

export function inventoryDsh(root: string): DshInventory {
  const sourceRoot = path.resolve(root);
  const unreadableRecords: string[] = [];
  const candidates: DshSourceSession[] = [];
  for (const filePath of collectCandidateLogs(sourceRoot)) {
    try {
      candidates.push(sessionFromLog(readDshSessionLog(filePath)));
    } catch {
      unreadableRecords.push(filePath);
    }
  }
  const byId = new Map<string, DshSourceSession[]>();
  for (const session of candidates) {
    const matches = byId.get(session.sessionId) ?? [];
    matches.push(session);
    byId.set(session.sessionId, matches);
  }
  const sessions: DshSourceSession[] = [];
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

export function dshSessionIdentityError(source: DshSourceSession, log: DshSessionLog): string | null {
  if (log.header.id !== source.sessionId) {
    return "DSH session id does not match its inventoried identity";
  }
  if ((log.header.cwd ?? "") !== source.cwd) {
    return "DSH session cwd is missing, inconsistent, or changed after inventory";
  }
  return null;
}

/** Exported for tests that need a deterministic content hash of in-memory JSONL. */
export function dshContentSha256FromRaw(raw: string): string {
  return sha256Utf8(raw);
}
