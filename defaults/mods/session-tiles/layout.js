// The four bits are the top-left, top-right, bottom-left and bottom-right cells.
const slots = [
  { id: "left", label: "Left", cells: 0b0101 },
  { id: "right", label: "Right", cells: 0b1010 },
  { id: "top", label: "Top", cells: 0b0011 },
  { id: "bottom", label: "Bottom", cells: 0b1100 },
  { id: "top-left", label: "Top left", cells: 0b0001 },
  { id: "top-right", label: "Top right", cells: 0b0010 },
  { id: "bottom-left", label: "Bottom left", cells: 0b0100 },
  { id: "bottom-right", label: "Bottom right", cells: 0b1000 },
];
const slotById = new Map(slots.map(slot => [slot.id, slot]));
export const placements = slots.map(({ id, label }) => ({ id, label }));

// An assignment replaces every tile it covers (in whole or part) and moves any
// earlier assignment for this terminal. Assignments are drafts, not tab state.
export function placeTerminal(tiles, terminal, placement) {
  const slot = slotById.get(placement);
  if (!slot || !terminal?.address) return tiles;
  const { address, name } = terminal;
  return [
    ...tiles.filter(tile => tile.address !== address && !(slotById.get(tile.placement).cells & slot.cells)),
    { address, name: name || address, placement },
  ];
}

function pair(type, id, first, second) {
  if (!first && !second) return null;
  const blank = side => ({ type: "row", id: `${id}-empty-${side}`, background: "canvas", children: [] });
  return { type, id, resizable: false, divider: { width: 1 }, children: [first ?? blank(1), second ?? blank(2)] };
}

export function buildSessionTilesSpec(tiles, spaceId) {
  if (!tiles.length || !spaceId) return null;
  const addresses = new Map(tiles.map(tile => [tile.placement, tile.address]));
  const block = placement => {
    const terminal = addresses.get(placement);
    return terminal ? { type: "block", id: `session-tile-${placement}`, content: { terminal } } : null;
  };
  const left = block("left"), right = block("right");
  // A vertical half spans both rows; otherwise horizontal halves span both columns.
  const body = left || right
    ? pair("row", "session-tiles-body",
        left ?? pair("column", "session-tiles-left", block("top-left"), block("bottom-left")),
        right ?? pair("column", "session-tiles-right", block("top-right"), block("bottom-right")))
    : pair("column", "session-tiles-body",
        block("top") ?? pair("row", "session-tiles-top", block("top-left"), block("top-right")),
        block("bottom") ?? pair("row", "session-tiles-bottom", block("bottom-left"), block("bottom-right")));
  const summary = tiles.map(tile => `${slotById.get(tile.placement).label}: ${tile.name}`).join(" · ");
  return {
    kind: "window",
    key: "session-tiles",
    width: 0.9,
    height: 0.85,
    layout: {
      type: "column",
      id: "session-tiles-root",
      resizable: false,
      children: [
        {
          type: "block",
          id: "session-tiles-header",
          size: { px: 32 },
          content: { mod: "session-tiles", props: { mode: "header", title: "Session tiles", space: spaceId, summary, tiles } },
        },
        body,
      ],
    },
  };
}
