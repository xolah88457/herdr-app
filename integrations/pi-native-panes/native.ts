import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const runAsync = promisify(execFile);
const isTerminal = (id: unknown): id is string => typeof id === "string" && /^t[0-9a-z]+$/.test(id);
const isPane = (id: unknown): id is string => typeof id === "string" && /^p[0-9a-f]+$/.test(id);
const options = { encoding: "utf8" as const, timeout: 7000, maxBuffer: 4 * 1024 * 1024 };
const children = new Map<string, NodeJS.ProcessEnv>();

export function shellEscape(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function json(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  return JSON.parse(execFileSync(bin, args, { ...options, env, stdio: ["ignore", "pipe", "pipe"] }));
}

function binding() {
  const env = { ...process.env };
  const { HC_TERMINAL_ID: parent, HERDR_APP_HOME: home, TMUX, TMUX_PANE } = env;
  if (TMUX || TMUX_PANE || !isTerminal(parent) || !home || !isAbsolute(home)) {
    throw new Error(muxSetupHint());
  }
  const { spaces } = json("herdr-app", ["ls"], env);
  const matches = (spaces as any[]).flatMap(space => space.tabs.flatMap((tab: any) =>
    tab.terminals.filter((t: any) => t.terminal === parent).map((t: any) => ({ ...t, machine: space.machine, spaceId: space.id, tabId: tab.id })),
  ));
  if (matches.length !== 1 || matches[0].machine != null || !isPane(matches[0].pane)) {
    throw new Error(`Expected one local Herdr pane for ${parent}; refusing to split.`);
  }
  const record = json("hc", ["get", "--json", parent], env);
  if (record.address !== parent || record.state !== "live" ||
      record.labels?.["herdr.space"] !== matches[0].spaceId || record.labels?.["herdr.tab"] !== matches[0].tabId) {
    throw new Error(`Herdr parent ${parent} is not bound to this window's space and tab in the selected core.`);
  }
  return { env, home, parent, pane: matches[0].pane as string };
}

export function muxSetupHint(): string {
  return "Start Pi directly in a local Herdr app pane, with HERDR_APP_HOME set to the absolute path of that window's home and matching core environment.";
}

export function isMuxAvailable(): boolean {
  try { binding(); return true; } catch { return false; }
}

/** Write the existing invocation first; start it directly in an explicitly targeted split. */
export function launchSurface(command: string, scriptPath: string, cwd: string): string {
  const { env, home, parent, pane } = binding();
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, [
    "#!/bin/bash",
    `export HERDR_APP_HOME=${shellEscape(home)} PI_SUBAGENT_SURFACE="$HC_TERMINAL_ID"`,
    `cd -- ${shellEscape(cwd)} || exit`,
    command,
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  const reply = json("herdr-app", ["do", "pane.split", JSON.stringify({
    direction: "right", pane, argv: ["/bin/bash", scriptPath],
  })], env);
  if (!isTerminal(reply.terminal) || reply.terminal === parent || !isPane(reply.pane) || reply.pane === pane || children.has(reply.terminal)) {
    throw new Error("Herdr split did not return a distinct local child identity; no target was opened for input.");
  }
  children.set(reply.terminal, env);
  return reply.terminal;
}

function childEnv(surface: string): NodeJS.ProcessEnv {
  const env = children.get(surface);
  if (!env) throw new Error(`Unknown native child terminal ${surface}.`);
  return env;
}

export async function sendCommand(surface: string, text: string): Promise<void> {
  // No sender attribution: submit the extension's steering text as-is.
  const env = { ...childEnv(surface) };
  delete env.HC_TERMINAL_ID;
  await runAsync("hc", ["send", "--json", "--", surface, text], { ...options, timeout: 75000, env });
}

export function readScreen(surface: string, lines: number): string {
  const result = json("hc", ["read", "--json", "--lines", String(lines), surface], childEnv(surface));
  if (typeof result.text !== "string") throw new Error("Herdr read returned no terminal text.");
  return result.text;
}

export function closeSurface(surface: string): void {
  const env = children.get(surface);
  if (!env) return;
  const record = json("hc", ["get", "--json", surface], env);
  if (record.address !== surface) throw new Error("Herdr returned a different terminal when closing a child.");
  if (record.state === "live") json("hc", ["kill", "--json", surface], env);
  children.delete(surface);
}

interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

function sidecar(path: string): PollResult | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true });
    if (data?.type === "error") {
      return { reason: "error", exitCode: 1, errorMessage:
        typeof data.errorMessage === "string" && data.errorMessage.trim() ? data.errorMessage :
          "Subagent exited with stopReason=error (no errorMessage in sidecar)." };
    }
    return { reason: "done", exitCode: 0 };
  } catch { return; }
}

export async function pollForExit(surface: string, signal: AbortSignal, watch: {
  interval: number;
  sessionFile: string;
  sentinelFile?: string;
  onTick?: (elapsed: number) => void;
}): Promise<PollResult> {
  const env = childEnv(surface);
  const exitFile = `${watch.sessionFile}.exit`;
  const start = Date.now();
  function checkFiles(): PollResult | undefined {
    const result = sidecar(exitFile);
    if (result) return result;
    if (watch.sentinelFile) {
      try { readFileSync(watch.sentinelFile); return { reason: "sentinel", exitCode: 0 }; } catch { /* not written yet */ }
    }
  }
  for (;;) {
    signal.throwIfAborted();
    const before = checkFiles();
    if (before) return before;
    const { stdout } = await runAsync("hc", ["get", "--json", surface], { ...options, env, signal });
    const record = JSON.parse(stdout);
    if (record.address !== surface) throw new Error("Herdr returned a different terminal when watching a child.");
    if (record.state === "finished") {
      return checkFiles() ?? { reason: "done", exitCode:
        Number.isInteger(record.exit_code) ? record.exit_code : Number.isInteger(record.signal) ? 128 + record.signal : 1 };
    }
    if (record.state !== "live") throw new Error(`Unexpected Herdr terminal state for ${surface}.`);
    watch.onTick?.(Math.floor((Date.now() - start) / 1000));
    await delay(watch.interval, undefined, { signal });
  }
}
