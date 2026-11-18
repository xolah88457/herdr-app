import { test } from "bun:test";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { buildSessionTilesSpec, placements, placeTerminal } from "../defaults/mods/session-tiles/layout.js";

type Draft = ReturnType<typeof placeTerminal>;
const put = (draft: Draft, placement: string, address = placement) =>
  placeTerminal(draft, { address, name: `Name ${address}` }, placement);

const rectangles = {
  left: [0, 0, 1, 2],
  right: [1, 0, 1, 2],
  top: [0, 0, 2, 1],
  bottom: [0, 1, 2, 1],
  "top-left": [0, 0, 1, 1],
  "top-right": [1, 0, 1, 1],
  "bottom-left": [0, 1, 1, 1],
  "bottom-right": [1, 1, 1, 1],
};

test("placement replaces overlapping slots and moves an already staged terminal without mutating the draft", () => {
  const four = placements.slice(4).reduce<Draft>((draft, { id }) => put(draft, id), []);
  const next = put(four, "top", "bottom-left");
  deepStrictEqual(four.map(tile => tile.placement), placements.slice(4).map(({ id }) => id));
  deepStrictEqual(next, [
    { address: "bottom-right", name: "Name bottom-right", placement: "bottom-right" },
    { address: "bottom-left", name: "Name bottom-left", placement: "top" },
  ]);
  const replace = put(next, "top-left", "replacement");
  deepStrictEqual(replace.map(tile => tile.placement), ["bottom-right", "top-left"]);
  deepStrictEqual(put(replace, "top-left", "again").map(tile => tile.address), ["bottom-right", "again"]);
  equal(put(four, "center"), four);
  equal(put(four, "left", ""), four);
});

type LayoutNode = {
  type: string;
  id: string;
  content?: { terminal?: string };
  children?: (LayoutNode | null)[];
};

function bounds(node: LayoutNode, x = 0, y = 0, w = 2, h = 2): [string, number[]][] {
  if (node.content?.terminal) return [[node.content.terminal, [x, y, w, h]]];
  if (!node.children?.length) return [];
  equal(node.children.length, 2);
  const [a, b] = node.children;
  ok(a && b);
  if (node.type === "row") return [...bounds(a, x, y, w / 2, h), ...bounds(b, x + w / 2, y, w / 2, h)];
  equal(node.type, "column");
  return [...bounds(a, x, y, w, h / 2), ...bounds(b, x, y + h / 2, w, h / 2)];
}

test("native splits preserve all named rectangles, including partial and mixed layouts", () => {
  deepStrictEqual(placements.map(({ id }) => id), Object.keys(rectangles));
  for (const ids of [
    ...Object.keys(rectangles).map(id => [id]),
    ["left", "right"],
    ["top", "bottom"],
    ["right", "top-left", "bottom-left"],
    ["bottom", "top-left", "top-right"],
    ["top-left", "top-right", "bottom-left", "bottom-right"],
  ]) {
    const draft = ids.reduce<Draft>((state, id) => put(state, id), []);
    const spec = buildSessionTilesSpec(draft, "space-1");
    const body = spec?.layout.children[1];
    ok(body);
    deepStrictEqual(Object.fromEntries(bounds(body)), Object.fromEntries(ids.map(id => [id, rectangles[id]])));
  }
});

test("overlay is one replaceable, non-kept window with a named exit header and existing terminal addresses", () => {
  const draft = placeTerminal([], { address: "remote:t1" }, "left");
  const first = buildSessionTilesSpec(draft, "space-1");
  const both = put(draft, "right", "t2");
  const second = buildSessionTilesSpec(both, "space-2");
  ok(first && second);
  equal(first.kind, "window");
  equal(first.key, "session-tiles");
  equal(second.key, first.key);
  equal("keep" in first, false);
  equal("mod" in first, false);
  deepStrictEqual(second.layout.children[0], {
    type: "block",
    id: "session-tiles-header",
    size: { px: 32 },
    content: {
      mod: "session-tiles",
      props: { mode: "header", title: "Session tiles", space: "space-2", summary: "Left: remote:t1 · Right: Name t2", tiles: both },
    },
  });
  const indexed: string[] = [];
  const index = (node: LayoutNode) => {
    indexed.push(node.id);
    for (const child of node.children ?? []) if (child) index(child);
  };
  index(second.layout);
  equal(new Set(indexed).size, indexed.length);
  equal(buildSessionTilesSpec([], "space-1"), null);
  equal(buildSessionTilesSpec(draft, ""), null);
});
