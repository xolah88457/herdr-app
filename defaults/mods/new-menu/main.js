import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, appHome } from "herdr";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";

// Entwurf 0.55.1's Herdr rail targets the 0.9.x TUI, not Herdr 2. Start a
// tmux server per launch so its siblings inherit this terminal's environment.
const ENTWURF_PI = ["sh", "-c", `
for tool in tmux entwurf pi; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Entwurf Pi needs %s on PATH. Nothing was installed.\\n' "$tool" >&2
    exit 127
  fi
done
unset TMUX TMUX_PANE HERDR_ENV HERDR_BIN_PATH HERDR_PANE_ID HERDR_SOCKET_PATH
exec tmux -L "herdr-entwurf-$$-$(date +%s)" new-session \\
  sh -c 'entwurf pi || { printf "\\nPi launch failed. Check Entwurf Pi setup, then press Enter to close tmux.\\n" >&2; read -r reply; exit 1; }'
`];

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const installed = this.agents.filter(a => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    const platform = window()?.platform;
    const entwurf = space && !space.machine && (platform === "macos" || platform === "linux");
    const folder = entwurf ? panes().find(p => p.focused)?.cwd : undefined;
    const useTmux = shared("pi-subagents.tmux") === true;
    const rows = Math.max(1, choices.length + (this.failed ? 1 : 0)) + (entwurf ? 3 : 0);
    return v_flex().min_h(0).w_full().h(Math.min(491, 167 + rows * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        run("tab.new", { space: space?.id, argv: agent.run });
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .when(entwurf, el => el
        .child(this.row("pi-subagents", svg("icons/pi.svg").size(14), "Pi subagents", () => run("tab.new", {
          space: space.id, folder, argv: ["sh", "-c", 'if [ ! -x "$1/orchestrator" ]; then printf "Prepare the Pi extension copy at %s with integrations/pi-native-panes/prepare-copy first.\\n" "$1" >&2; exit 1; fi; exec "$1/orchestrator" "$2"', "pi-subagents", `${appHome()}/pi-subagents`, useTmux ? "tmux" : "native"],
        }), useTmux ? "tmux" : "Herdr panes"))
        .child(this.row("entwurf-pi", svg("icons/tmux.svg").size(14), "Entwurf Pi in tmux", () => run("tab.new", { space: space.id, argv: ENTWURF_PI })))
        .child(this.row("entwurf-setup", svg("icons/pi.svg").size(14), "Set up Entwurf for Pi…", () => openOverlay({
          mod: "confirm", kind: "dialog", modal: true, width: 480, height: 220, props: {
            title: "Register Entwurf with Pi?",
            detail: `Runs entwurf install in ${folder}. Updates project and user Pi settings to register the Entwurf package and bridge. It does not install tools or change credentials.`,
            command: { name: "tab.new", args: { space: space.id, folder, argv: ["entwurf", "install", folder] } },
          },
        }), folder ? "" : "no terminal folder", Boolean(folder))))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => run("tab.new", { space: space?.id, argv: a.run }), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
