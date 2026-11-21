import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const runAsync = promisify(execFile);
const isTerminal = (id: unknown): id is string => typeof id === "string" && /^t[0-9a-z]+$/.test(id);
const isPane = (id: unknown): id is string => typeof id === "string" && /^p[0-9a-f]+$/.test(id);
const options = { encoding: "utf8" as const, timeout: 7000, maxBuffer: 4 * 1024 * 1024 };
const children = new Map<string, NodeJS.ProcessEnv>();
const scripts = new Map<string, string>();

function removeScript(path: string) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

export function shellEscape(text: string): string {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** Turn a failed herdr-app/hc call into a message that says what went wrong. */
function failure(bin: string, args: string[], error: any): Error {
  if (error?.code === "ENOENT") return new Error(`${bin} not found on PATH.`);
  // `herdr-app do` replies with JSON on stdout and exits 1 on errors.
  let reason = "";
  try { reason = JSON.parse(String(error?.stdout ?? "")).error ?? ""; } catch { /* not JSON */ }
  if (typeof reason !== "string") reason = JSON.stringify(reason);
  reason ||= String(error?.stderr ?? "").trim() || String(error?.message ?? error);
  return new Error(`${bin} ${args.slice(0, 2).join(" ")} failed: ${reason}`);
}

function json(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    return JSON.parse(execFileSync(bin, args, { ...options, env, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw failure(bin, args, error);
  }
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
  return { env, home, parent, pane: matches[0].pane as string, space: matches[0].spaceId as string, tabId: matches[0].tabId as string };
}

export function muxSetupHint(): string {
  return "Start Pi directly in a local Herdr app pane, with HERDR_APP_HOME set to the absolute path of that window's home and matching core environment.";
}

/** Kept for the patched extension, which no longer waits for a shell: native splits start their program directly. */
export function getShellReadyDelayMs(): number {
  return 0;
}

export function isMuxAvailable(): boolean {
  // Cheap: only the environment binding() requires up front; launchSurface does the full lookup.
  const { HC_TERMINAL_ID: parent, HERDR_APP_HOME: home, TMUX, TMUX_PANE } = process.env;
  return !TMUX && !TMUX_PANE && isTerminal(parent) && Boolean(home) && isAbsolute(home!);
}

/**
 * HERDR_PI_WORKER_LAYOUT=split opens workers beside the parent; hidden runs them with no tab or pane
 * (a sub-agent under its parent in the Agents list); anything else (the default) is a background tab.
 */
export function workerLayout(env: NodeJS.ProcessEnv): "split" | "tab" | "hidden" {
  const layout = env.HERDR_PI_WORKER_LAYOUT;
  return layout === "split" || layout === "hidden" ? layout : "tab";
}

/** Write the existing invocation first; start it directly in a background tab (default), an explicitly targeted split, or no window at all. */
export function launchSurface(command: string, scriptPath: string, cwd: string): string {
  const { env, home, parent, pane, space, tabId } = binding();
  const layout = workerLayout(env);
  const tab = layout === "tab";
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, [
    "#!/usr/bin/env bash",
    `export HERDR_APP_HOME=${shellEscape(home)} PI_SUBAGENT_SURFACE="$HC_TERMINAL_ID"`,
    `cd -- ${shellEscape(cwd)} || exit`,
    command,
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  let reply: any;
  try {
    const argv = ["/usr/bin/env", "bash", scriptPath];
    // tab.new replies {space, tab, terminal}; focus:false leaves the shown tab alone.
    // hidden: `hc run` from the parent's terminal (HC_TERMINAL_ID stays in env) starts a core terminal with
    // the parent as its `parent` and no herdr.space label, so it gets no tab or pane and shows under the parent.
    // The core replies with the new terminal's `address`; the script's own cd sets the folder.
    if (layout === "hidden") {
      const started = json("hc", ["run", "--json", "--cwd", cwd, "--", ...argv], env);
      reply = { terminal: started.address ?? started.terminal };
    } else {
      reply = tab
        ? json("herdr-app", ["do", "tab.new", JSON.stringify({ space, argv, focus: false })], env)
        : json("herdr-app", ["do", "pane.split", JSON.stringify({ direction: "right", pane, argv })], env);
    }
  } catch (error) {
    removeScript(scriptPath);
    throw error;
  }
  const placed = layout === "hidden" ? true : tab
    ? typeof reply.tab === "string" && reply.tab !== "" && reply.tab !== tabId && reply.space === space
    : isPane(reply.pane) && reply.pane !== pane;
  if (!isTerminal(reply.terminal) || reply.terminal === parent || !placed || children.has(reply.terminal)) {
    // The split may have happened; do not leave an untracked worker running.
    if (isTerminal(reply.terminal) && reply.terminal !== parent && !children.has(reply.terminal)) {
      try { json("hc", ["kill", "--json", reply.terminal], env); } catch { /* best effort */ }
    }
    removeScript(scriptPath);
    throw new Error(`Herdr ${layout === "hidden" ? "background terminal" : tab ? "tab" : "split"} did not return a distinct local child identity; no target was opened for input.`);
  }
  scripts.set(reply.terminal, scriptPath);
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
  const script = scripts.get(surface);
  if (script) removeScript(script);
  scripts.delete(surface);
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
