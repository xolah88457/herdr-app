import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, openOverlay, panes, props, spaces, theme } from "herdr";
import { openSessionTiles, placements, placeTerminal } from "./tiles.js";

const opposite = { left: "right", right: "left", top: "bottom", bottom: "top" };
const activeSpace = () => spaces().find((space) => space.active);

function sessionsIn(space) {
  if (!space) return [];
  const tabs = new Map(space.tabs.map((tab) => [tab.id, tab.name]));
  return panes().filter((pane) => pane.terminal && tabs.has(pane.tab)).map((pane) => ({
    pane: pane.pane,
    address: pane.terminal,
    name: pane.name || pane.title || pane.terminal,
    tab: tabs.get(pane.tab),
    focused: pane.focused,
  }));
}

function button(t, id, label, click, { enabled = true, selected = false, primary = false } = {}) {
  return h_flex().id(id).flex_none().h(28).px(9).items_center().rounded(5)
    .bg(selected ? t.selected : primary && enabled ? t.solid : t.raised)
    .text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.8))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); click(cx); }))
    .child(label);
}

export default class SessionTiles extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.space = p.space ?? activeSpace()?.id;
    if (p.mode === "header") return;
    const sessions = this.sessions();
    this.tiles = p.tiles ?? [];
    this.selected = p.pane != null
      ? sessions.find((session) => session.pane === p.pane)?.address
      : this.tiles[0]?.address ?? (sessions.find((session) => session.focused) ?? sessions[0])?.address;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  sessions() {
    const space = activeSpace();
    return space?.id === this.space ? sessionsIn(space) : [];
  }

  currentTiles(sessions) {
    return this.tiles.flatMap((tile) => {
      const terminal = sessions.find((session) => session.address === tile.address);
      if (!terminal) return [];
      const name = terminal.name === terminal.address && terminal.tab ? terminal.tab : terminal.name;
      return [{ ...tile, name }];
    });
  }

  place(address, placement, cx) {
    const sessions = this.sessions();
    const terminal = sessions.find((session) => session.address === address);
    if (!terminal) return;
    const before = this.currentTiles(sessions);
    this.tiles = placeTerminal(before, terminal, placement);
    // Exactly one obvious counterpart; otherwise leave each empty slot for the user.
    const other = !before.length && sessions.length === 2 && opposite[placement]
      ? sessions.find((session) => session.address !== address)
      : null;
    if (other) this.tiles = placeTerminal(this.tiles, other, opposite[placement]);
    cx.notify();
  }

  apply() {
    const tiles = this.currentTiles(this.sessions());
    if (!tiles.length) return;
    openSessionTiles(tiles, this.space);
    closeOverlay(props().overlay);
  }

  header(p, t) {
    const inSpace = activeSpace()?.id === this.space;
    if (!inSpace && p.overlay && !this.closing) {
      this.closing = true;
      // closeOverlay queues the window mutation; it does not close during render.
      closeOverlay(p.overlay);
    }
    return h_flex().size_full().px(10).gap(6).items_center().bg(t.chrome).text_size(12)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(p.title || "Session tiles"))
      .child(div().id("st-summary").flex_1().min_w(0).truncate().text_color(t.muted)
        .when(Boolean(p.summary), (el) => el.tooltip(p.summary).child(p.summary)))
      .child(button(t, "st-edit", "Edit placement", () => {
        if (activeSpace()?.id !== this.space) return;
        openOverlay({ kind: "dialog", mod: "session-tiles", width: 480, height: 400,
          props: { space: this.space, tiles: p.tiles } });
      }, { enabled: inSpace }))
      .child(button(t, "st-close", "Close view", () => closeOverlay(p.overlay)));
  }

  render(cx) {
    const p = props() ?? {};
    const t = theme();
    if (p.mode === "header") return this.header(p, t);

    const sessions = this.sessions();
    const tiles = this.currentTiles(sessions);
    const slot = (address) => tiles.find((tile) => tile.address === address)?.placement;
    const current = sessions.find((session) => session.address === this.selected);
    const positions = (items) => h_flex().gap(6).children(items.map(({ id, label }) =>
      button(t, `st-place-${id}`, label, (cx) => this.place(current.address, id, cx),
        { enabled: Boolean(current), selected: slot(current?.address) === id })));
    return v_flex().id("session-tiles").size_full().min_h(0).p(16).gap(8).bg(t.popover)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "enter" || !tiles.length) return;
        cx.stop_propagation();
        this.apply();
      })
      .child(div().text_size(16).font_semibold().child(p.tiles ? "Edit session tiles" : "Tile sessions"))
      .child(div().text_color(t.muted).child(
        this.space != null && activeSpace()?.id !== this.space ? "Return to the original space to use this picker." :
          sessions.length ? "Select a session, then choose its position." : "No terminal sessions in this space.",
      ))
      .child(v_flex().id("st-sessions").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(sessions.map((session) => h_flex().id(`st-session-${session.pane}`).h(32).flex_none().px(8).gap(8)
          .rounded(5).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .when(session === current, (el) => el.bg(t.selected))
          .on_click((_e, cx) => { this.selected = session.address; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(session.name))
          .child(div().max_w(120).truncate().text_color(t.muted).child(session.tab ?? ""))
          .child(div().flex_none().text_color(t.accent).child(placements.find(({ id }) => id === slot(session.address))?.label ?? "")),
        )))
      .child(positions(placements.filter(({ id }) => opposite[id])))
      .child(positions(placements.filter(({ id }) => !opposite[id])))
      .child(h_flex().pt(4).gap(6).items_center()
        .child(button(t, "st-remove", "Remove placement", (cx) => {
          this.tiles = tiles.filter((tile) => tile.address !== current.address);
          cx.notify();
        }, { enabled: Boolean(slot(current?.address)) }))
        .child(div().flex_1())
        .child(button(t, "st-cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(button(t, "st-open", p.tiles ? "Apply" : "Open", () => this.apply(), { enabled: tiles.length > 0, primary: true })));
  }
}
