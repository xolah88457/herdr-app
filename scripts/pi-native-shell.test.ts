import { expect, test } from "bun:test";
import { isMuxAvailable, shellEscape } from "../integrations/pi-native-panes/native.ts";

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
