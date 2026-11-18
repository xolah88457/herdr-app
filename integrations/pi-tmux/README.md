# Pi inside tmux, visible in Herdr

Pi reports its own state when launched directly in Herdr. A tmux client normally doesn't forward those reports. This optional integration keeps Pi in the **existing tmux session** and makes that session visible as one terminal in Herdr’s Agents panel. Nothing is installed automatically. No provider, tmux plugin, `allow-passthrough`, or global tmux setting is needed.

## Try it on one session

Use macOS or Linux with Python 3.8+ and interactive Pi. The integration was tested on macOS with Pi 1.5.2, tmux 3.8, and hc 0.1.21. Both sides must run on the machine that owns the tmux socket.

1. In a tmux pane, launch Pi with the extension from this checkout. Keep your other Pi arguments, packages, and extensions:

   ```sh
   pi -e /absolute/path/to/herdr-app/integrations/pi-tmux/herdr-status.ts
   ```

   To enable it for existing and future interactive Pi sessions instead, copy or symlink that file under `~/.pi/agent/extensions/` (or `extensions/` in your custom Pi agent directory); use `/reload` when the current turn is finished. Remove the extension and reload to undo it. Direct Pi outside tmux is unaffected.

2. In a **Herdr terminal outside tmux**, run the helper instead of `tmux attach`. Replace `work` with your existing session name:

   ```sh
   /absolute/path/to/herdr-app/integrations/pi-tmux/herdr-tmux work
   ```

   For a private server, pass `-L server-name` or `-S /absolute/socket/path` before the session. Inside a pane, `tmux display-message -p '#{socket_path} #{session_name}'` tells you both. This also works for phase one's Entwurf sessions: attach to the existing private socket from a Herdr tab rather than launching another agent. Detaching with your normal tmux binding leaves Pi running. For a plain attachment again, use `tmux attach`.

3. In Herdr’s **Agents** panel, look for Pi in the tab you attached from. Switch to another tmux window: an extension dialog in the first window should still show as needing attention. Hover the agent row for its reported location. Select that window/pane in tmux to answer. Herdr’s usual notifications and seen/unseen rules apply to the **outer terminal**, not to keyboard focus inside tmux.

## What the row means

- One attached terminal is one Herdr address, not one address per inner tmux pane. Among reporting panes in that client’s current session, an error or a request for input takes priority over working, then finished, then idle. Hidden windows count; unrelated sessions do not. Switching tmux sessions changes what the row represents.
- The Pi extension tracks interactive runs, final settlement (including retry/abort), and extension dialogs. It does not guess from terminal text, report individual tools or subagent histories, or detect every built-in Pi screen. Very short transitions between samples can be missed. Herdr may display a completed turn as idle once seen.
- The bridge reads pane-local state, process identity, and numeric window/pane positions. It does not capture screens, prompts, replies, credentials, or dialog contents. Each bridge only runs while its terminal is attached. It cannot monitor a detached session in the background or retrofit an already-running plain `tmux attach` client.
- Phase one's task board and manual tab names are unchanged. Phase two can tile these **outer Herdr terminals** without moving your Pi panes. Separate native agent rows, focus targets, or tiles require separate Herdr terminal addresses; a tmux pane isn't one.

**If the panel is empty:** In the Pi pane, `tmux display-message -p '#{pane_id} #{@herdr_pi}'` should include a PID and state (for example, `%3 1234:idle`). If not, check that the extension loaded into interactive Pi. If it did, check that the helper is attached to the same socket and session and that Pi and the helper are on the same host. From a shell, `hc get <outer-address>` shows the core's status independently of the sidebar.
