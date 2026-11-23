import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSurface, extraExtensionArgs, isMuxAvailable, launchSurface, shellEscape, workerLayout } from "../integrations/pi-native-panes/native.ts";

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

test("extraExtensionArgs quotes each listed path for a shell command", () => {
  expect(extraExtensionArgs({})).toEqual([]);
  expect(extraExtensionArgs({ HERDR_PI_EXTENSIONS: "" })).toEqual([]);
  expect(extraExtensionArgs({ HERDR_PI_EXTENSIONS: "/a/b.ts\n/it's here/c.ts\n" })).toEqual(["-e", "'/a/b.ts'", "-e", "'/it'\\''s here/c.ts'"]);
  const out = Bun.spawnSync(["sh", "-c", `printf '%s|' ${extraExtensionArgs({ HERDR_PI_EXTENSIONS: "/x y/it's.ts" }).join(" ")}`]).stdout.toString();
  expect(out).toBe("-e|/x y/it's.ts|");
});

const PANES = join(import.meta.dir, "..", "integrations", "pi-native-panes");

/** A prepared-copy stand-in with the real launchers and a fake pi/hc/herdr-app/tmux-free PATH. */
function launcher(extras: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "native-ext-"));
  const copy = join(dir, "copy");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(join(copy, "pi-extension", "subagents"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(copy, "pi-extension", "subagents", "index.ts"), "");
  writeFileSync(join(copy, ".herdr-native-copy"), "");
  writeFileSync(join(copy, "VARIANTS.md"), "guide");
  for (const f of ["pi-native", "orchestrator", "extensions.sh"]) copyFileSync(join(PANES, f), join(copy, f));
  chmodSync(join(copy, "pi-native"), 0o755);
  chmodSync(join(copy, "orchestrator"), 0o755);
  if (extras !== null) writeFileSync(join(copy, "extensions"), extras.replaceAll("$HOME", home));
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nfor a in "$@"; do printf 'ARG:%s\\n' "$a"; done\nprintf 'ENV:%s\\n' "$(printf %s "\${HERDR_PI_EXTENSIONS:-}" | tr '\\n' ',')"\n`, { mode: 0o755 });
  for (const t of ["hc", "herdr-app"]) writeFileSync(join(bin, t), "#!/bin/sh\n", { mode: 0o755 });
  const run = (script: string, args: string[]) => {
    const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, HOME: home, HC_TERMINAL_ID: "tpar", HERDR_APP_HOME: "/tmp/home" };
    const r = Bun.spawnSync([join(copy, script), ...args], { env, cwd: dir });
    const out = r.stdout.toString();
    return { code: r.exitCode, err: r.stderr.toString(), args: out.split("\n").filter(l => l.startsWith("ARG:")).map(l => l.slice(4)), env: out.split("\n").find(l => l.startsWith("ENV:"))?.slice(4) };
  };
  return { dir, copy, home, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("pi-native passes listed extensions after the subagent entry and exports them", () => {
  const t = launcher("# provider\n\n  ~/ext one/index.ts  \n$HOME/two.ts\r\n#/not/used\n");
  try {
    mkdirSync(join(t.home, "ext one"));
    writeFileSync(join(t.home, "ext one", "index.ts"), "");
    writeFileSync(join(t.home, "two.ts"), "");
    const r = t.run("pi-native", [t.copy, "--model", "m"]);
    const entry = join(t.copy, "pi-extension", "subagents", "index.ts");
    expect(r.err).toBe("");
    expect(r.args).toEqual(["--no-extensions", "--extension", entry, "--extension", join(t.home, "ext one", "index.ts"), "--extension", join(t.home, "two.ts"), "--model", "m"]);
    expect(r.env).toBe(`${join(t.home, "ext one", "index.ts")},${join(t.home, "two.ts")}`);
  } finally { t.cleanup(); }
});

test("pi-native without an extensions file or with only comments keeps the arguments", () => {
  for (const extras of [null, "# nothing\n\n"]) {
    const t = launcher(extras);
    try {
      const r = t.run("pi-native", [t.copy, "--model", "m"]);
      expect(r.args).toEqual(["--no-extensions", "--extension", join(t.copy, "pi-extension", "subagents", "index.ts"), "--model", "m"]);
      expect(r.env).toBe("");
    } finally { t.cleanup(); }
  }
});

test("pi-native fails early when a listed extension is missing", () => {
  const t = launcher("~/gone.ts\n");
  try {
    const r = t.run("pi-native", [t.copy]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`Extension listed in ${join(t.copy, "extensions")} not found: ${join(t.home, "gone.ts")}`);
    expect(r.args).toEqual([]);
  } finally { t.cleanup(); }
});

test("orchestrator tmux passes the listed extensions to the parent Pi", () => {
  const t = launcher("~/p q.ts\n");
  try {
    writeFileSync(join(t.home, "p q.ts"), "");
    writeFileSync(join(t.copy, "tmux-entry"), join(t.copy, "pi-extension", "subagents", "index.ts") + "\n");
    writeFileSync(join(t.dir, "bin", "python3"), "#!/bin/sh\n", { mode: 0o755 });
    // Fake tmux and herdr-tmux record the pi command line instead of starting anything.
    writeFileSync(join(t.dir, "bin", "tmux"), `#!/bin/sh\nfor a in "$@"; do printf 'T:%s\\n' "$a"; done >> ${join(t.dir, "tmux.log")}\n`, { mode: 0o755 });
    writeFileSync(join(t.copy, "herdr-tmux"), "#!/bin/sh\n", { mode: 0o755 });
    const r = t.run("orchestrator", ["tmux"]);
    expect(r.err).toBe("");
    const log = readFileSync(join(t.dir, "tmux.log"), "utf8").split("\n");
    expect(log).toContain("T:--extension");
    expect(log).toContain(`T:${join(t.home, "p q.ts")}`);
    expect(log).toContain("T:-e");
  } finally { t.cleanup(); }
});
