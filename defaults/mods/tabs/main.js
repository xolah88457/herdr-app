import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Prefer the first agent, then the first terminal, then a mod-only pane.
// Moving keyboard focus among splits should not rename the tab.
function leadPanes(all) {
  const leads = new Map();
  const rank = p => p?.program?.agent ? 3 : p?.terminal ? 2 : p ? 1 : 0;
  for (const p of all) if (rank(p) > rank(leads.get(p.tab))) leads.set(p.tab, p);
  return leads;
}

const fold = (s) => s?.toLowerCase();
const windowsPath = /^(?:[a-z]:[\\/]|\\\\)/i;
const unixPath = /^(?:\/|~(?:\/|$))/;

function folderName(cwd) {
  if (!cwd) return "";
  // POSIX remote paths can contain a literal backslash; split on it only for Windows forms.
  if (windowsPath.test(cwd)) return cwd.replace(/^[a-z]:/i, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return unixPath.test(cwd) ? cwd.split("/").filter(Boolean).at(-1) ?? "" : "";
}

// Keep in sync with agents mod clean (defaults/mods/agents/main.js): drops what an agent
// puts before its title (a status glyph or spinner, Codex's "[ ! ] " / "[ . ] " mark), stopping
// at an opening bracket or quote and at an emoji ("🔴 login") a person put there. Mods cannot
// import each other, so this is a copy. Differences: path starts (. / ~ \) survive so
// the path filter below sees them, and the glyphs are stripped again after the mark ("● [ ! ] x").
const glyphs = (s) => s.replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}./~\\]+/u, "");
const clean = (s) => glyphs(glyphs((s ?? "").replace(/\s+/g, " ").trim()).replace(/^\[ [!.] \] /, "")).trim();

function agentTitle(lead, folder) {
  const live = clean(lead.title);
  if (!/[\p{L}\p{N}]/u.test(live) || /^\p{N}+$/u.test(live) || windowsPath.test(live) || unixPath.test(live) || /^\.{1,2}[\\/]/.test(live)) return "";
  if (/^[\p{L}\p{N}_.-]+@[\p{L}\p{N}_.-]+(?:[:\s]|$)/u.test(live)) return "";
  const { key, name } = lead.program;
  const generic = [lead.terminal, lead.terminal?.split("/").at(-1), key, name, lead.app, `${key} code`, folder, lead.branch, "new session", "untitled"];
  return generic.some(s => fold(s) === fold(live)) ? "" : live;
}

// A label is derived at render time. Never write it back. An explicit name wins,
// except one equal to the program's name: older versions saved that as `named`
// when the menu passed the agent's name, and it should keep following the agent title.
function label(tab, lead, space) {
  if (tab.named && !(lead?.program?.name && fold(tab.name) === fold(lead.program.name))) return tab.name;
  if (lead?.mod) return lead.name || lead.title || lead.mod;
  const folder = folderName(lead?.cwd);
  const task = lead?.program?.agent && agentTitle(lead, folder);
  const branch = lead?.branch;
  const parts = [];
  const add = (part) => { if (part && !parts.some(p => fold(p) === fold(part))) parts.push(part); };
  add(task || lead?.program?.name);
  if (fold(folder) !== fold(space?.name)) add(folder);
  if (branch && !/^(?:main|master|HEAD|\(detached\))$/i.test(branch)) add(branch);
  return parts.join(" · ") || "Terminal";
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const leads = leadPanes(shown.length ? panes() : []);
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = leads.get(c.id);
      const program = lead?.program;
      const name = label(c, lead, space);
      return h_flex().id(`workspace-tab-row-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .tooltip(name)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from === null) return;
          if (from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // `workspace.panels` picks Files and Changes. Tasks is on unless `workspace.tasks` is false
    // (so lists saved before it existed keep it), and needs the layout's block.
    const hasTasks = body?.children?.some(child => child.id === "taskboard");
    const chosen = (shared("workspace.panels") ?? ["files", "changes"]).filter(id => id !== "taskboard");
    const enabled = hasTasks && shared("workspace.tasks") !== false ? [...chosen, "taskboard"] : chosen;
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().id("tabs-release").size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { if (this.pressed === null) return; this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("taskboard"), el => el.child(panelButton("taskboard", "Tasks", "mods/workspace-chrome/circle-check.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
