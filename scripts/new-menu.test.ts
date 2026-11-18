import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const source = (await readFile(new URL("../defaults/mods/new-menu/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class", "class");

function render(platform: string, space: { id: string; machine?: string } | null, folder?: string) {
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

test("Entwurf launch opens an interactive tab in the active local space and does not set up Pi", () => {
  const { clicks, actions, overlays } = render("macos", local);
  clicks.get("entwurf-pi")!();
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual(["tab.new", { space: local.id, argv: ["sh", "-c", expect.any(String)] }]);
  expect(overlays).toEqual([]);
  if (process.platform !== "win32") {
    const missing = spawnSync("/bin/sh", actions[0][1].argv.slice(1), { env: { PATH: "/dev/null" }, encoding: "utf8" });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toContain("Entwurf Pi needs tmux on PATH. Nothing was installed.");
  }
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
