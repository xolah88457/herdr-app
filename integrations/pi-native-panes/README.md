# Native Herdr panes for Pi subagents (experiment)

This opt-in adapter targets the `pi-interactive-subagents-merged` package (`3.8.0-merged.1`). It does not modify Herdr, the installed Pi package, or the tmux integration. `prepare-copy` copies extension sources and bundled agent definitions to a new directory and patches only the copy. No install, credentials, dependency tree, or settings file is copied.

## Prepare a copy

From this directory, once:

```sh
./prepare-copy /path/to/pi-merged "${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}/pi-subagents"
```

Use a new destination: `prepare-copy` never overwrites an existing copy. It refuses a package whose `package.json` version is not `3.8.0-merged.1` (`--any-version` tries anyway; the patch may not apply) and needs the `patch` command. To refresh the launcher files of an existing copy after updating Herdr, run `./prepare-copy --update /path/to/copy`. This replaces only `orchestrator`, `pi-native`, `native.ts`, `herdr-tmux`, `herdr-status.ts` and `VARIANTS.md`; it does not re-patch the extension. To pick up a new extension version, prepare a fresh copy.

## Use the Herdr setting

In local macOS/Linux spaces choose **+ > Pi subagents**. **Settings > Pi subagents > Use tmux** is off by default. When on, new sessions use the original extension inside a private tmux server and attach via Herdr's existing status bridge; closing the tab ends that tmux session and its server (Pi and its workers stop). Keep the original extension at its source path. Both modes load only the selected subagent extension and add [the orchestrator guide](VARIANTS.md) (read at launch) to Pi's system prompt. Pass extra providers or extensions yourself; the launcher adds none. Existing sessions, plain `pi`, and the Entwurf preset are unchanged.

## Standalone native launcher

```sh
# In a native local Herdr terminal, in the project where the worker should run:
/path/to/new-copy/pi-native /path/to/new-copy
```

`pi`, `hc`, and `herdr-app` must be on PATH. Use a saved Pi session, not `--no-session`. Keep the Herdr terminal's core environment; `HERDR_APP_HOME` defaults to `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app` like the app, so set it to the absolute app home for a nondefault window. The adapter matches `HC_TERMINAL_ID` and checks the core's space and tab labels before opening a worker. It refuses tmux, remote panes and ambiguous bindings instead of using the currently focused pane.

The launcher disables auto-loaded extensions so the original tool cannot win a name collision. For a provider supplied by an extension, pass it explicitly: `pi-native /path/to/new-copy -e /path/to/provider/extensions/index.ts`. Standard Pi model settings and credentials still apply. Ask Pi to use the `subagent` tool. By default the worker starts in a new background tab of the parent's space (`tab.new` with `focus:false`; it does not take focus, and it closes with its program). Set `HERDR_PI_WORKER_LAYOUT=split` (Herdr sets it from the shared key `pi-subagents.split`, Settings > Pi subagents > Open workers in a split pane) for a right-hand split beside the parent instead, or `HERDR_PI_WORKER_LAYOUT=hidden` (from `pi-subagents.windows` = false, Settings > Pi subagents > Open a window for each worker) to run workers with no tab or pane: `hc run` from the parent terminal starts them as its sub-agents, listed under the parent in the Agents list, where the person can open one (peek, or keep as a tab). Input, screen reads, exit polling and kill use the same terminal address in every layout. The worker reports back via the copied extension; the parent does not need to read the worker's screen. Do not install this copy globally alongside the original.

If a worker summarizes its task file instead of doing the work, try `session-mode: fork` in that worker profile's frontmatter (it inherits the parent's conversation).

## Verification and scope

`python3 scripts/pi-native-panes-smoke.py /path/to/pi-merged --herdr-app /path/to/herdr-app` (from the repo root) opens a disposable macOS window and core. Real parent and child Pi sessions talk to a loopback-only model. The test switches to another tab before the parent dispatches, verifies distinct pane and terminal IDs in the parent's tab, requires a worker-written file, checks the returned summary, and verifies cleanup. The script forces `HERDR_PI_WORKER_LAYOUT=split`, so the default background-tab mode is not covered end to end by it. No provider account needed. Add `--backend tmux` to check that the worker uses a second inner tmux pane rather than a second Herdr pane. In native mode, add `--lifecycle` for a separate regression covering two live native splits, directed steering, same-session resume, sibling isolation and cleanup. The offline scenarios exercise the real app and Pi tools but do not test model instruction-following, remote machines or notification parity.
