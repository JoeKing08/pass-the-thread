import os from "node:os";
import path from "node:path";

/** Resolve the Codex home directory (rollout sessions live under <codexHome>/sessions). */
export function resolveCodexHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.CODEX_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".codex");
}

/** Resolve the Claude config directory (transcripts live under <claudeHome>/projects). */
export function resolveClaudeHome(override?: string): string {
  if (override && override.trim() !== "") return path.resolve(override);
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".claude");
}

/** Normalize a cwd for Claude Code's encoded project-directory name. */
export function normalizeCwd(cwd: string): string {
  if (/^[A-Za-z]:/.test(cwd)) return cwd[0].toLowerCase() + cwd.slice(1);
  return cwd;
}

/**
 * Normalize a cwd written inside a transcript or Desktop wrapper record.
 * Claude's native Windows sessions use the drive spelling returned by the
 * process (`C:\...`) and compare that record identity case-sensitively when
 * resuming, even though Windows resolves `c:\...` to the same directory.
 */
export function recordCwd(cwd: string): string {
  return /^[A-Za-z]:/.test(cwd) ? cwd[0].toUpperCase() + cwd.slice(1) : cwd;
}

/**
 * Encode an absolute cwd into a Claude Code project-directory name.
 * Claude Code replaces every non-alphanumeric character with '-'.
 * Verified against a real project dir: `c:\_projects\Agentryx-ai` -> `c---projects-Agentryx-ai`.
 */
export function encodeProjectDir(cwd: string): string {
  return normalizeCwd(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
