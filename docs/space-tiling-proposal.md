# Proposal: tile whole spaces in the Herdr layout

**Phase two is not complete.** The existing [Tile sessions](../README.md#tile-sessions) action opens a floating session window. It preserves the source tabs, but it does not tile the workspace. The space menu has no placement action; dragging between sidebar rows reorders spaces.

Right-click a space in the Herdr sidebar and choose Left, Right, Top, Bottom or one of the four corners. For example, while working in API, right-click Web and choose Right: API stays on the left and Web appears on the right. Each tile shows the space's selected tab, including its existing split terminals and mod panes. Clicking a pane should give it keyboard focus without moving either tile. Returning to a single space must not close anything. Dragging a sidebar space onto an edge or corner of the main content area must produce the same placement as the menu. Dragging between sidebar rows must continue to reorder them. Cross-tab terminal placement must use that same content area, not a picker followed by a floating window. Both source tabs stay intact.

## Decision requested

Can the desktop layout renderer host the selected tab of a **specified space**, not just the globally active space? Keep placement choices in the desktop UI and out of the shared machine document. Do not create new terminals, move panes between spaces or introduce a herdr-core protocol change.

- **Does the app act on it?** Yes. It must attach and size the visible views, render pane headers, and route keyboard and pointer actions to the intended pane.
- **What can only the app see?** The window owns view attachment and keyboard focus. `panes()` lists panes but does not expose a reusable native tab view. In `src/window.rs`, both `visible()` and `render_block()` resolve tab content through `model.active_tab()`. Two tab blocks therefore do not supply two independently selectable spaces.
- **Can mods do this correctly today?** A mod can arrange explicit terminal blocks in rows and columns. Those blocks do not host a space's selected tab with its split tree, mod instances, and native pane behavior. Reconstructing a second copy of that tree in a mod would create competing owners for the same layout.

## Acceptance checks after approval

1. Start with API selected. Drag Web from the sidebar to the right edge of the main content area. API stays left; Web appears right. Verify the same result using Web’s context menu. Neither placement leaves a tiling overlay open. Repeat for top/bottom and a corner. A split terminal and a mod pane in either project stay visible and usable.
2. Place four distinct spaces in the four corners. Type a different marker into each terminal; input reaches only the clicked tile. Switching tabs in one space leaves the other three in place.
3. Move an already tiled space without duplicating it. Remove a tile or return to the single-space view; its processes and project structure survive.
4. Close a tiled space or disconnect its machine. The other tiles remain usable; no stale tile sends input to another terminal. A second client keeps its own layout and focus.

5. In one space, tile two live terminals from different tabs in the main content area. Type into each, then untile: the original tabs, splits, and sessions are unchanged. Canceling a drag must not move a pane, close a session, or change the sidebar order.

Verify these interactions with a build of the branch binary in an isolated app home and core. The existing mod-only phase preview uses the installed renderer and cannot verify a native renderer change.

Phase one (workspace tools) and changes to the standalone Terminals layout are outside this branch.
