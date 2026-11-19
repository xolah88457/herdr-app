import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildSessionTilesSpec, placements, placeTerminal } from "../defaults/mods/session-tiles/layout.js";

// Run the shipped picker and header callbacks without a live window. Use the
// real placement/layout helpers; only the GPUI elements and Herdr bridge are fake.
class Element {
  nodes: Element[] = [];
  calls: Record<string, any[]> = {};
  constructor() {
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? (target as any)[key] : (...args: any[]) => {
        if (key === "child") target.nodes.push(args[0]);
        else if (key === "children") target.nodes.push(...args[0]);
        else if (key === "when") { if (args[0]) args[1](proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/session-tiles/main.js", import.meta.url), "utf8");
const element = () => new Element();
const fixtures = [
  { pane: "one", tab: "active", terminal: "t1", title: "One", focused: true },
  { pane: "two", tab: "earlier", terminal: "t2", title: "Two" },
  { pane: "mod", tab: "active", terminal: null, title: "Files" },
  { pane: "other", tab: "unrelated", terminal: "elsewhere:t3", title: "Other" },
];
function setup(initial: Record<string, any> = {}, paneList = fixtures) {
  const p = { overlay: "picker", ...initial };
  let active = "space";
  const opened: any[] = [];
  const closed: string[] = [];
  const values = {
    View: class {}, div: element, v_flex: element, h_flex: element,
    closeOverlay(id: string) { closed.push(id); },
    openOverlay(spec: any) { opened.push(spec); return "new-overlay"; },
    panes: () => paneList,
    props: () => p,
    spaces: () => [
      { id: "space", active: active === "space", tabs: [{ id: "active", name: "Active" }, { id: "earlier", name: "Earlier" }] },
      { id: "away", active: active === "away", tabs: [{ id: "unrelated", name: "Away" }] },
    ],
    theme: () => ({ selected: "selected", muted: "muted" }),
    openSessionTiles(tiles: any[], space: string) { return values.openOverlay(buildSessionTilesSpec(tiles, space)); },
    placements, placeTerminal,
  };
  const SessionTiles = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "")
    .replace("export default class SessionTiles", "return class SessionTiles"))(...Object.values(values));
  const cx = {
    focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {},
  };
  const view = new SessionTiles();
  view.init(p, cx);
  const render = () => view.render(cx);
  function find(id: string, root: Element = render()): Element | undefined {
    if (root?.calls?.id?.[0] === id) return root;
    for (const child of root?.nodes ?? []) {
      const match = find(id, child);
      if (match) return match;
    }
  }
  return {
    opened, closed, find, render,
    click(id: string) { find(id)!.calls.on_click[0]({}, cx); },
    switchSpace() { active = "away"; },
  };
}

const header = (spec: any) => spec.layout.children[0].content.props;
const tiled = (spec: any) => {
  const addresses: Record<string, string> = {};
  const visit = (node: any) => {
    if (node.content?.terminal) addresses[node.id] = node.content.terminal;
    for (const child of node.children ?? []) visit(child);
  };
  visit(spec.layout);
  return addresses;
};

test("standalone picker defaults to the focused pane and stages opposite halves", () => {
  const picker = setup();
  expect(picker.find("st-session-one")?.calls.bg).toEqual(["selected"]);
  expect(picker.find("st-session-other")).toBeUndefined();
  expect(picker.find("st-session-mod")).toBeUndefined();
  picker.click("st-place-left");
  expect(picker.opened).toEqual([]);
  expect(picker.closed).toEqual([]);
  picker.click("st-open");
  const [window] = picker.opened;
  expect(window.kind).toBe("window");
  expect(header(window).space).toBe("space");
  expect(tiled(window)).toEqual({ "session-tile-left": "t1", "session-tile-right": "t2" });
  expect(picker.closed).toEqual(["picker"]);
});

test("menu can target an inactive tab in the source space; corners are explicit", () => {
  const picker = setup({ pane: "two" });
  expect(picker.find("st-session-two")?.calls.bg).toEqual(["selected"]);
  picker.click("st-place-bottom-right");
  picker.click("st-session-one");
  picker.click("st-place-top-left");
  picker.click("st-remove");
  picker.click("st-open");
  expect(tiled(picker.opened[0])).toEqual({ "session-tile-bottom-right": "t2" });
});

test("picker refuses an outside-space target or stale apply after switching spaces", () => {
  const outside = setup({ pane: "other" });
  expect(outside.find("st-place-right")?.calls.on_click).toBeUndefined();
  const picker = setup();
  picker.click("st-place-top-left");
  const apply = picker.find("st-open")!.calls.on_click[0];
  picker.switchSpace();
  apply({}, { stop_propagation() {} });
  expect(picker.find("st-session-one")).toBeUndefined();
  expect(picker.find("st-session-other")).toBeUndefined();
  expect(picker.opened).toEqual([]);
  expect(picker.closed).toEqual([]);
});

test("header shows a muted, truncating placement summary with a full tooltip", () => {
  const picker = setup({}, fixtures.map((pane) => pane.pane === "two" ? { ...pane, title: pane.terminal } : pane));
  picker.click("st-place-left");
  picker.click("st-open");
  const view = setup({ ...header(picker.opened[0]), overlay: "tile-window" });
  const summary = view.find("st-summary")!;
  expect(summary.nodes).toEqual(["Left: One · Right: Earlier"]);
  expect(summary.calls.tooltip).toEqual(summary.nodes);
  expect(summary.calls.text_color).toEqual(["muted"]);
  expect(summary.calls.truncate).toEqual([]);
});

test("header reopens the same picker with placements and closes only its window", () => {
  const tiles = [{ address: "t2", name: "Two", placement: "bottom-right" }];
  const window = buildSessionTilesSpec(tiles, "space");
  const view = setup({ ...header(window), overlay: "tile-window" });
  view.click("st-edit");
  expect(view.opened).toEqual([{
    kind: "dialog", mod: "session-tiles", width: 480, height: 400, props: { space: "space", tiles },
  }]);
  expect(view.closed).toEqual([]);
  const editor = setup({ ...view.opened[0].props, overlay: "editor" });
  expect(editor.find("st-session-two")?.calls.bg).toEqual(["selected"]);
  expect(editor.find("st-open")?.calls.on_click).toBeDefined();
  editor.click("st-place-top-right");
  editor.click("st-open");
  expect(editor.opened[0].key).toBe(window.key);
  expect(tiled(editor.opened[0])).toEqual({ "session-tile-top-right": "t2" });
  expect(editor.closed).toEqual(["editor"]);
  view.click("st-close");
  expect(view.closed).toEqual(["tile-window"]);
});

test("header queues one close request when the source space is left", () => {
  const view = setup({ mode: "header", space: "space", overlay: "tile-window" });
  view.render();
  expect(view.closed).toEqual([]);
  view.switchSpace();
  view.render();
  view.render();
  expect(view.closed).toEqual(["tile-window"]);
});
