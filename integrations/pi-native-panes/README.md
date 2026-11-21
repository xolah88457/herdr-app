# Native Herdr panes for Pi subagents (experiment)

This opt-in adapter targets the `pi-interactive-subagents-merged` package (`3.8.0-merged.1`). It does not modify Herdr, the installed Pi package, or the tmux integration. `prepare-copy` copies extension sources and bundled agent definitions to a new directory and patches only the copy. No install, credentials, dependency tree, or settings file is copied.

## Use the Herdr setting

From this directory, run `./prepare-copy /path/to/pi-merged "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/pi-subagents"` once. Use a new destination; an older standalone copy is not replaced. In local macOS/Linux spaces choose **+ > Pi subagents**. **Settings > Pi subagents > Use tmux** is off by default. When on, new sessions use the original extension inside a private tmux server and attach via Herdr's existing status bridge. Keep the original extension at its source path. Both modes load only the selected subagent extension, include [the orchestrator guide](VARIANTS.md), and explicitly load the CLIProxyAPI provider if present. Existing sessions, plain `pi`, and the Entwurf preset are unchanged.

## Standalone native launcher

From this integration directory:

```sh
./prepare-copy /path/to/pi-merged /path/to/new-copy
# In a native local Herdr terminal, in the project where the worker should run:
/path/to/pi-native /path/to/new-copy
```

`pi`, `hc`, and `herdr-app` must be on PATH. Use a saved Pi session, not `--no-session`. Keep the Herdr terminal's core environment; if using a nondefault window, set `HERDR_APP_HOME` to its absolute app home. The adapter matches `HC_TERMINAL_ID` and checks the core's space and tab labels before splitting. It refuses tmux, remote panes and ambiguous bindings instead of using the currently focused pane.

The parent launcher disables auto-loaded extensions so the original tool cannot win a name collision. For a provider supplied by an extension, pass it explicitly, for example `pi-native /path/to/new-copy -e "$HOME/.pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts"`. Standard Pi model settings and credentials still apply. Ask Pi to use the `subagent` tool. The worker starts in a new right-hand split and reports back via the copied extension; the parent does not need to read the worker's screen. Normal `pi` still uses your normal setup. Do not install this copy globally alongside the original.

## GPT Sol: use a forked session for direct task delivery

With `cliproxyapi/rp/gpt-6.2-sol`, two hosted trials in `standalone` session mode saw a worker summarize the task file instead of executing it. The Herdr pane opened correctly: the issue was how the worker interpreted the file. For Sol workers, set `session-mode: fork` in the YAML frontmatter of the **worker profile** you select. This passes the task directly and inherits the parent's conversation; choose it only when that worker should receive the parent context. This setting is independent of the Herdr/tmux preference. It is a workaround, not a change to the extension default or a fix for standalone handoff.

The hosted fork-mode test used two real Sol workers and a scripted parent. The first worker received a targeted message and later resumed under the same Pi session ID. The second stayed live without receiving the first worker's input. Both returned their assigned markers and closed without closing the parent.

## Verification and scope

`python3 scripts/pi-native-panes-smoke.py /path/to/pi-merged --herdr-app /path/to/herdr-app` (from the repo root) opens a disposable macOS window and core. Real parent and child Pi sessions talk to a loopback-only model. The test switches to another tab before the parent dispatches, verifies distinct pane and terminal IDs in the parent's tab, requires a worker-written file, checks the returned summary, and verifies cleanup. No provider account needed. Add `--backend tmux` to check that the worker uses a second inner tmux pane rather than a second Herdr pane. In native mode, add `--lifecycle` for a separate regression covering two live native splits, directed steering, same-session resume, sibling isolation and cleanup. The offline scenarios exercise the real app and Pi tools but do not test model instruction-following, remote machines or notification parity.
