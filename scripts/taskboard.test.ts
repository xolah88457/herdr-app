import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

class Element {
  nodes: (Element | string)[] = [];
  name: string | undefined = undefined;
  click: (() => void) | undefined = undefined;
  children!: (children: Element[]) => this;
}
function element() {
  const node = new Element();
  const proxy: Element = new Proxy(node, {
    get(target, key: string) {
      if (key === "child") return (child: Element | string) => { node.nodes.push(child); return proxy; };
      if (key === "children") return (children: Element[]) => { node.nodes.push(...children); return proxy; };
      if (key === "when") return (yes: boolean, draw: (el: Element) => void) => { if (yes) draw(proxy); return proxy; };
      if (key === "id") return (id: string) => { node.name = id; return proxy; };
      if (key === "on_click") return (click: () => void) => { node.click = click; return proxy; };
      return key in target ? Reflect.get(target, key) : () => proxy;
    },
  });
  return proxy;
}
const theme = () => ({});
const root = new URL("../defaults/", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const board = await read("mods/taskboard/main.js");
const tabs = await read("mods/tabs/main.js");
const main = JSON.parse(await read("layouts/main.json"));
const base = { View: class {}, div: element, h_flex: element, v_flex: element, theme };
function make(source: string, api: Record<string, unknown>) {
  const values = { ...base, ...api };
  const View = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class", "return class"))(...Object.values(values));
  return new View();
}
const find = (e: Element, id: string): Element | undefined => e.name === id ? e
  : e.nodes.filter(child => typeof child !== "string").map(child => find(child, id)).find(Boolean);
const text = (e: Element): string => e.nodes.map(child => typeof child === "string" ? child : text(child)).join(" ");

type Location = { id: string; machine: string | null; folder: string };
type Exec = (program: string, args: string[], options: { cwd: string; on: string | null; timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
const local: Location = { id: "one", machine: null, folder: "/code/one/src" };
const remote: Location = { id: "remote/two", machine: "remote", folder: "/code/two/src" };
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
function harness(exec: Exec) {
  let space: Location | undefined = local;
  const pending: Promise<void>[] = [], commands: unknown[] = [];
  const view = make(board, {
    checking: () => false, spaces: () => space ? [{ ...space, active: true }] : [], exec,
    run: (...args: unknown[]) => commands.push(args), Scrollbar: { vertical: element },
    v_virtual_list: (_id: string, len: number, _height: number, _key: unknown, render: Function) =>
      element().children(render({ start: 0, end: len })),
  });
  let notifications = 0;
  const cx = { spawn: (task: (cx: unknown) => Promise<void>) => pending.push(task(cx)), notify() { notifications++; } };
  const renderCx = { ...cx, notify() { throw new Error("notify is not allowed during render"); } };
  return {
    switchTo: (next?: Location) => { space = next; }, render: (): Element => view.render(renderCx),
    refresh: () => view.refresh(cx), pending, commands, notifications: () => notifications,
  };
}

test("Tasks toggles the default side panel and restores each space's panel", () => {
  const tree = structuredClone(main);
  const panel = tree.children.find((x: { id: string }) => x.id === "work").children[1].children[1];
  const body = panel.children[0];
  expect(body.children.find((x: { id: string }) => x.id === "taskboard").content.mod).toBe("taskboard");
  expect(panel.hidden).toBe(true);
  let id = "one";
  const store = new Map();
  const view = make(tabs, {
    svg: element, image: element, ScrollHandle: { new: () => ({}) }, spaces: () => [{ id, active: true }],
    panes: () => [], openOverlay() {}, window: () => null, settings: () => ({ zoom: 1 }), layout: () => tree,
    shared: () => ["files", "changes"], localStorage: { getItem: store.get.bind(store), setItem: store.set.bind(store) },
    run(command: string, args: { child?: string }) {
      if (command === "layout.select") body.active = args.child;
      if (command === "layout.show") panel.hidden = false;
      if (command === "layout.hide") panel.hidden = true;
    },
  });
  view.init();
  const click = (panel: string) => find(view.render(), `panel-${panel}`)!.click!();
  click("taskboard");
  expect([panel.hidden, body.active]).toEqual([false, "taskboard"]);
  view.render();
  id = "two";
  view.render();
  expect(panel.hidden).toBe(true);
  click("changes");
  view.render();
  id = "one";
  view.render();
  expect([panel.hidden, body.active]).toEqual([false, "taskboard"]);
  click("taskboard");
  expect(panel.hidden).toBe(true);
  id = "two";
  view.render();
  expect([panel.hidden, body.active]).toEqual([false, "changes"]);
  body.children = body.children.filter((c: { id: string }) => c.id !== "taskboard");
  expect(find(view.render(), "panel-taskboard")).toBeUndefined();
});

test("a late local task response cannot replace a remote space's board or launch destination", async () => {
  let finish!: (value: ReturnType<typeof ok>) => void;
  let started!: () => void;
  const localStarted = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve; });
  const h = harness(async (program, args, options) => {
    expect(program).toBe("tsk");
    if (!options.on) { started(); return delayed; }
    expect(args).toEqual(args.includes("--done") ? ["list", "--json", "--done"] : ["list", "--json"]);
    expect(options.cwd).toBe(remote.folder);
    return ok(args.includes("--done") ? "[]" : '[{"number":2,"status":"ready","title":"Remote task"}]');
  });
  h.render();
  await localStarted;
  h.switchTo(remote);
  expect(text(h.render())).toContain("Loading tasks");
  await h.pending[1];
  const notifications = h.notifications();
  finish(ok('[{"number":1,"status":"open","title":"Old local task"}]'));
  await h.pending[0];
  const current = h.render();
  expect(text(current)).toContain("Ready · 1 T2 Remote task");
  expect(text(current)).not.toContain("Old local task");
  expect(h.notifications()).toBe(notifications);
  const open = find(current, "taskboard-open")!.click!;
  open();
  h.switchTo(local);
  open(); // A click from the old frame must not start a terminal after switching.
  expect(h.commands).toEqual([["tab.new", { name: "tsk", space: remote.id, folder: remote.folder, argv: ["tsk"] }]]);
});

test("missing tsk is actionable, and refresh retries without launching a terminal", async () => {
  let found = false;
  const h = harness(async () => {
    if (!found) throw new Error("cannot start tsk: program not found");
    return ok("[]");
  });
  h.switchTo(remote);
  h.render();
  await h.pending[0];
  const failed = h.render();
  expect(text(failed)).toContain("tsk not found on remote. Install it and put it on PATH, then refresh.");
  expect(find(failed, "taskboard-open")).toBeUndefined();
  expect(h.commands).toEqual([]);
  found = true;
  h.refresh();
  await h.pending[1];
  expect(text(h.render())).toContain("No tasks to show.");
  expect(find(h.render(), "taskboard-open")).toBeDefined();
});

test("a missing or relative working folder never runs an unscoped query", () => {
  const h = harness(async () => { throw new Error("should not start a process"); });
  for (const space of [undefined, { ...local, folder: "" }, { ...local, folder: "src" }]) {
    h.switchTo(space);
    expect(text(h.render())).toContain("absolute folder path");
    expect(find(h.render(), "taskboard-open")).toBeUndefined();
  }
  expect(h.pending).toHaveLength(0);
});

const tsk = process.env.TSK_TEST_BINARY && resolve(process.env.TSK_TEST_BINARY);
test.skipIf(!tsk)("real tsk picks the repo from a nested cwd and Desk from a non-Git cwd", async () => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), "herdr-taskboard-")));
  try {
    const env = { ...process.env, TSK_STATE_DIR: join(area, "tsk-state") };
    delete (env as NodeJS.ProcessEnv).HERDR_PLUGIN_CONTEXT_JSON;
    const project = join(area, "git repo"), nested = join(project, "src"), other = join(area, "not git");
    mkdirSync(nested, { recursive: true });
    mkdirSync(other);
    const exec: Exec = async (program, args, { cwd }) => {
      const r = spawnSync(program === "tsk" ? tsk! : program, args, { cwd, env, encoding: "utf8" });
      if (r.error) throw r.error;
      return { code: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
    };
    const seed = async (program: string, args: string[]) => {
      const result = await exec(program, args, { cwd: project, on: null, timeout: 5000 });
      if (result.code !== 0) throw new Error(result.stderr);
    };
    await seed("git", ["init", "-q"]);
    await seed("tsk", ["add", "-t", "Git task", "--project", project]);
    await seed("tsk", ["add", "-t", "Directory task", "--project", other]);
    await seed("tsk", ["add", "-t", "Shared desk task", "--desk"]);
    const h = harness(exec);
    h.switchTo({ ...local, folder: nested });
    h.render();
    await h.pending[0];
    const repoBoard = h.render();
    expect(text(repoBoard)).toContain("Open · 1 T1 Git task");
    expect(text(repoBoard)).not.toContain("Shared desk task");
    find(repoBoard, "taskboard-open")!.click!();
    await seed("tsk", ["status", "T1", "done"]);
    h.refresh();
    await h.pending[1];
    expect(text(h.render())).toContain("Done · 1 T1 Git task");
    h.switchTo({ ...local, id: "other", folder: other });
    h.render();
    await h.pending[2];
    const deskBoard = h.render();
    expect(text(deskBoard)).toContain("Open · 1 T3 Shared desk task");
    expect(text(deskBoard)).not.toContain("Directory task");
    expect(text(deskBoard)).not.toContain("Git task");
    find(deskBoard, "taskboard-open")!.click!();
    expect(h.commands).toEqual([
      ["tab.new", { name: "tsk", space: local.id, folder: nested, argv: ["tsk"] }],
      ["tab.new", { name: "tsk", space: "other", folder: other, argv: ["tsk"] }],
    ]);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
