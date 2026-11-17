import { deterministicId, sha256Utf8 } from "./envelope.ts";
import {
  BRIDGE_IR_VERSION,
  HISTORICAL_SAFETY,
  type BridgeBundle,
  type BridgeEvent,
} from "./ir.ts";
import type { GrokBuildSessionPackage } from "./grok-build-source.ts";
import type { RawEnvelope } from "./envelope.ts";

type ObjectRecord = Record<string, unknown>;

function asRecord(value: unknown): ObjectRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRecord
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isoFromUnixSecondsOrMs(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
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

function chunkText(update: ObjectRecord): string | null {
  const content = asRecord(update.content);
  return content && typeof content.text === "string" ? content.text : null;
}

function toolName(update: ObjectRecord): string | null {
  const meta = asRecord(update._meta);
  const tool = asRecord(meta?.["x.ai/tool"]);
  return stringOrNull(tool?.name) ??
    stringOrNull(asRecord(update.rawInput)?.toolName) ??
    stringOrNull(update.title);
}

function toolInput(update: ObjectRecord): unknown {
  const rawInput = update.rawInput;
  if (rawInput != null && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const record = rawInput as ObjectRecord;
    if (typeof record.arguments === "string") {
      try {
        const parsed = JSON.parse(record.arguments);
        if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch { /* keep the rawInput object */ }
    }
    return record;
  }
  return rawInput ?? {};
}

function toolResultText(update: ObjectRecord): unknown {
  const content = update.content;
  if (!Array.isArray(content)) return content ?? "";
  const texts = content.map((item) => {
    const record = asRecord(item);
    if (!record) return null;
    const inner = record.content;
    if (typeof inner === "string") return inner;
    const innerRecord = asRecord(inner);
    if (innerRecord && typeof innerRecord.text === "string") return innerRecord.text;
    return null;
  }).filter((text): text is string => text != null);
  return texts.length > 0 ? texts.join("\n") : content;
}

function asObjectInput(value: unknown): ObjectRecord {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectRecord
    : { value };
}

export function grokBuildSessionToIr(pack: GrokBuildSessionPackage): BridgeBundle {
  const events: BridgeEvent[] = [];
  let pendingAssistant: { envelope: RawEnvelope; text: string; timestamp: string | null } | null = null;
  let pendingThought: { envelope: RawEnvelope; text: string; timestamp: string | null } | null = null;

  const flushThought = (): void => {
    if (!pendingThought || pendingThought.text === "") {
      pendingThought = null;
      return;
    }
    events.push({
      ...base(pendingThought.envelope, "$.params.update.content", "reasoning", pendingThought.timestamp),
      kind: "reasoning",
      summary: pendingThought.text,
      content: pendingThought.text,
    });
    pendingThought = null;
  };

  const flushAssistant = (): void => {
    if (!pendingAssistant || pendingAssistant.text === "") {
      pendingAssistant = null;
      return;
    }
    events.push({
      ...base(pendingAssistant.envelope, "$.params.update.content", "text", pendingAssistant.timestamp),
      kind: "text",
      role: "assistant",
      text: pendingAssistant.text,
      authoredByHuman: false,
    });
    pendingAssistant = null;
  };

  for (const envelope of pack.records) {
    const parsed = asRecord(envelope.parsed);
    if (!parsed || envelope.parseError) {
      events.push({
        ...base(envelope, "$", "unknown", null),
        kind: "unknown",
        reason: envelope.parseError ? "invalid_json" : "unknown_record",
        value: envelope.parsed ?? envelope.raw,
      });
      continue;
    }
    const method = stringOrNull(parsed.method);
    const timestamp = isoFromUnixSecondsOrMs(parsed.timestamp);
    const params = asRecord(parsed.params);
    const update = asRecord(params?.update);
    const sessionUpdate = stringOrNull(update?.sessionUpdate);
    if ((method !== "session/update" && method !== "_x.ai/session/update") || update == null || sessionUpdate == null) {
      events.push({
        ...base(envelope, "$.params", "protocol", timestamp),
        kind: "protocol",
        recordType: method ?? "unknown_method",
        protocolType: sessionUpdate,
        payload: parsed,
      });
      continue;
    }
    if (sessionUpdate === "user_message_chunk") {
      flushThought();
      flushAssistant();
      const text = chunkText(update);
      if (text) {
        events.push({
          ...base(envelope, "$.params.update.content", "text", timestamp),
          kind: "text",
          role: "user",
          text,
          authoredByHuman: true,
        });
      }
      continue;
    }
    if (sessionUpdate === "agent_thought_chunk") {
      flushAssistant();
      const text = chunkText(update) ?? "";
      if (!pendingThought) pendingThought = { envelope, text, timestamp };
      else pendingThought.text += text;
      continue;
    }
    if (sessionUpdate === "agent_message_chunk") {
      flushThought();
      const text = chunkText(update) ?? "";
      if (!pendingAssistant) pendingAssistant = { envelope, text, timestamp };
      else pendingAssistant.text += text;
      continue;
    }
    if (sessionUpdate === "tool_call") {
      flushThought();
      flushAssistant();
      const callId = stringOrNull(update.toolCallId);
      events.push({
        ...base(envelope, "$.params.update", "tool_use", timestamp),
        kind: "tool_use",
        role: "assistant",
        sourceRecordUuid: callId,
        toolUseId: callId,
        name: toolName(update),
        input: asObjectInput(toolInput(update)),
      });
      continue;
    }
    if (sessionUpdate === "tool_call_update") {
      flushThought();
      flushAssistant();
      const callId = stringOrNull(update.toolCallId);
      events.push({
        ...base(envelope, "$.params.update", "tool_result", timestamp),
        kind: "tool_result",
        role: "user",
        sourceRecordUuid: callId,
        sourceParentUuid: callId,
        toolUseId: callId,
        content: toolResultText(update),
        isError: stringOrNull(update.status) === "error" || stringOrNull(update.status) === "failed",
      });
      continue;
    }
    if (sessionUpdate === "turn_completed") {
      flushThought();
      flushAssistant();
      events.push({
        ...base(envelope, "$.params.update", "protocol", timestamp),
        kind: "protocol",
        recordType: "turn_completed",
        protocolType: stringOrNull(update.stop_reason),
        payload: update,
      });
      continue;
    }
    if (sessionUpdate === "background_tasks") {
      events.push({
        ...base(envelope, "$.params.update", "task_notification", timestamp),
        kind: "task_notification",
        taskId: null,
        content: update.tasks ?? update,
      });
      continue;
    }
    events.push({
      ...base(envelope, "$.params.update", "protocol", timestamp),
      kind: "protocol",
      recordType: sessionUpdate,
      protocolType: sessionUpdate,
      payload: update,
    });
  }
  flushThought();
  flushAssistant();

  const sourceContentSha256 = sha256Utf8(pack.records.map((envelope) => envelope.raw + envelope.lineEnding).join(""));
  return {
    conversation: {
      version: BRIDGE_IR_VERSION,
      id: deterministicId("bridge-conversation-v2", {
        source: "grok-build",
        sourcePath: pack.sourcePath,
        sourceContentSha256,
        sourceSessionId: pack.sessionId,
      }),
      source: "grok-build",
      sourceProvider: "grok-build",
      sourcePath: pack.sourcePath,
      sourceContentSha256,
      sourceSessionId: pack.sessionId,
      sourceThreadId: pack.sessionId,
      cwd: pack.cwd || null,
      title: pack.title,
      recordEnvelopeIds: pack.records.map((envelope) => envelope.id),
      events,
    },
    envelopes: pack.records,
  };
}

