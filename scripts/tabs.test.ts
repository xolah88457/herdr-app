import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Exercise the shipped tab bar's wheel handler and labels without a window or a core.
type Handler = (event: unknown) => void;
class Element {
  nodes: Element[] = [];
  calls: Record<string, unknown[]> = {};
  constructor() {
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => {
        if (key === "child") target.nodes.push(args[0] as Element);
        else if (key === "children") target.nodes.push(...(args[0] as Element[]));
        else if (key === "when") { if (args[0]) (args[1] as (el: Element) => void)(proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/tabs/main.js", import.meta.url), "utf8");
const element = () => new Element();
const commands: string[] = [];
const store: Record<string, string> = {};
const defaultTabs = [{ id: "t1", name: "1" }, { id: "t2", name: "2", active: true }, { id: "t3", name: "3" }];
const snapshot = { tabs: defaultTabs, panes: [] as unknown[], reads: 0 };
const values: Record<string, unknown> = {
  View: class {}, div: element, svg: element, image: element, h_flex: element,
  ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
  spaces: () => [{ id: "s1", name: "api", active: true, tabs: snapshot.tabs }],
  panes: () => { snapshot.reads++; return snapshot.panes; },
  run(command: string) { commands.push(command); }, openOverlay() {}, theme: () => ({}),
  window: () => null, shared: () => null, layout: () => null, settings: () => ({ zoom: 1 }),
  localStorage: { getItem: (key: string) => store[key] ?? null, setItem(key: string, value: string) { store[key] = value; } },
};
const Tabs = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class Tabs", "return class Tabs"))(...Object.values(values));

let now = 1_000_000;
function wheel() {
  const view = new Tabs();
  view.init();
  // The mod is plain JS: its handler's shape is the documented ScrollWheelEvent listener.
  const handler = (view.render() as Element).calls.on_scroll_wheel[0] as Handler;
  return (y: number, touch_phase = "moved", lines?: number, ms = 8) => {
    now += ms;
    setSystemTime(new Date(now));
    handler({ delta: { x: 0, y }, delta_lines: lines === undefined ? undefined : { x: 0, y: lines }, touch_phase });
  };
}
beforeEach(() => {
  commands.length = 0;
  Object.assign(snapshot, { tabs: defaultTabs, panes: [], reads: 0 });
});
// Bun runs every test file in one process: give the later ones the real clock.
afterAll(() => setSystemTime());

test("a short touchpad swipe switches one tab", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  expect(commands).toEqual(["tab.next"]);
});

test("a nudge below the threshold switches nothing", () => {
  const send = wheel();
  for (let i = 0; i < 3; i++) send(-5);
  expect(commands).toEqual([]);
});

test("each notch of a smooth-scrolling mouse switches one tab", () => {
  const send = wheel();
  // macOS smooths one notch into about 28 events of 1 px.
  for (let i = 0; i < 28; i++) send(-1, "moved", undefined, 10);
  send(-1, "moved", undefined, 700);
  for (let i = 0; i < 27; i++) send(-1, "moved", undefined, 10);
  expect(commands).toEqual(["tab.next", "tab.next"]);
});

test("a long swipe keeps switching, a tab per 60 px", () => {
  const send = wheel();
  // 20 px for the first tab, then 60 px each: 400 px is seven tabs.
  for (let i = 0; i < 40; i++) send(10, "moved", undefined, 40);
  expect(commands).toEqual(Array(7).fill("tab.prev"));
});

test("a fast flick shows each tab it passes for at least 100 ms", () => {
  const send = wheel();
  // 1200 px within 240 ms: enough for twenty tabs, time for three.
  for (let i = 0; i < 30; i++) send(-40);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.next"]);
});

test("a pause or a turn starts a new gesture", () => {
  const send = wheel();
  for (let i = 0; i < 12; i++) send(-6);
  send(-30, "moved", undefined, 400);
  for (let i = 0; i < 4; i++) send(-5);
  for (let i = 0; i < 12; i++) send(6, "moved", undefined, 20);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

test("each wheel notch switches one tab", () => {
  const send = wheel();
  send(-20, "moved", -1);
  send(-20, "moved", -1);
  send(2, "moved", 0.1);
  expect(commands).toEqual(["tab.next", "tab.next", "tab.prev"]);
});

const label = new Function("View", `${source.replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs")}; return label;`)(class {});

const claude = { terminal: "remote/t2", program: { name: "Claude Code", key: "claude", agent: true }, title: "My task" };
const shell = { terminal: "t1", program: { name: "zsh", key: "shell", shell: true }, title: "vim notes.md" };
const unnamed = { name: "2", named: false };

test("an unnamed tab follows a useful live agent title", () => {
  expect(label(unnamed, claude)).toBe("My task");
  expect(label(unnamed, { ...claude, title: "✦ [web] login" })).toBe("[web] login");
  expect(label(unnamed, { ...claude, title: "[ ! ] ✹  Fix handler\nwith @scope/pkg" })).toBe("Fix handler with @scope/pkg");
});

test("titles are cleaned like the agents mod: emoji kept, glyph before a Codex mark dropped", () => {
  expect(label(unnamed, { ...claude, title: "🔴 login" })).toBe("🔴 login");
  expect(label(unnamed, { ...claude, title: "● [ ! ] x" })).toBe("x");
});

test("a non-task OSC title keeps the program label", () => {
  const generic = ["", "12", "✦", "Claude Code", "CLAUDE", "New session", "Untitled", "t2", "remote/t2", "api", "me@build-box:~/src/api", "~/src/api", "✦ /tmp", "C:/src/api", "✦ C:\\src\\api", "[ . ] \\\\server\\api"];
  for (const title of generic) {
    expect(label(unnamed, { ...claude, cwd: "/src/api", title }, { name: "api" })).toBe("Claude Code");
  }
});

test("an explicit tab title wins, except the program's own name from older saves", () => {
  for (const name of ["2", "fix login"]) expect(label({ name, named: true }, claude)).toBe(name);
  expect(label({ name: "Claude Code", named: true }, claude)).toBe("My task");
  expect(label({ name: "Claude Code", named: true }, { ...claude, title: "" })).toBe("Claude Code");
});

test("unnamed tabs use foreground program, meaningful folder and branch, and safe fallbacks", () => {
  expect(label(unnamed, { ...shell, cwd: "/src/api/", branch: "main" }, { name: "api" })).toBe("zsh");
  expect(label(unnamed, { ...shell, cwd: "C:\\src\\web app\\", branch: "(detached)" }, { name: "api" })).toBe("zsh · web app");
  expect(label(unnamed, { ...shell, program: { name: "Neovim" }, cwd: "/src/api/server", branch: "fix/parser" }, { name: "api" })).toBe("Neovim · server · fix/parser");
  expect(label(unnamed, { ...claude, cwd: "/worktrees/parser", branch: "parser" })).toBe("My task · parser");
  expect(label(unnamed, { terminal: "t1", cwd: "/src/api" })).toBe("api");
  expect(label(unnamed, { terminal: null, mod: "board", title: "board" })).toBe("board");
  expect(label(unnamed, undefined)).toBe("Terminal");
});

test("tab render follows the first agent over other splits and stops when renamed", () => {
  const tab = { id: "t1", active: true, ...unnamed };
  snapshot.tabs = [tab];
  const lead = { ...claude, tab: tab.id };
  snapshot.panes = [{ tab: tab.id, terminal: null, mod: "board" }, { ...shell, tab: tab.id, focused: true },
    lead, { ...lead, terminal: "t3", title: "Other split" }];
  const view = new Tabs();
  view.init();
  const renderedName = () => {
    const root: Element = view.render();
    const item = root.nodes[0].nodes[0];
    expect(item.calls.tooltip).toEqual(item.nodes[0].nodes);
    return item.nodes[0].nodes[0];
  };
  expect(renderedName()).toBe("My task");
  lead.title = "Rewrite parser";
  expect(renderedName()).toBe("Rewrite parser");
  tab.name = "My notes";
  tab.named = true;
  expect(renderedName()).toBe("My notes");
  tab.named = false;
  expect(renderedName()).toBe("Rewrite parser");
  snapshot.panes.splice(2);
  expect(renderedName()).toBe("zsh");
  expect(snapshot.reads).toBe(5);
  expect(commands).toEqual([]);
});

test("agent launches from the new-tab menu leave the tab unnamed", async () => {
  const menuSource = await readFile(new URL("../defaults/mods/new-menu/main.js", import.meta.url), "utf8");
  const launches: unknown[][] = [];
  const globals = {
    ...values, v_flex: element, props: () => ({ overlay: "menu" }), closeOverlay() {}, keys: () => [],
    run: (...args: unknown[]) => launches.push(args),
  };
  const Menu = new Function(...Object.keys(globals), menuSource.replace(/^import .*;\n/gm, "")
    .replace("export default class NewMenu", "return class NewMenu"))(...Object.values(globals));
  const menu = new Menu();
  menu.agents = [{ key: "claude", name: "Claude Code", installed: true, run: ["claude"] }];
  const root: Element = menu.render();
  const findRow = (node: Element): Element | undefined => {
    if (node.calls?.id?.[0] === "claude") return node;
    for (const child of node.nodes ?? []) {
      const found = findRow(child);
      if (found) return found;
    }
  };
  (findRow(root)?.calls.on_click[0] as Handler)(null);
  (root.calls.on_key_down[0] as Handler)({ key: "1", modifiers: {} });
  expect(launches).toEqual(Array(2).fill(["tab.new", { space: "s1", argv: ["claude"] }]));
});
