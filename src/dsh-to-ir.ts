import { deterministicId, sha256Utf8, type RawEnvelope } from "./envelope.ts";
import {
  BRIDGE_IR_VERSION,
  HISTORICAL_SAFETY,
  type BridgeBundle,
  type BridgeEvent,
} from "./ir.ts";
import {
  createCanonicalGoalSnapshot,
  type CanonicalGoalSnapshot,
  type GoalLifecycleStatus,
} from "./goal.ts";
import type { DshSessionLog, DshSessionRecord } from "./dsh-source.ts";

type ObjectRecord = Record<string, unknown>;

function asRecord(value: unknown): ObjectRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRecord
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isoFromMs(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function base(envelope: RawEnvelope, path: string, kind: BridgeEvent["kind"], timestamp: string | null): {
  id: string;
  sourceEnvelopeId: string;
  path: string;
  timestamp: string | null;
  safety: typeof HISTORICAL_SAFETY;
} {
  return {
    id: deterministicId("bridge-event-v1", { envelopeId: envelope.id, path, kind }),
    sourceEnvelopeId: envelope.id,
    path,
    timestamp,
    safety: HISTORICAL_SAFETY,
  };
}

function sourceKindOf(data: ObjectRecord): string | null {
  const source = asRecord(data.source) ?? asRecord(asRecord(data.message)?.source);
  return stringOrNull(source?.kind);
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content === "" ? null : content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) => asRecord(block))
    .filter((block): block is ObjectRecord =>
      block != null && (block.type === "text" || typeof block.text === "string") && typeof block.text === "string")
    .map((block) => block.text as string);
  const text = parts.join("\n");
  return text === "" ? null : text;
}

function mediaEvents(
  envelope: RawEnvelope,
  content: unknown,
  role: BridgeEvent extends { kind: "media" } ? never : "user" | "assistant" | "system" | "unknown",
  authoredByHuman: boolean,
  timestamp: string | null,
): BridgeEvent[] {
  if (!Array.isArray(content)) return [];
  const events: BridgeEvent[] = [];
  content.forEach((block, index) => {
    const record = asRecord(block);
    if (!record || (record.type !== "image" && record.type !== "file" && record.type !== "audio")) return;
    events.push({
      ...base(envelope, `$.data.content[${index}]`, "media", timestamp),
      kind: "media",
      mediaType: record.type === "image" || record.type === "file" || record.type === "audio" ? record.type : "unknown",
      source: record.attachment ?? record,
      metadata: record,
      role,
      authoredByHuman,
    });
  });
  return events;
}

function parseJsonObject(value: unknown): unknown {
  if (value != null && typeof value === "object") return value;
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function goalStatus(operation: string | null, data: ObjectRecord): string | null {
  if (operation === "create" || operation === "resume") return "active";
  if (operation === "complete") return "complete";
  if (operation === "pause") return "paused";
  if (operation === "clear") return "cleared";
  return stringOrNull(data.status) ?? operation;
}

function authoritativeGoal(log: DshSessionLog): CanonicalGoalSnapshot | undefined {
  let latest: { event: DshSessionRecord; envelope: RawEnvelope } | null = null;
  for (const envelope of log.records) {
    const parsed = asRecord(envelope.parsed);
    if (parsed?.type !== "goal/change") continue;
    const event = log.events.find((candidate) => candidate.seq === parsed.seq);
    if (!event || log.replacedSeqs.has(event.seq)) continue;
    latest = { event, envelope };
  }
  if (!latest) return undefined;
  const operation = stringOrNull(latest.event.data.operation);
  const status = goalStatus(operation, latest.event.data);
  const objective = stringOrNull(latest.event.data.goal);
  if (objective == null) return undefined;
  if (status !== "active" && status !== "paused" && status !== "complete" && status !== "failed") {
    return undefined;
  }
  return createCanonicalGoalSnapshot({
    authority: "native-transcript",
    provider: "dsh",
    sourceThreadId: log.header.id,
    sourceGoalId: null,
    objective,
    status,
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: null,
    createdAtMs: numberOrNull(latest.event.data.createdAt) ?? latest.event.time,
    updatedAtMs: numberOrNull(latest.event.data.updatedAt) ?? latest.event.time,
    locator: {
      sourcePath: log.sourcePath,
      recordIndex: latest.envelope.recordIndex,
      table: null,
      key: null,
    },
    exactSourceSha256: latest.envelope.contentSha256,
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function protocol(
  envelope: RawEnvelope,
  event: DshSessionRecord,
  timestamp: string | null,
): BridgeEvent {
  return {
    ...base(envelope, "$.data", "protocol", timestamp),
    kind: "protocol",
    recordType: event.type,
    protocolType: event.type,
    payload: event.data,
  };
}

export function dshSessionToIr(log: DshSessionLog): BridgeBundle {
  const events: BridgeEvent[] = [];
  const envelopeBySeq = new Map<number, RawEnvelope>();
  for (const envelope of log.records) {
    const parsed = asRecord(envelope.parsed);
    const seq = typeof parsed?.seq === "number" ? parsed.seq : null;
    if (seq != null) envelopeBySeq.set(seq, envelope);
  }

  const compactEvents: DshSessionRecord[] = log.events.filter((event) =>
    event.type === "compaction/summary" && !log.replacedSeqs.has(event.seq));
  const lastCompactSeq = compactEvents.at(-1)?.seq;

  for (const event of log.events) {
    const envelope = envelopeBySeq.get(event.seq);
    if (!envelope) continue;
    if (log.replacedSeqs.has(event.seq)) continue;
    const timestamp = isoFromMs(event.time);
    if (event.type === "user/message") {
      const kind = sourceKindOf(event.data) ?? "user";
      const content = event.data.content;
      const authoredByHuman = kind === "user";
      const text = textFromContent(content);
      if (text) {
        events.push({
          ...base(envelope, "$.data.content", "text", timestamp),
          kind: "text",
          role: authoredByHuman ? "user" : "system",
          text,
          authoredByHuman,
        });
      }
      events.push(...mediaEvents(envelope, content, authoredByHuman ? "user" : "system", authoredByHuman, timestamp));
      continue;
    }
    if (event.type === "system/message") {
      const message = asRecord(event.data.message) ?? event.data;
      const text = textFromContent(message.content) ?? stringOrNull(message.text);
      if (text) {
        events.push({
          ...base(envelope, "$.data.message", "text", timestamp),
          kind: "text",
          role: "system",
          text,
          authoredByHuman: false,
        });
      }
      continue;
    }
    if (event.type === "assistant/message") {
      const message = asRecord(event.data.message) ?? event.data;
      const content = message.content;
      const text = textFromContent(Array.isArray(content)
        ? content.filter((block) => asRecord(block)?.type === "text")
        : content);
      if (Array.isArray(content)) {
        content.forEach((block, index) => {
          const record = asRecord(block);
          if (record?.type !== "reasoning") return;
          const summary = typeof record.text === "string" ? record.text : record;
          events.push({
            ...base(envelope, `$.data.message.content[${index}]`, "reasoning", timestamp),
            kind: "reasoning",
            summary,
            content: record,
          });
        });
      }
      if (text) {
        events.push({
          ...base(envelope, "$.data.message.content", "text", timestamp),
          kind: "text",
          role: "assistant",
          text,
          authoredByHuman: false,
        });
      }
      continue;
    }
    if (event.type === "tool/call") {
      const callId = stringOrNull(event.data.callId);
      const name = stringOrNull(event.data.name);
      const input = parseJsonObject(event.data.arguments);
      events.push({
        ...base(envelope, "$.data", "tool_use", timestamp),
        kind: "tool_use",
        role: "assistant",
        sourceRecordUuid: callId,
        toolUseId: callId,
        name,
        input: input != null && typeof input === "object" && !Array.isArray(input) ? input : { value: input },
      });
      continue;
    }
    if (event.type === "tool/result") {
      const message = asRecord(event.data.message) ?? event.data;
      const callId = stringOrNull(message.toolCallId) ?? stringOrNull(message.callId);
      const isError = message.isError === true || event.data.error != null;
      events.push({
        ...base(envelope, "$.data.message", "tool_result", timestamp),
        kind: "tool_result",
        role: "user",
        sourceRecordUuid: stringOrNull(message.id) ?? callId,
        sourceParentUuid: callId,
        toolUseId: callId,
        content: textFromContent(message.content) ?? message.content ?? event.data,
        isError,
      });
      continue;
    }
    if (event.type === "compaction/summary") {
      const summary = stringOrNull(event.data.summary) ?? textFromContent(event.data.summary);
      events.push({
        ...base(envelope, "$.data", "compact_boundary", timestamp),
        kind: "compact_boundary",
        compactMetadata: {
          message: { content: summary ?? "" },
          compactMetadata: {
            preTokens: typeof event.data.shadowedTokenCount === "number" ? event.data.shadowedTokenCount : undefined,
          },
          compactionId: event.data.compactionId,
        },
        activeContextStartsAfter: event.seq === lastCompactSeq,
      });
      continue;
    }
    if (event.type === "goal/change") {
      const operation = stringOrNull(event.data.operation);
      events.push({
        ...base(envelope, "$.data", "goal_snapshot", timestamp),
        kind: "goal_snapshot",
        goal: stringOrNull(event.data.goal),
        status: goalStatus(operation, event.data),
        snapshot: event.data,
      });
      continue;
    }
    if (event.type === "permission/preset" || event.type === "sandbox/mode" || event.type === "approval/policy" ||
      event.type === "approval/asked" || event.type === "approval/decided") {
      events.push({
        ...base(envelope, "$.data", "access_snapshot", timestamp),
        kind: "access_snapshot",
        permissionMode: stringOrNull(event.data.preset) ?? stringOrNull(event.data.mode) ??
          stringOrNull(event.data.policy) ?? stringOrNull(event.data.outcome),
        snapshot: event.data,
      });
      continue;
    }
    if (event.type === "session" || event.type === "session/title" || event.type === "session/title-llm-request") {
      continue;
    }
    events.push(protocol(envelope, event, timestamp));
  }

  const sourceContentSha256 = sha256Utf8(log.records.map((envelope) => envelope.raw + envelope.lineEnding).join(""));
  const goalState = authoritativeGoal(log);
  return {
    conversation: {
      version: BRIDGE_IR_VERSION,
      id: deterministicId("bridge-conversation-v2", {
        source: "dsh",
        sourcePath: log.sourcePath,
        sourceContentSha256,
        sourceSessionId: log.header.id,
      }),
      source: "dsh",
      sourceProvider: "dsh",
      sourcePath: log.sourcePath,
      sourceContentSha256,
      sourceSessionId: log.header.id,
      sourceThreadId: log.header.id,
      cwd: log.header.cwd,
      title: log.title,
      ...(goalState ? { goalState } : {}),
      recordEnvelopeIds: log.records.map((envelope) => envelope.id),
      events,
    },
    envelopes: log.records,
  };
}
