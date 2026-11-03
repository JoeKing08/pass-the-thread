import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  buildCodexRollout41059,
  serializeCodexRollout41059,
  type LogicalCodexConversation,
} from "./compat/codex/v26_721_41059.ts";
import {
  CODEX_41059_SAFE_ACTIVE_UTF8_BYTES,
  deterministicThreadId,
  estimatedActiveBytes,
} from "./codex-target.ts";

export const CODEX_CLI_RENDERER_ID = "pass-the-thread/codex-cli-rollout/v1" as const;

export interface CodexCliRuntime {
  version: string;
  modelProvider: string;
  executablePath: string;
  executableSha256: string;
}

export interface CodexCliTargetPlan {
  operationId: string;
  codexHome: string;
  cliVersion: string;
  modelProvider: string;
  sourceSha256: string;
  targetThreadId: string;
  rolloutPath: string;
  rolloutSha256: string;
  rolloutBytes: number;
  serializedRollout: string;
}

export type CodexCliTargetState = "absent" | "already-applied" | "collision";

function resolveExecutable(executable: string): string {
  const candidates = executable.includes(path.sep)
    ? [path.resolve(executable)]
    : (process.env.PATH ?? "").split(path.delimiter)
      .filter((directory) => directory !== "")
      .map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync.native(candidate);
    } catch { /* continue searching PATH */ }
  }
  throw new Error(`Codex CLI executable was not found or is not executable: ${executable}`);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertRolloutPath(plan: CodexCliTargetPlan): void {
  const root = path.resolve(plan.codexHome, "sessions");
  const target = path.resolve(plan.rolloutPath);
  if (!isWithin(root, target) || !path.basename(target).endsWith(`-${plan.targetThreadId}.jsonl`)) {
    throw new Error("Codex CLI target path is outside the planned session root");
  }
}

function sha256File(filePath: string): string {
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

function assertProvider(value: string): string {
  const provider = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider)) {
    throw new Error("Codex CLI model provider must be a provider id, for example custom or openai");
  }
  return provider;
}

/** Read the simple top-level provider id without parsing arbitrary TOML tables. */
function configuredModelProvider(codexHome: string): string {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return "openai";
  const text = fs.readFileSync(configPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model_provider\s*=\s*"([A-Za-z0-9][A-Za-z0-9._-]{0,127})"\s*(?:#.*)?$/);
    if (match) return match[1]!;
  }
  return "openai";
}

export function detectCodexCliRuntime(
  codexHome: string,
  options: { executable?: string; modelProvider?: string } = {},
): CodexCliRuntime {
  if (process.platform !== "linux") {
    throw new Error("the Codex CLI file target is currently supported on Linux only");
  }
  const executable = options.executable?.trim() || process.env.CODEX_CLI_BIN?.trim() || "codex";
  const executablePath = resolveExecutable(executable);
  let output: string;
  try {
    output = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (error) {
    throw new Error(`cannot run Codex CLI version check (${executable} --version): ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/)?.[1];
  if (!version) throw new Error(`unrecognized Codex CLI version output: ${output.slice(0, 160)}`);
  return {
    version,
    modelProvider: assertProvider(options.modelProvider ?? configuredModelProvider(codexHome)),
    executablePath,
    executableSha256: sha256File(executablePath),
  };
}

export function planCodexCliTarget(
  codexHome: string,
  sourceId: string,
  sourceSha256: string,
  conversation: Omit<LogicalCodexConversation, "threadId">,
  runtime: CodexCliRuntime,
): CodexCliTargetPlan {
  if (!/^[0-9a-f]{64}$/i.test(sourceSha256)) throw new Error("source SHA-256 is invalid");
  const activeBytes = estimatedActiveBytes(conversation);
  if (activeBytes > CODEX_41059_SAFE_ACTIVE_UTF8_BYTES) {
    throw new Error(
      `active imported context is ${activeBytes} UTF-8 bytes; conservative offline limit is ` +
      `${CODEX_41059_SAFE_ACTIVE_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  const targetThreadId = deterministicThreadId(sourceId, sourceSha256);
  const created = new Date(conversation.createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("conversation.createdAt must be ISO-8601");
  const fullConversation = { ...conversation, threadId: targetThreadId };
  const lines = buildCodexRollout41059(fullConversation);
  const meta = lines[0]?.payload;
  if (lines[0]?.type !== "session_meta" || meta == null) {
    throw new Error("Codex rollout renderer did not produce session metadata");
  }
  meta.originator = "codex_cli_rs";
  meta.cli_version = runtime.version;
  meta.source = "cli";
  meta.thread_source = "user";
  meta.model_provider = runtime.modelProvider;
  const serializedRollout = serializeCodexRollout41059(lines);
  const rolloutSha256 = createHash("sha256").update(serializedRollout, "utf8").digest("hex");
  const date = created.toISOString();
  const rolloutPath = path.join(
    path.resolve(codexHome),
    "sessions",
    date.slice(0, 4),
    date.slice(5, 7),
    date.slice(8, 10),
    `rollout-${date.replace(/[:.]/g, "-").replace(/Z$/, "")}-${targetThreadId}.jsonl`,
  );
  const operationId = createHash("sha256")
    .update(`codex-cli-import\0${sourceSha256}\0${targetThreadId}`, "utf8")
    .digest("hex").slice(0, 32);
  return {
    operationId,
    codexHome: path.resolve(codexHome),
    cliVersion: runtime.version,
    modelProvider: runtime.modelProvider,
    sourceSha256,
    targetThreadId,
    rolloutPath,
    rolloutSha256,
    rolloutBytes: Buffer.byteLength(serializedRollout, "utf8"),
    serializedRollout,
  };
}

export function inspectCodexCliTarget(plan: CodexCliTargetPlan): CodexCliTargetState {
  assertRolloutPath(plan);
  const matches: string[] = [];
  for (const root of [path.join(plan.codexHome, "sessions"), path.join(plan.codexHome, "archived_sessions")]) {
    const walk = (directory: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile() && entry.name.endsWith(`-${plan.targetThreadId}.jsonl`)) matches.push(child);
      }
    };
    walk(root);
  }
  if (matches.length > 1) return "collision";
  if (matches.length === 0) return "absent";
  if (path.resolve(matches[0]!) !== path.resolve(plan.rolloutPath)) return "collision";
  return sha256File(matches[0]!) === plan.rolloutSha256 ? "already-applied" : "collision";
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Atomically publish a new CLI rollout without replacing any existing file. */
export function applyCodexCliTarget(plan: CodexCliTargetPlan): "applied" | "already-applied" {
  assertRolloutPath(plan);
  const serializedHash = createHash("sha256").update(plan.serializedRollout, "utf8").digest("hex");
  if (serializedHash !== plan.rolloutSha256 ||
    Buffer.byteLength(plan.serializedRollout, "utf8") !== plan.rolloutBytes) {
    throw new Error("Codex CLI rollout plan payload does not match its confirmed hash/size");
  }
  const initial = inspectCodexCliTarget(plan);
  if (initial === "already-applied") return initial;
  if (initial === "collision") throw new Error(`Codex CLI rollout collision: ${plan.rolloutPath}`);

  const directory = path.dirname(plan.rolloutPath);
  fs.mkdirSync(directory, { recursive: true });
  const homeReal = fs.realpathSync.native(plan.codexHome);
  const sessionsRootReal = fs.realpathSync.native(path.join(homeReal, "sessions"));
  const directoryReal = fs.realpathSync.native(directory);
  if (!isWithin(homeReal, sessionsRootReal) || !isWithin(sessionsRootReal, directoryReal)) {
    throw new Error("Codex CLI session directory resolves outside CODEX_HOME/sessions");
  }
  const stagePath = path.join(
    directory,
    `.${path.basename(plan.rolloutPath)}.${plan.operationId}.${randomUUID()}.stage`,
  );
  const fd = fs.openSync(stagePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, plan.serializedRollout, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(stagePath); } catch { /* leave crash evidence intact */ }
    throw error;
  }
  fs.closeSync(fd);

  try {
    fs.linkSync(stagePath, plan.rolloutPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let state: CodexCliTargetState;
      try {
        state = inspectCodexCliTarget(plan);
        fs.unlinkSync(stagePath);
      } catch (inspectionError) {
        throw new AggregateError([error, inspectionError], "Codex CLI rollout publish raced with an uninspectable target");
      }
      if (state === "already-applied") return state;
      throw new Error(`Codex CLI rollout collision: ${plan.rolloutPath}`);
    }
    throw error;
  }
  fsyncDirectory(directory);
  fs.unlinkSync(stagePath);
  fsyncDirectory(directory);
  return "applied";
}
