import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// What a click in the Settings window writes to settings.json, without a window or a core.
const source = await readFile(new URL("../defaults/frame/settings/main.js", import.meta.url), "utf8");
// settings.json as the mod sees it through readTextFile / writeTextFile.
const disk: { raw: string | null; writes: number; fail?: string; readFail?: string; toasts: any[] } = { raw: null, writes: 0, toasts: [] };
const preferences = new Map<string, unknown>();
const namedThemes = [
  { name: "atom-one-dark", light: false, colors: {} },
  { name: "My personal theme", light: true, colors: {} },
];
const commands: unknown[][] = [];

// Keep the render tree and click handlers, but ignore native styling.
class Element {
  nodes: (Element | string)[] = [];
  key?: string;
  click?: (event: unknown, cx: unknown) => void;
  id(key: string) { this.key = key; return this; }
  child(node: Element | string) { this.nodes.push(node); return this; }
  children(nodes: (Element | string)[]) { this.nodes.push(...nodes); return this; }
  content(node: Element) { return this.child(node); }
  when(condition: boolean, build: (el: Element) => Element) { return condition ? build(this) : this; }
  on_click(click: Element["click"]) { this.click = click; return this; }
  find(key: string): Element | undefined {
    if (this.key === key) return this;
    for (const node of this.nodes) {
      if (node instanceof Element) {
        const found = node.find(key);
        if (found) return found;
      }
    }
  }
  text(): string {
    return this.nodes.map(node => node instanceof Element ? node.text() : (node ?? "")).join(" ").trim();
  }
}
const element = () => new Proxy(new Element(), {
  get: (target, prop, self) => prop in target ? Reflect.get(target, prop, self) : () => self,
});

const values: Record<string, any> = {
  shared: (key: string) => preferences.get(key),
  setShared: (key: string, value: unknown) => preferences.set(key, value),
  div: element,
  h_flex: element,
  v_flex: element,
  svg: element,
  Popup: { new: (id: string, trigger: Element) => element().id(id).child(trigger) },
  settings: () => ({ theme_light: "paper", theme_dark: "atom-one-dark" }),
  themes: () => namedThemes,
  layouts: () => [],
  run: (...args: unknown[]) => { commands.push(args); },
  View: class {},
  appHome: () => "/home",
  notify: (n: any) => { disk.toasts.push(n); },
  readTextFile: async () => {
    if (disk.readFail) throw new Error(disk.readFail);
    return disk.raw;
  },
  writeTextFile: async (_path: string, text: string, expected: string | null) => {
    disk.writes++;
    if (disk.fail) throw new Error(disk.fail);
    if (expected !== disk.raw) throw new Error("changed since read");
    disk.raw = text;
  },
};
const names = [...source.matchAll(/^import \{([^}]*)\}/gm)].flatMap(m => m[1].split(",").map(n => n.trim()));
const args = names.map(name => values[name] ?? (() => undefined));
const Settings = new Function(...names, source.replace(/^import .*;\n/gm, "").replace("export default class Settings", "return class Settings"))(...args);

/** Runs `edit` through the Settings window's change() on `raw`; the toasts it posts. */
async function change(raw: string | null, edit: (q: Record<string, any>) => void, fail?: string, readFail?: string) {
  Object.assign(disk, { raw, writes: 0, fail, readFail, toasts: [] });
  const view = new Settings();
  let done: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  view.change(edit, { spawn: (f: (cx: any) => Promise<void>) => f({ notify: () => done() }) });
  await finished;
  return { view, toasts: disk.toasts };
}

test("Pi subagents defaults to Herdr and the switch persists across Settings views", () => {
  preferences.clear();
  for (const expected of [false, true, false]) {
    const view = new Settings();
    view.heading = view.row = () => null;
    view.toggle = (_t: unknown, id: string, on: boolean, click: () => void) => {
      expect(id).toBe("st-pi-tmux");
      expect(on).toBe(expected);
      click();
      expect(preferences.get("pi-subagents.tmux")).toBe(!expected);
    };
    view.pi({});
  }
});

test("Look offers an independent terminal theme and saves selections from the picker", async () => {
  const original = { theme: "paper", appearance: "dark", font_size: 15 };
  Object.assign(disk, { raw: JSON.stringify(original), writes: 0, fail: undefined, readFail: undefined, toasts: [] });
  commands.length = 0;
  const view = new Settings();
  view.handle = { focus() {} };
  view.layoutPicker = () => element();
  await view.load();

  const pending: Promise<void>[] = [];
  const cx = { spawn: (f: (cx: unknown) => Promise<void>) => pending.push(f(cx)), notify() {} };
  const look = (): Element => view.look({}, cx);
  const click = (key: string) => look().find(key)!.click!(null, cx);
  const trigger = "st-terminal-theme";
  expect(look().text()).toContain("Terminal theme");
  expect(look().find(trigger)!.text()).toContain("Atom One Light");
  expect(disk.writes).toBe(0);

  for (const [name, label] of [
    ["My personal theme", "My personal theme"],
    ["atom-one-dark", "atom-one-dark"],
    ["follow", "Follow Herdr"],
    ["atom-one-light", "Atom One Light"],
  ]) {
    click(trigger);
    const option = `st-terminal-theme-option-${name}`;
    expect(look().find(option)!.text()).toContain(label);
    click(option);
    await Promise.all(pending.splice(0));
    expect(look().find(option)).toBeUndefined();
    expect(look().find(trigger)!.text()).toContain(label);
    expect(JSON.parse(disk.raw!)).toEqual({ ...original, terminal_theme: name });
  }

  expect(disk.writes).toBe(4);
  expect(disk.toasts).toEqual([]);
  expect(commands).toEqual([]);
});

test("a change writes settings.json, keeping what else it holds", async () => {
  const { view, toasts } = await change('{"font_size": 15}', (q) => (q.dock_bounce = true));
  expect(JSON.parse(disk.raw!)).toEqual({ font_size: 15, dock_bounce: true });
  expect(view.person).toEqual({ font_size: 15, dock_bounce: true });
  expect(toasts).toEqual([]);
});

test("a broken settings.json is never written over, and says so", async () => {
  const broken = '{"font_size": 15, "theme": "x",}';
  const { toasts } = await change(broken, (q) => (q.dock_bounce = true));
  expect(disk.raw).toBe(broken);
  expect(disk.writes).toBe(0);
  expect(toasts).toEqual([{ title: "settings.json has errors: fix it first", level: "error" }]);
});

test("settings.json that isn't an object counts as broken", async () => {
  for (const raw of ["null", "[]", "3"]) {
    const { toasts } = await change(raw, (q) => (q.dock_bounce = true));
    expect(disk.raw).toBe(raw);
    expect(disk.writes).toBe(0);
    expect(toasts).toEqual([{ title: "settings.json has errors: fix it first", level: "error" }]);
  }
});

test("a write that keeps failing is reported, not dropped", async () => {
  const { toasts } = await change("{}", (q) => (q.dock_bounce = true), "read-only file system");
  expect(disk.writes).toBe(3);
  expect(disk.raw).toBe("{}");
  expect(toasts).toEqual([{ title: "Not saved to settings.json", body: "read-only file system", level: "error" }]);
});

test("a settings.json that can't be read, or an edit that throws, says why", async () => {
  const unread = await change("{}", (q) => (q.dock_bounce = true), undefined, "permission denied");
  expect(disk.writes).toBe(0);
  expect(unread.toasts).toEqual([{ title: "Cannot read settings.json", body: "permission denied", level: "error" }]);
  const thrown = await change("{}", () => { throw new Error("no such section"); });
  expect(disk.writes).toBe(0);
  expect(thrown.toasts).toEqual([{ title: "Cannot read settings.json", body: "no such section", level: "error" }]);
});
