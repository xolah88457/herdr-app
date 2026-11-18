import { openOverlay } from "herdr";
import { buildSessionTilesSpec } from "./layout.js";

export { buildSessionTilesSpec, placements, placeTerminal } from "./layout.js";

export function openSessionTiles(tiles, spaceId) {
  const spec = buildSessionTilesSpec(tiles, spaceId);
  return spec ? openOverlay(spec) : null;
}
