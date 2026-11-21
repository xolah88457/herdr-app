import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const source = (await readFile(new URL("../defaults/mods/new-menu/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class", "class");

function render(platform: string, space: { id: string; machine?: string } | null, folder?: string, useTmux?: boolean, split?: boolean) {
  const clicks = new Map<string, () => void>();
  const actions: [string, any][] = [];
  const overlays: any[] = [];
  function element() {
    let id: string;
    const el: any = new Proxy({}, { get: (_, method) => (...args: any[]) => {
      if (method === "id") id = args[0];
      if (method === "on_click") clicks.set(id, args[0]);
      if (method === "when" && args[0]) args[1](el);
      return el;
    } });
    return el;
  }
  const globals = {
    View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
    shared: (k: string) => k === "pi-subagents.tmux" ? useTmux : k === "pi-subagents.split" ? split : undefined, appHome: () => "/private/app home",
    theme: () => ({}), keys: () => [], window: () => ({ platform }),
    spaces: () => space ? [{ ...space, active: true }] : [],
    panes: () => folder ? [{ focused: true, cwd: folder }] : [],
    props: () => ({ overlay: "new-menu" }), closeOverlay: () => {},
    run: (name: string, args: unknown) => actions.push([name, args]),
    openOverlay: (overlay: unknown) => overlays.push(overlay),
  };
  const NewMenu = new Function(...Object.keys(globals), `${source}; return NewMenu;`)(...Object.values(globals));
  const menu = new NewMenu();
  menu.agents = [];
  menu.render();
  return { clicks, actions, overlays };
}

const local = { id: "local" };

test("Pi subagents pins the local space, folder and selected backend", () => {
  for (const setting of [undefined, true, false]) {
    for (const [split, layout] of [[undefined, "tab"], [false, "tab"], [true, "split"]] as const) {
      const { clicks, actions } = render("macos", local, "/repo", setting, split);
      clicks.get("pi-subagents")!();
      expect(actions[0]).toEqual(["tab.new", {space: local.id, folder: "/repo", argv: ["sh", "-c", expect.any(String), "pi-subagents", "/private/app home/pi-subagents", setting ? "tmux" : "native", layout]}]);
      // The layout reaches the orchestrator through its environment, quoted from argv.
      expect((actions[0][1] as any).argv[2]).toContain('HERDR_PI_WORKER_LAYOUT="$3" exec "$1/orchestrator" "$2"');
    }
  }
  expect(render("linux", {id:"remote", machine:"ssh"}).clicks.has("pi-subagents")).toBe(false);
});

test("Entwurf launch opens an interactive tab in the active local space and does not set up Pi", () => {
  const { clicks, actions, overlays } = render("macos", local);
  clicks.get("entwurf-pi")!();
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual(["tab.new", { space: local.id, argv: ["sh", "-c", expect.any(String)] }]);
  expect(overlays).toEqual([]);
  if (process.platform !== "win32") {
    const missing = spawnSync("/bin/sh", actions[0][1].argv.slice(1), { env: { PATH: "/dev/null" }, encoding: "utf8", input: "\n" });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("Entwurf Pi needs tmux on PATH. Nothing was installed.");
    expect(missing.stderr).toContain("Press Enter to close.");
  }
  // The private tmux server ends its session when the client goes away.
  expect(actions[0][1].argv[2]).toMatch(/new-session[\s\S]*\\?;\s*\\?\s*set-option destroy-unattached on/);
});

test("Entwurf setup requires confirmation and pins the focused terminal directory", () => {
  const folder = "/projects/a repo's folder";
  const { clicks, actions, overlays } = render("linux", local, folder);
  clicks.get("entwurf-setup")!();
  expect(actions).toEqual([]);
  expect(overlays).toHaveLength(1);
  expect(overlays[0].mod).toBe("confirm");
  expect(overlays[0].props.detail).toContain("project and user Pi settings");
  expect(overlays[0].props.command).toEqual({
    name: "tab.new", args: { space: local.id, folder, argv: ["entwurf", "install", folder] },
  });
});

test("Entwurf actions are local Unix only; setup needs a known terminal directory", () => {
  for (const { clicks } of [render("windows", local), render("linux", { ...local, machine: "ssh" }), render("linux", null)]) {
    expect(clicks.has("entwurf-pi")).toBe(false);
    expect(clicks.has("entwurf-setup")).toBe(false);
  }
  const { clicks, overlays, actions } = render("linux", local);
  clicks.get("entwurf-setup")!();
  expect(overlays).toEqual([]);
  expect(actions).toEqual([]);
});

test("Pi subagents is disabled without a terminal folder and waits for Enter on failure", () => {
  const { clicks, actions } = render("linux", local);
  clicks.get("pi-subagents")!();
  expect(actions).toEqual([]);
  const run = render("linux", local, "/repo");
  run.clicks.get("pi-subagents")!();
  const argv = run.actions[0][1].argv;
  expect(argv[2]).toContain("Press Enter to close.");
  if (process.platform !== "win32") {
    const r = spawnSync("/bin/sh", argv.slice(1), { encoding: "utf8", input: "\n" });
    expect(r.status).toBe(1);
  }
});
