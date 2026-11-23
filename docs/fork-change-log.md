# Herdr fork: what it adds and the rules to keep

A map for reviewing and changing the fork. The fork's work is merged on `master`; see `git log` for the history and the README's "Fork additions" for what a person sees. Installed agents read `defaults/AGENTS.md`.

## What the fork adds

- **Workspace tiling.** Show two spaces, tabs or panes side by side in the main workspace, by right-click **Tile…** or by dragging a sidebar row or tab onto an edge or corner. Code: `src/window/workspace_tiles.rs`, `tile_input.rs`, `workspace_roots`/`render_workspace` in `src/window.rs`.
- **Terminal theme option.** `terminal_theme` (default `follow`) colors terminals apart from the app, with shipped `atom-one-dark`, `atom-one-light`, `win98` themes and `terminal_bold_foreground`. Code: `src/settings.rs`, `src/vt.rs`, `defaults/themes/`.
- **Tab labels.** Unnamed tabs show the program or agent's live title plus folder and branch when useful; an explicit `tab.named` name wins, except one equal (case-insensitive) to the lead program's name (older versions saved those), which keeps following the agent title. Mod: `defaults/mods/tabs`.
- **Task board.** The `taskboard` mod shows `tsk list --json` (and `--done`) for the space's folder and machine; `workspace.tasks` toggles it.
- **+ menu entries.** Entwurf Pi in tmux, Set up Entwurf for Pi…, and Pi subagents. Mod: `defaults/mods/new-menu`.
- **Pi tmux status bridge.** `integrations/pi-tmux`: a Pi extension publishes state to tmux, `herdr-tmux` reports one aggregate status per attached client.
- **Pi native-pane subagents.** `integrations/pi-native-panes`: an adapter and patch applied to a copy of the subagent extension so workers open in a background Herdr tab (or a split beside the parent with `pi-subagents.split`, or no window at all with `pi-subagents.windows` off: `hc run` from the parent makes a sub-agent listed under it in the Agents list). The setting `pi-subagents.tmux` selects the tmux backend instead.
- **Mac dmg.** `.github/workflows/mac-dmg.yml` builds an ad-hoc signed `Herdr-<version>-arm64.dmg` on `fork-v*` tags (or by hand) and attaches it to a GitHub Release; it leaves `HERDR_APP_RELEASE` unset (no self-update, no telemetry). App assembly is shared with `scripts/install-macos` in `scripts/mac-bundle`.

## Rules and invariants

- **Tiling is a window-local projection.** `WorkspaceTiles` holds `(Owner, Slot)` pairs, not a second copy of any layout. It never remaps pane IDs, merges trees, restarts terminals or writes machine layout documents; clearing it returns to ordinary tabs. A rendered tile must also be attached and focusable, or it looks right but takes no input. Tiling has no `herdr-app do` command on purpose.
- **Core stays small.** New behavior goes in mods, shared storage or `integrations/`. Changes to the model, layout documents, commands, mod APIs or herdr-core need the maintainer's go (see `AGENTS.md`).
- **The pane header** reads `tiled` from its own `panes()` entry, not an instance prop, so toggling tiling never reloads headers.
- **Automatic tab labels are computed for display,** never written into the model; changing focus between splits must not rename a tab.
- **Task board.** The mod never writes tasks; `tsk` owns them. Commands run in the active space's folder and machine, and results that arrive after the space changed are dropped. Keep the stale-result checks.
- **Terminal colors.** `follow` is not written to settings.json; an unknown value falls back to `follow` and is reported as a problem. Settings and layout `colors` still override terminal colors under another theme.
- **Integrations are opt-in.** Nothing installs, registers or starts automatically; Entwurf setup always asks first. A tmux pane is not a core address, so an attached terminal reports one aggregate status. The native adapter binds to the parent's `HC_TERMINAL_ID`, never the focused pane, and refuses tmux, remote or ambiguous bindings. The prepared copy patches only the copy; the original extension is untouched.
- **Docs follow code.** A user-visible change updates `defaults/AGENTS.md` (and `src/SKILL.md` for agent-facing behavior) in the same commit.

## Running the tests

```sh
just test        # bun mod suites, cargo test, pi-tmux publisher, pi-tmux python tests
just docs-check  # generated docs and CLI examples
```

CI runs the same set on Linux. The real-app smokes (`scripts/pi-tmux-smoke.py`, `scripts/pi-native-panes-smoke.py`) need a desktop with hc, Pi and tmux and are run by hand. Tiling pointer behavior is covered by `cargo test shipped_row_pointer_drags`.
