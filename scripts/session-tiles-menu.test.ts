import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/menu/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "").replace("export default class", "class");
const panes = [
  { pane: "p1", terminal: "t1", tab: "editor", focused: true },
  { pane: "p2", terminal: null, tab: "notes" },
  { pane: "host/p3", terminal: "host/t1", tab: "agent" },
];
const overlays: unknown[] = [], commands: unknown[] = [];
const { items, Menu } = new Function("panes", "terminals", "View", "props", "closeOverlay", "openOverlay", "run",
  `${source}; return { items, Menu };`)(() => panes, () => [], class {}, () => ({}), () => {},
    (o: unknown) => overlays.push(o), (...c: unknown[]) => commands.push(c));

const tile = (tab: string, target: object) => items({ tab, target }, null).find(([label]: string[]) => label === "Tile sessions…");

test("both tab and pane menus tile the clicked session, not the active one", () => {
  const clicked = tile("pane", { pane: "host/p3", terminal: "host/t1" });
  expect(tile("tab", { id: "agent" })).toEqual(clicked);
  new Menu().choose(clicked);
  expect(overlays).toEqual([expect.objectContaining({ mod: "session-tiles", props: { pane: "host/p3" } })]);
  expect(commands).toEqual([]);
});

test("mod-only tabs and terminals outside a space are not placement targets", () => {
  expect(tile("tab", { id: "notes" })).toBeUndefined();
  expect(tile("pane", { pane: "p2" })).toBeUndefined();
  expect(tile("pane", { pane: "overlay-t1", terminal: "t1" })).toBeUndefined();
});
