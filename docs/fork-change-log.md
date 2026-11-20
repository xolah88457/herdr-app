# Herdr fork: implementation log for code review

This is a map for reviewing and optimizing the fork, not an app release note. **There are three code snapshots to review, not one checkout containing every change.** The original three phases and the manual tmux fix are on fork `master`. Direct dragging and native Pi subagents are separate experiments based on that same `master`. Reviewing only the latest Pi branch would miss the drag and header work. Comparing the two experiment tips directly would misleadingly show one experiment being deleted in favor of the other.

## 1. Review boundaries

| Scope | Base → reviewed tip | Net tracked changes | Where it lives |
|---|---|---:|---|
| A. Integrated workspace tools, tiling and Pi/tmux | `317e673` → `c4e03d0` | 38 files; +2,743 / −105 lines | [Fork master diff](https://github.com/xolah88457/herdr-app/compare/317e673...c4e03d0); PRs [1](https://github.com/xolah88457/herdr-app/pull/1), [2](https://github.com/xolah88457/herdr-app/pull/2), [3](https://github.com/xolah88457/herdr-app/pull/3), [4](https://github.com/xolah88457/herdr-app/pull/4) |
| B. Direct drag, full-footprint previews and inline titles | `c4e03d0` → `086ae01` | 15 files; +529 / −95 lines | [`feat/workspace-direct-drag`, PR 5](https://github.com/xolah88457/herdr-app/pull/5) |
| C. Native Pi worker experiment and backend setting | `c4e03d0` → `ce61ef1` | 14 files; +755 / −17 lines | [`experiment/pi-native-panes`, PR 6](https://github.com/xolah88457/herdr-app/pull/6) |

Counts compare trees, including tests and documentation. They are not the sum of commit stats: code added and then removed during a phase cancels out. The same file may appear in multiple scopes. There are **no net whole-file deletions or renames** in these three diffs; there are meaningful code and UI removals, listed below. This log excludes itself, upstream-only development before the chosen baseline, unrelated dirty working copies, private Pi settings and generated binaries. Links in the file ledger point to specific revisions so they work even if branches subsequently move.

## 2. Integrated changes (A)

### Task board: `tsk` owns the data; the mod owns the view

**Entry point:** the main layout contains a `taskboard` block. `Taskboard.refresh` takes the active space's identity, machine and folder as its context. It requires an absolute folder and executes `tsk list --json`, then `tsk list --json --done`, in the relevant context. This matters: listing tasks in the app's own cwd could silently produce a valid board for the wrong project. The mod validates the result, groups tasks for display, distinguishes an empty board from an error, and provides an explicit Refresh. `Open tsk` opens the interactive tool in a tab in the same space and folder; the board does not implement a second writer to the task database.

**Review boundary:** slow or failed commands can return after the active space changes. Do not remove the context/current-state checks to save a lookup. When measuring refresh costs, distinguish subprocess startup, the two queries and rendering; the done query is not redundant merely because both calls use `list`. The render fixture in `src/mods/render_tests.rs` was taught these specific query shapes, not made permissive for all external commands.

### Automatic tab names and the Entwurf launcher

`leadPanes` selects a representative per tab from the pane list: an agent first, otherwise a terminal, otherwise a mod. The old approach repeatedly searched panes per tab and allowed a program-like manual name to follow a changing title. The new `label` treats `tab.named` as authoritative, including a user explicitly naming a tab after its program. Automatic labels are **computed for display**, not written into the model. They discard generic agent titles, bare paths and prompts; derive a folder name with Windows/Unix handling; and omit duplicate components and uninformative branches. Changing focus between splits should not rename the tab.

The local macOS/Linux `+` menu gained **Entwurf Pi in tmux** and a separate setup action. Launch checks the existing tools, creates a private tmux server and runs `entwurf pi`; it does not register packages or install dependencies. Setup requires confirmation and uses the focused terminal's folder. This is a distinct workflow from the later **Pi subagents** entry. A change to the new backend preference must not reinterpret the Entwurf action, numbered agent shortcuts, or arbitrary shell invocations of `pi`.

### Two tiling implementations, with different contracts

1. **Floating prototype.** The `session-tiles` JS mod selects live terminals, maps placements to a layout specification and opens an overlay window. It preserved source trees, but a second window was not the requested main-workspace behavior. The implementation was **retained**, not deleted: the menu now calls it **Floating session view…**. Start with `layout.js` for pure placement and `tiles.js` for the side effect. Its tests prove the floating behavior only.
2. **Native in-place tiling.** `WorkspaceTiles` holds a window-local collection of `(Owner, Slot)` pairs, not a second copy of the terminal layout. A space owner resolves its selected tab's shown tree, so split and mod panes stay with the space. A tab placement resolves its focused pane; a pane placement resolves the specified original pane. Slots use half-workspace coordinates. There are four half positions and four quarter positions.
3. **Placement policy.** The first placement can pair the previously active owner in the opposite slot. The implementation removes stale and overlapping placements, avoids showing one owner twice, and separates space and pane placement modes so a space switching tabs cannot render an already placed pane twice. If an operation would leave focus in a hidden pane, focus moves to a visible owner. Clearing the tile collection returns to ordinary tabs; it is not an undo of a layout-tree mutation.
4. **Rendering and input.** `src/window.rs` no longer assumes the active tab is the only content to attach and paint for the workspace. `workspace_roots` and `render_workspace` resolve the original nodes. This is why rendering a convincing rectangle without updating attachment/visibility is insufficient: a tile could look correct but not accept input. `tile_input.rs` resolves the *clicked* context-menu target, provides placement choices and Untile, and supports dragging the menu's Tile row. Compact sidebar context actions also use the clicked space. Direct drag from a sidebar/tab row arrived later in B.

**Compatibility:** no permanent source-tree merge, pane-ID remap, replacement terminal process or shared machine-layout document was introduced for tiling. A window-local projection can disappear while all source sessions continue to exist. Preserve this distinction if consolidating the floating and inline placement code.

### Pi inside tmux: report an existing process, do not spawn another

The Pi-side publisher `herdr-status.ts` tracks interactive Pi lifecycle and blocking dialog events and writes pane-local `@herdr_pi` data in tmux. The Python `herdr-tmux` helper runs alongside the attached client in the outer Herdr terminal. Its `Monitor` resolves the client's session, inspects reporting panes including background windows, validates process identity, chooses an aggregate state and reports it to Herdr. The Agents mod exposes the reported detail on hover. The outer terminal is the focus target; an inner tmux pane is **not** a Herdr terminal address. Detach should clear the report, not end the tmux session. See `watch_client` for foreground ownership, signals, cleanup and terminal restoration.

Manual starts were a separate bug from preset launches: a plain `tmux new` could bypass the attachment helper. The optional `shell.sh` wrapper sends qualifying top-level interactive starts/attaches through `herdr-tmux --client`, letting other invocations use ordinary tmux. The first fix handled examples such as `new -s test` but missed the user's actual `new -t test` grouped-session form. `interactive_launch` was extended and exercised against the group-assigned session name. Don't collapse `-s` and `-t` into a guessed session identity. No global tmux configuration is installed by the fork.

## 3. Direct drag and titles (B only)

**Follow one pointer gesture:** shipped `spaces` or `tabs` row → per-instance Rust decoration of a keyed div → typed `TileSource` with its owner and originating window → workspace drop target → the same placement/sync logic used by the menu. The shell changes are under **vendored `gpui-kit`**, not a new public JavaScript drag API. The hook is installed on the applicable root; arbitrary mods are not treated as workspace tile sources because they happen to render a div. Release cleanup is deferred so the normal row handler can finish reordering before stale pressed state is cleared.

**Three destinations, three outcomes:** release on a neighboring row/tab to reorder; release at an outer edge/corner to tile; release in the center or outside to cancel. The pane grip that rearranges a split within a tab is another gesture. Test clicks, right-click menus, rename and close independently of the happy-path drag. Calling `place_workspace_tile` directly cannot catch a missing row hook, a swallowed mouse-up or a stale pressed row.

**Preview correction:** the old accent fill painted the small *input hot zone* itself. The hot zones still distinguish sides from corners, but the renderer now paints the full `Slot` footprint last, using a canvas without a hitbox. Hover left midway and the entire left half lights up; move to the upper-left corner and the upper-left quarter lights up; move into the center and the highlight clears. Enlarging the actual hitboxes instead would make corner targets compete with edge targets. The pointer regression inspects painted quad bounds, not just placement arithmetic.

**Title iteration and deletion:** `ce83790` introduced a separate caption strip above a tile. It identified the space, and for pane owners could add the tab name. It also took 20 layout units from the content and duplicated the pane header. `086ae01` removed that strip, its owner-caption helper and the extra offset expectation. The shipped pane header now renders the owning space first, then the existing instance name and folder in brackets, e.g. **Phase 2 only [zsh /private/tmp/…/demo]**. The header uses the pane's tab association rather than the globally active space. The app supplies a `workspaceTiled` prop to the shipped `pane` mod for the tiled case; untiled headers keep their prior title/folder behavior. No change to the title of the real terminal process is required.

## 4. Native Pi workers and backend selection (C only)

### Copy, launch, bind and return

- **What is actually in Git:** an adapter, a unified patch against the compatible local `pi-interactive-subagents-merged` source, preparation/launch scripts, guides and tests. The entire external extension, its credentials, its dependencies and its runtime sessions are **not** vendored. The original remains usable. `prepare-copy` creates a new destination rather than updating an installed extension; it checks layout, refuses nested destinations and symlinked source resources, applies the patch to the copy, and removes an incomplete destination on failure.
- **What the patch replaces:** the copied `index.ts` imports the native transport instead of the tmux transport. Launch paths build the child invocation first and pass it to `launchSurface`, rather than opening an empty tmux pane, sleeping for its shell, then typing a script into it. Resume uses the native path too. The child exports its own surface ID. Live steering waits for send completion; error reporting no longer calls the native transport tmux. The patch keeps the extension's task construction, worker profiles, session files and result-delivery logic rather than implementing a second scheduler. The original `tmux.ts` can still exist in the copy; changing which module is imported is the behavioral change.
- **Who owns the split:** `native.ts` uses the parent process's `HC_TERMINAL_ID`, not current keyboard focus. It checks the chosen Herdr app home, finds exactly one local terminal/pane binding in `herdr-app ls`, then checks `hc get` for a live record and matching space/tab labels. Equal-looking short terminal IDs in different cores are not proof of identity. Missing/ambiguous/remote/tmux context should fail rather than guessing. `pane.split` is called with an explicit parent pane, direction and argv. No new Herdr command or core service was added.
- **Child lifetime:** `launchSurface` writes a launch script, starts it in the chosen split and records the distinct returned terminal ID. `sendCommand`, `readScreen`, `pollForExit` and `closeSurface` operate on the registered child, not whatever is focused. The watcher checks completion files and core state, observes abort signals and returns a result to the extension. The parent reads the worker result and cleans up the worker; the source terminal is not the cleanup target. This is a separate terminal process that can use Pi tools, not just a mirrored agent display.

### What the setting controls (and does not)

Settings **Pi subagents > Use tmux** persists one Boolean under `pi-subagents.tmux`. Only `true` selects tmux; unset means native. The local **+ > Pi subagents** action reads the selection, pins the space and working folder, and passes a backend argument to the prepared copy's `orchestrator`. The preparation path for menu use is `pi-subagents/` under the Herdr app home. A missing launcher produces a setup message, not a silent fallback. The new preference is shared mod state, not a `settings.json` schema field or a core protocol field.

For native mode the orchestrator invokes `pi-native` with the prepared entry. For tmux mode it reads the recorded original entry path, starts Pi in a private tmux server and attaches through `herdr-tmux` with the Pi-side status publisher loaded. Both launches disable automatic extension discovery and explicitly choose the subagent extension; the CLIProxyAPI provider is added if found. `VARIANTS.md` and the selected backend are appended to the orchestrator's system prompt. Tool names stay the same. There is no prompt-time switching or global disablement of tmux. Already running agents, plain `pi`, the Entwurf preset and other windows' live sessions aren't converted by flipping the switch.

## 5. Suggested optimization order

These are measurement targets, **not** findings that the current implementations are slow. Change one boundary at a time and compare against the same fixture before and after.

| Inspect first | Measurement worth taking | Invariant / regression to keep |
|---|---|---|
| Native child launch and watch (`native.ts`) | Time to first child output; number and latency of app/core CLI calls at launch and per interval with 1 vs several workers. Separate process startup from JSON parsing. | Wrong-core, stale and ambiguous bindings must still fail. A focus change between dispatch and launch must not redirect a worker. Check file write, parent delivery and cleanup, not just a successful split. |
| `Monitor` and `watch_client` | tmux/process queries per sample as pane count grows; idle subprocess load; time from dialog open/close to sidebar change. | A blocked background window outranks an idle foreground pane. Unrelated sessions must not leak into the aggregate. PID reuse, client exit, detach, grouped sessions and terminal restoration matter. |
| Workspace root resolution and header lookup | Per-render owner/root lookups, visible-block enumeration and tiled pane lookups while switching tabs, closing a pane and resizing. | Original mod and terminal surfaces must remain attached, focusable and correctly sized. If caching, invalidate on selection, closure, visibility changes and renamed spaces. |
| Vendored row materialization and preview | Frame cost with many rows, especially during hover. Compare ordinary mods/rows with decorated roots. Separate painting cost from hit testing. | Preserve per-window ownership, click/reorder/cancel and eight drop destinations. Do not let a painted preview intercept drops. |
| Task board and derived tab labels | External `tsk` time vs JSON/grouping time; number of pane enumerations per tab-strip render. | A slow result cannot replace another space's board. Manual names win; focusing another split must not rename an otherwise unchanged tab. |
| Extension patch maintenance | Dry-run preparation against a clean copy after changes to the external package; inspect changed launch/resume/steer call sites before reducing the patch. | Keep the original unmodified, reject incompatible sources, load exactly one spawning extension, preserve worker tool restrictions and report setup failures. |

## 6. Evidence and rerun guide

- Integrated baseline: historical combined verification recorded **545 Rust tests passed, 3 ignored; 203 Bun tests; 8 Python tests**, plus the macOS Pi/tmux smoke. These are historical results for the integrated snapshot, not fresh cross-platform certification.
- Direct drag: the real GPUI mouse-down/move/up regression first failed on space placement despite successful row reorder/cancel. It subsequently covered space/tab placement, original root identity and painted preview extents. The inline-header revision recorded 544 passing app tests, two ignored. The user separately confirmed the gesture and preview in the running app.
- Pi native: private macOS Herdr/hc plus real parent and worker Pi sessions, with a loopback model. The smoke selects a decoy tab before dispatch and requires distinct native panes in the parent tab, a file written by the worker, delivery of its summary and cleanup. The user also independently confirmed `worker-proof.txt` from a real run.
- Backend preference: ten focused menu/settings tests passed at the final experiment revision. The smoke ran both backends; tmux mode required two inner panes with no new Herdr worker pane, then return to one inner pane. This is not evidence for all remote transports, fan-out, steering/resume combinations, platforms or providers.

```sh
# Run in a disposable checkout of the matching tip. Initialize build dependencies as usual.
git submodule update --init --recursive
cargo test --locked
bun test scripts/new-menu.test.ts scripts/tabs.test.ts scripts/taskboard.test.ts
python3 -m unittest discover -s integrations/pi-tmux -p 'test_*.py'

# B: use the top-level regression that starts the guarded child process.
cargo test --locked --bin herdr-app shipped_row_pointer_drags -- --nocapture

# C: settings plus BOTH real launch paths. Requires a logged-in macOS desktop,
# local hc/Pi (and tmux for tmux mode), a compatible source package and a
# standalone Herdr binary. Do not copy the signed executable out of an installed .app.
bun test scripts/new-menu.test.ts scripts/settings.test.ts
for mode in native tmux; do
  python3 scripts/pi-native-panes-smoke.py /path/to/pi-merged \
    --herdr-app /path/to/standalone/herdr-app --backend "$mode"
done
```

**Local-only support, not shipped code.** Historical `try-phase 1|2|3`, `try-phase drag`, `try-native-agents` and `try-pi-settings` launchers, worktrees, staged binaries, disposable app homes/cores, loopback test state and prepared extension copies belong to the development machine. The staged native copy is a derivative of local source plus the tracked patch, not another fork commit. The phase-1 launcher was adjusted to locate a local Entwurf installation; drag previews were changed to require a branch-native binary. Don't use installed-app behavior to validate an experimental branch. No release, notarized bundle, upstream change, replacement of the user's original Pi extension or merge of the sibling experiments is part of this inventory.

## 7. File ledger and exact diff lookup

Each row below comes from the corresponding pair of Git trees. **A** = added file; **M** = modified file. `+` and `−` count lines added and removed, including replacements. Click a path for the implementation at that tip. To see the precise old and new code, including deleted lines, substitute its scope's base, tip and path here:

```sh
git diff --find-renames --name-status BASE TIP
git diff --numstat BASE TIP
git diff --function-context BASE TIP -- path/to/file
git log --reverse --oneline BASE..TIP -- path/to/file
# For a feature that existed only between commits (e.g. the extra title strip):
git show ce83790 -- src/window/workspace_tiles.rs
git show 086ae01 -- src/window/workspace_tiles.rs defaults/mods/pane/main.js
```

### A. Integrated fork: `317e673` to `c4e03d0`

| Change | File at reviewed revision | + | − | What to review |
|---|---|---:|---:|---|
| M | [`README.md`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/README.md) | 24 | 2 | Fork-facing overview and entry points for the new workspace and integration workflows. |
| M | [`defaults/AGENTS.md`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/AGENTS.md) | 31 | 4 | Shipped guide: task tooling, display names, floating vs inline placement, menu actions and status semantics. |
| M | [`defaults/layouts/main.json`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/layouts/main.json) | 7 | 0 | Insert the taskboard block in the shipped main layout; no new layout document format. |
| M | [`defaults/mods/agents/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/agents/main.js) | 4 | 0 | Expose agent status message on hover so outer tmux reports have context. |
| M | [`defaults/mods/menu/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/menu/main.js) | 26 | 10 | Add clicked-target floating-session actions; keep this route distinct from the native Tile picker. |
| M | [`defaults/mods/menu/mod.json`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/menu/mod.json) | 1 | 1 | Increase allowed popup height to accommodate the extra menu content. |
| M | [`defaults/mods/new-menu/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/new-menu/main.js) | 30 | 3 | Add private-server Entwurf launch and explicit, confirmed registration action. |
| A | [`defaults/mods/session-tiles/layout.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/session-tiles/layout.js) | 70 | 0 | Pure floating-slot placement and layout-spec construction; inspect overlap and empty-slot behavior here. |
| A | [`defaults/mods/session-tiles/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/session-tiles/main.js) | 143 | 0 | Picker state, live-session discovery, selected placement and Apply behavior. |
| A | [`defaults/mods/session-tiles/mod.json`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/session-tiles/mod.json) | 1 | 0 | Declare the floating session picker mod. |
| A | [`defaults/mods/session-tiles/tiles.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/session-tiles/tiles.js) | 9 | 0 | Bridge pure layout helpers to openSessionTiles/openOverlay. |
| M | [`defaults/mods/spaces/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/spaces/main.js) | 2 | 0 | Expose compact-row name via tooltip and right-click the actual row owner. |
| M | [`defaults/mods/tabs/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/tabs/main.js) | 54 | 16 | Replace repeated lead-pane searches and previous title heuristic; keep manual names authoritative. |
| A | [`defaults/mods/taskboard/main.js`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/taskboard/main.js) | 107 | 0 | Implement scoped tsk reads, validation, loading/error/empty state, grouped rows and interactive tab launch. |
| A | [`defaults/mods/taskboard/mod.json`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/defaults/mods/taskboard/mod.json) | 1 | 0 | Declare the taskboard mod for use by layouts. |
| A | [`docs/space-tiling-proposal.md`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/docs/space-tiling-proposal.md) | 26 | 0 | Record the proposal, limitations of the overlay prototype and native placement requirements. |
| A | [`integrations/pi-tmux/README.md`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/integrations/pi-tmux/README.md) | 47 | 0 | Setup, manual/grouped sessions, status priority, detach and troubleshooting for the optional bridge. |
| A | [`integrations/pi-tmux/herdr-status.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/integrations/pi-tmux/herdr-status.ts) | 88 | 0 | Publish interactive Pi state to the current inner pane; handle blocking UI and cleanup. |
| A | [`integrations/pi-tmux/herdr-tmux`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/integrations/pi-tmux/herdr-tmux) | 289 | 0 | Match attached tmux clients, inspect pane/process state and supervise/restore the foreground attachment. |
| A | [`integrations/pi-tmux/shell.sh`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/integrations/pi-tmux/shell.sh) | 6 | 0 | Opt-in shell wrapper for top-level manual tmux invocations; nonmatching cases keep ordinary behavior. |
| A | [`integrations/pi-tmux/test_herdr_tmux.py`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/integrations/pi-tmux/test_herdr_tmux.py) | 214 | 0 | Python bridge regression fixtures: session selection, identity, aggregation, cleanup and client invocation. |
| M | [`justfile`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/justfile) | 2 | 1 | Keep existing Bun suites and add workspace and Pi publisher suites to the test recipe. |
| M | [`scripts/agents.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/agents.test.ts) | 7 | 2 | Exercise agent detail display without changing focus semantics. |
| A | [`scripts/new-menu.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/new-menu.test.ts) | 75 | 0 | Exercise local-only launch, missing tools, setup confirmation and folder binding. |
| A | [`scripts/pi-tmux-publisher.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/pi-tmux-publisher.test.ts) | 132 | 0 | Check publisher lifecycle and handling of overlapping Pi activity/dialog state. |
| A | [`scripts/pi-tmux-smoke.py`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/pi-tmux-smoke.py) | 234 | 0 | Run the real hc/Pi/tmux integration, including manual launch behavior, in isolated state. |
| A | [`scripts/session-tiles-menu.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/session-tiles-menu.test.ts) | 30 | 0 | Check clicked-session resolution and rejection of ineligible targets for the floating menu. |
| A | [`scripts/session-tiles-picker.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/session-tiles-picker.test.ts) | 165 | 0 | Exercise picker state/actions and handling of changed live selections. |
| A | [`scripts/session-tiles.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/session-tiles.test.ts) | 100 | 0 | Exercise floating placement geometry and generated overlay spec independently of native workspace rendering. |
| M | [`scripts/spaces.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/spaces.test.ts) | 15 | 2 | Add compact-row naming coverage; retain existing list behavior tests. |
| M | [`scripts/tabs.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/tabs.test.ts) | 81 | 30 | Update tab label fixtures and assertions for renamed/manual tabs, title filtering, folders and branches. |
| A | [`scripts/taskboard.test.ts`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/scripts/taskboard.test.ts) | 217 | 0 | Exercise tsk response shapes, context changes, refresh behavior, failures and interactive launch. |
| M | [`src/SKILL.md`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/SKILL.md) | 13 | 1 | CLI-facing window manual: distinguish placement workflows and explain direct Pi vs tmux reports. |
| M | [`src/mods/render_tests.rs`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/mods/render_tests.rs) | 4 | 0 | Extend the shipped render fixture to answer taskboard reads; retain failures on unexpected commands. |
| M | [`src/window.rs`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/window.rs) | 36 | 33 | Unify rendered/attached workspace roots; integrate overlay picker, tile sync, focus, resizing and input. |
| M | [`src/window/drag_tests.rs`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/window/drag_tests.rs) | 36 | 0 | Assert an in-place space placement renders original split and mod content inside the workspace. |
| A | [`src/window/tile_input.rs`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/window/tile_input.rs) | 162 | 0 | Implement clicked-owner menu, placement buttons, menu-row drag source and eight workspace drop targets. |
| A | [`src/window/workspace_tiles.rs`](https://github.com/xolah88457/herdr-app/blob/c4e03d067b5601c9f66f32d36a2550da566b1cc2/src/window/workspace_tiles.rs) | 254 | 0 | Implement placement and reconciliation, owner/root lookup, geometry, rendering and model-level tests. |

### B. Direct-drag branch: `c4e03d0` to `086ae01`

| Change | File at reviewed revision | + | − | What to review |
|---|---|---:|---:|---|
| M | [`README.md`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/README.md) | 1 | 1 | Update instructions from menu-only placement to dragging shipped rows. |
| M | [`defaults/AGENTS.md`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/defaults/AGENTS.md) | 4 | 2 | Describe row reorder vs tile vs cancel; see the later inline-title change separately when reviewing text. |
| M | [`defaults/mods/pane/main.js`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/defaults/mods/pane/main.js) | 6 | 4 | Use the owning space and bracketed instance details in the existing header only for tiled panes. |
| M | [`defaults/mods/spaces/main.js`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/defaults/mods/spaces/main.js) | 8 | 4 | Assign native-decoratable row keys and arrange release handling for space clicks and reordering. |
| M | [`defaults/mods/tabs/main.js`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/defaults/mods/tabs/main.js) | 4 | 3 | Do the same for terminal tab rows; do not turn ordinary selection into unconditional placement. |
| M | [`docs/space-tiling-proposal.md`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/docs/space-tiling-proposal.md) | 1 | 1 | Update the original proposal to reflect implemented direct gestures. |
| M | [`src/SKILL.md`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/SKILL.md) | 1 | 1 | Document direct drag in the agent-facing CLI manual. |
| M | [`src/mods/render_tests.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/mods/render_tests.rs) | 18 | 1 | Update header/render assertions for new row IDs and verify title order for an inactive owner vs untiled pane. |
| M | [`src/window.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/window.rs) | 5 | 3 | Install the native hooks and keep owned/visible pane-header instances consistent about tiled state. |
| M | [`src/window/drag_tests.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/window/drag_tests.rs) | 322 | 34 | Drive shipped rows with GPUI mouse events; assert visible footprint, cancel/reorder, placement and original trees. |
| M | [`src/window/tile_input.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/window/tile_input.rs) | 35 | 6 | Decorate typed row sources, validate window origin, distinguish drop bands from painted slot rectangles. |
| M | [`src/window/workspace_tiles.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/src/window/workspace_tiles.rs) | 9 | 3 | Add conversion from slot coordinates to painted bounds; final snapshot no longer adds a second title strip. |
| M | [`vendor/gpui-kit/crates/shell/src/materialize.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/vendor/gpui-kit/crates/shell/src/materialize.rs) | 82 | 29 | Carry optional per-root hooks while materializing JS element trees and decorate matching keyed divs. |
| M | [`vendor/gpui-kit/crates/shell/src/root.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/vendor/gpui-kit/crates/shell/src/root.rs) | 20 | 0 | Expose the Rust ShellRoot entry point for per-instance div decoration and release cleanup. |
| M | [`vendor/gpui-kit/crates/shell/src/view.rs`](https://github.com/xolah88457/herdr-app/blob/086ae0149061e20a051b84fb097a39bdf5f8ab9a/vendor/gpui-kit/crates/shell/src/view.rs) | 13 | 3 | Store/apply the instance hooks in the script view so ordinary roots retain their normal rendering path. |

### C. Pi experiment: `c4e03d0` to `ce61ef1`

| Change | File at reviewed revision | + | − | What to review |
|---|---|---:|---:|---|
| M | [`defaults/AGENTS.md`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/defaults/AGENTS.md) | 2 | 0 | Document default-off local launch preference and the two mutually exclusive subagent extensions. |
| M | [`defaults/frame/settings/main.js`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/defaults/frame/settings/main.js) | 12 | 14 | Add the Pi subagents section and persistent Use tmux toggle; replace the growing section-selection expression with dispatch to the validated section method. |
| M | [`defaults/mods/new-menu/main.js`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/defaults/mods/new-menu/main.js) | 6 | 2 | Add the local Pi subagents row; route backend, app home and target folder to the prepared launcher. Keep Entwurf independent. |
| A | [`integrations/pi-native-panes/README.md`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/README.md) | 25 | 0 | Document preparation, standalone launch, settings, requirements and smoke-test boundaries. |
| A | [`integrations/pi-native-panes/VARIANTS.md`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/VARIANTS.md) | 3 | 0 | Orchestrator-facing explanation of shared tool names, distinct backends and how to change sessions. |
| A | [`integrations/pi-native-panes/native.patch`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/native.patch) | 118 | 0 | Patch copied index.ts: transport imports, fresh/resumed launches, awaitable steering, child extension isolation and backend diagnostics. |
| A | [`integrations/pi-native-panes/native.ts`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/native.ts) | 149 | 0 | Implement binding validation, explicit split, launch script, child identity registry, reads, sends, polling and termination. |
| A | [`integrations/pi-native-panes/orchestrator`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/orchestrator) | 24 | 0 | Choose exactly one backend, append the variants guide and current mode, and attach the tmux bridge when selected. |
| A | [`integrations/pi-native-panes/pi-native`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/pi-native) | 12 | 0 | Start Pi with the prepared native entry; refuse unprepared copies and nonnative contexts. |
| A | [`integrations/pi-native-panes/prepare-copy`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/integrations/pi-native-panes/prepare-copy) | 57 | 0 | Build a separate private copy, apply the patch, stage both launch paths/status helpers, record the original entry and clean up failures. |
| M | [`scripts/new-menu.test.ts`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/scripts/new-menu.test.ts) | 11 | 1 | Assert backend argument, folder/space and local-only visibility; preserve Entwurf expectations. |
| A | [`scripts/pi-native-panes-smoke.py`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/scripts/pi-native-panes-smoke.py) | 313 | 0 | Start private core/window, run parent and worker Pi against a loopback model, verify write/result and backend-specific pane cleanup. |
| M | [`scripts/settings.test.ts`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/scripts/settings.test.ts) | 19 | 0 | Exercise unset, enabled and disabled preference across settings views. |
| M | [`src/SKILL.md`](https://github.com/xolah88457/herdr-app/blob/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3/src/SKILL.md) | 4 | 0 | Add CLI-manual guidance for launching one selected variant without replacing the other. |

## 8. Commit index

Non-merge commits unique to each range, in Git history order. Use these when a net diff hides an intermediate design or a subsequent fix. For the parallel sync/integration merges themselves, use `git log --graph --oneline --merges 317e673..c4e03d0`. The merge-resolution tips are not separate shipped product variants.

### A. Integrated fork

| Commit | Recorded change |
|---|---|
| [`c2e1d10`](https://github.com/xolah88457/herdr-app/commit/c2e1d106cfd090c626f2bfc4bf38de4827c28c44) | feat: integrate tsk, automatic tab names and entwurf in tmux |
| [`3ce8b4c`](https://github.com/xolah88457/herdr-app/commit/3ce8b4c7221f758aae3a1d3802350e1611b114a3) | docs: propose tiling whole spaces |
| [`96e0daa`](https://github.com/xolah88457/herdr-app/commit/96e0daa0a5678cdfe02ac0cce21a4a2b2de59d91) | feat: tile live sessions without merging tabs |
| [`7fea1d0`](https://github.com/xolah88457/herdr-app/commit/7fea1d0b1e8091c0513f5dfbb6f81c740d836226) | feat: show pi activity from existing tmux sessions |
| [`e5ff84e`](https://github.com/xolah88457/herdr-app/commit/e5ff84e5d0321b8953074fc46f954a444f118e8e) | test: release tmux fixture pty before reaping client |
| [`87be84c`](https://github.com/xolah88457/herdr-app/commit/87be84c59378b998638a915fb6083a0f01d0456b) | docs: require in-place workspace tiling and drag placement |
| [`de07253`](https://github.com/xolah88457/herdr-app/commit/de07253b35aa0d1aa5bb080aec6c8ca27efc7f20) | feat: tile existing spaces and terminals inside the workspace |
| [`7e394f5`](https://github.com/xolah88457/herdr-app/commit/7e394f50315c6b0745c7c12e1fd287cebc8f24cb) | fix: report pi status for manually started tmux sessions |
| [`e448c86`](https://github.com/xolah88457/herdr-app/commit/e448c86ab2d2f0e24476e23ed50b51d7b70b1819) | fix: report pi in grouped tmux sessions |
| [`770d369`](https://github.com/xolah88457/herdr-app/commit/770d36977259d0cc20e7bbee828448e25a0449dd) | test: model task board reads in the render fixture |

### B. Direct-drag branch

| Commit | Recorded change |
|---|---|
| [`3125d08`](https://github.com/xolah88457/herdr-app/commit/3125d08f63a2aa676ef66696b1fd4b6f309c5387) | feat: drag spaces and terminal tabs onto workspace tiles |
| [`ce83790`](https://github.com/xolah88457/herdr-app/commit/ce83790df2418ec9ae75b610a9605f5437ae1ede) | feat: show full tile previews and space captions |
| [`086ae01`](https://github.com/xolah88457/herdr-app/commit/086ae0149061e20a051b84fb097a39bdf5f8ab9a) | feat: show tiled space in existing pane header |

### C. Pi experiment

| Commit | Recorded change |
|---|---|
| [`f6c7491`](https://github.com/xolah88457/herdr-app/commit/f6c7491ebfd0991f0169a5871bc695626da49b09) | feat: launch pi subagents in native herdr panes |
| [`ce61ef1`](https://github.com/xolah88457/herdr-app/commit/ce61ef1c8ef28c880e0eb576c7eaca215ddd0ab3) | feat: select native or tmux pi subagents in settings |

The original phase branches were synchronized before integration (`feat/workspace-tools` at `770d369`, `feat/space-modularity` at `9f677cc`, `feat/pi-tmux` at `854198e`, `fix/pi-manual-tmux` at `ddde3ed`). On the integrated tip, check the final `src/window.rs`, `justfile`, README and render-test fixture rather than assuming that one phase branch alone contains the combined behavior.
