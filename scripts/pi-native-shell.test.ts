import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSurface, isMuxAvailable, launchSurface, shellEscape, workerLayout } from "../integrations/pi-native-panes/native.ts";

test("shellEscape quotes embedded single quotes for a POSIX shell", () => {
  expect(shellEscape("plain")).toBe("'plain'");
  expect(shellEscape("it's")).toBe("'it'\\''s'");
  expect(shellEscape("''")).toBe("''\\'''\\'''");
  const out = Bun.spawnSync(["sh", "-c", `printf %s ${shellEscape("a'b $HOME \"c\"")}`]).stdout.toString();
  expect(out).toBe("a'b $HOME \"c\"");
});

test("isMuxAvailable only checks the environment", () => {
  const saved = { ...process.env };
  try {
    for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
    Object.assign(process.env, { HC_TERMINAL_ID: "tabc1", HERDR_APP_HOME: "/tmp/home" });
    expect(isMuxAvailable()).toBe(true);
    process.env.HERDR_APP_HOME = "relative";
    expect(isMuxAvailable()).toBe(false);
    process.env.HERDR_APP_HOME = "/tmp/home";
    process.env.TMUX = "/tmp/tmux";
    expect(isMuxAvailable()).toBe(false);
  } finally {
    for (const k of ["TMUX", "TMUX_PANE", "HC_TERMINAL_ID", "HERDR_APP_HOME"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("workerLayout recognizes tab, split and hidden, and defaults to tab", () => {
  for (const [value, layout] of [[undefined, "tab"], ["", "tab"], ["tab", "tab"], ["bogus", "tab"], ["split", "split"], ["hidden", "hidden"]] as const) {
    expect(workerLayout({ HERDR_PI_WORKER_LAYOUT: value })).toBe(layout);
  }
});

/** launchSurface against fake herdr-app and hc binaries: the requests it makes and how it treats replies. */
function launch(layout: string | undefined, replies: { newTerminal?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-launch-"));
  const log = join(dir, "log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const kid = replies.newTerminal ?? "tkid";
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s|%s\\n' "${name}" "$*" >> ${log}\n${body}\n`, { mode: 0o755 });
  };
  tool("herdr-app", `case "$1 $2" in
"ls ") echo '{"spaces":[{"id":"s1","machine":null,"tabs":[{"id":"tb1","terminals":[{"terminal":"tpar","pane":"p1"}]}]}]}';;
"do tab.new") echo '{"space":"s1","tab":"tb2","terminal":"${kid}"}';;
"do pane.split") echo '{"pane":"p2","terminal":"${kid}"}';;
esac`);
  tool("hc", `case "$1" in
get) if [ "$3" = tpar ]; then echo '{"address":"tpar","state":"live","labels":{"herdr.space":"s1","herdr.tab":"tb1"}}'; else echo '{"address":"${kid}","state":"live"}'; fi;;
run) echo '{"address":"${kid}"}';;
kill) echo '{}';;
esac`);
  const saved = { ...process.env };
  const script = join(dir, "work", "launch.sh");
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, HC_TERMINAL_ID: "tpar", HERDR_APP_HOME: "/tmp/home" });
  for (const k of ["TMUX", "TMUX_PANE"]) delete process.env[k];
  if (layout) process.env.HERDR_PI_WORKER_LAYOUT = layout; else delete process.env.HERDR_PI_WORKER_LAYOUT;
  const lines = () => readFileSync(log, "utf8").trim().split("\n").filter(l => !/^(herdr-app\|ls|hc\|get)/.test(l));
  try {
    let result: { terminal?: string; error?: string };
    try { result = { terminal: launchSurface("echo hi", script, "/some dir") }; } catch (e: any) { result = { error: String(e.message) }; }
    return { ...result, calls: lines(), script: existsSync(script) ? readFileSync(script, "utf8") : null, closed: result.terminal ? (closeSurface(result.terminal), lines()) : null };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("launchSurface starts a background tab by default, with the request tab.new documents", () => {
  const r = launch(undefined);
  expect(r.terminal).toBe("tkid");
  expect(r.calls[0]).toStartWith('herdr-app|do tab.new {"space":"s1","argv":["/usr/bin/env","bash",');
  expect(r.calls[0]).toContain('"focus":false');
  expect(r.calls.some(c => c.startsWith("hc|run"))).toBe(false);
});

test("launchSurface splits beside the parent pane for split", () => {
  const r = launch("split");
  expect(r.terminal).toBe("tkid");
  expect(r.calls[0]).toStartWith('herdr-app|do pane.split {"direction":"right","pane":"p1","argv":');
});

test("launchSurface runs hidden workers with hc run from the parent: no tab, no split", () => {
  const r = launch("hidden");
  expect(r.terminal).toBe("tkid");
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0]).toMatch(/^hc\|run --json --cwd \/some dir -- \/usr\/bin\/env bash .*launch\.sh$/);
  expect(r.script).toContain("cd -- '/some dir' || exit");
  // Closing a windowless worker is the same hc kill as for the others.
  expect(r.closed!.at(-1)).toBe("hc|kill --json tkid");
});

test("launchSurface rejects a reply naming the parent or no terminal, for every layout, and cleans up", () => {
  for (const layout of ["tab", "split", "hidden"]) {
    for (const newTerminal of ["tpar", "bogus!"]) {
      const r = launch(layout, { newTerminal });
      expect(r.error).toContain("did not return a distinct local child identity");
      expect(r.script).toBeNull();
      // Never kill the parent; an unusable id is not killed either.
      expect(r.calls.some(c => c.startsWith("hc|kill"))).toBe(false);
    }
  }
});
