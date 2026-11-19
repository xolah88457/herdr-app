//! Window-only workspace placement. Shipped chrome rows and the popup's
//! Tile row carry a typed native drag payload into the workspace drop surface.
use super::*;

#[derive(Clone)]
struct TileSource {
    kind: &'static str,
    id: String,
    window: Option<gpui::WindowId>,
}

impl TileSource {
    fn from_menu(inst: &Instance, model: &Model) -> Option<Self> {
        if inst.name != "menu" { return None; }
        let target = &inst.props["target"];
        let (kind, id) = match inst.props["tab"].as_str()? {
            "space" => ("space", &model.space(target["id"].as_str()?)?.id),
            "tab" => ("tab", &model.tab(target["id"].as_str()?)?.id),
            "pane" => {
                let id = target["pane"].as_str()?;
                let node = model.tab_of(id)?.root.find(id).filter(|n| n.is_pane())?;
                ("pane", &node.id)
            }
            _ => return None,
        };
        Some(Self { kind, id: id.clone(), window: None })
    }
}

impl Render for TileSource {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().px_2().py_1().rounded_md().bg(c("popover")).text_color(c("foreground"))
            .text_xs().child(format!("Tile {}", self.kind))
    }
}

// The menu and the drop surface share this map; the center deliberately does nothing.
const POSITIONS: [[Option<(&str, &str)>; 3]; 3] = [
    [Some(("top-left", "Top left")), Some(("top", "Top")), Some(("top-right", "Top right"))],
    [Some(("left", "Left")), None, Some(("right", "Right"))],
    [Some(("bottom-left", "Bottom left")), Some(("bottom", "Bottom")), Some(("bottom-right", "Bottom right"))],
];

fn button(id: &'static str) -> Stateful<Div> {
    div().id(id).tab_index(0).h(settings::z(29.)).rounded(settings::z(5.)).flex()
        .justify_center().items_center().cursor_pointer().text_color(c("foreground"))
        .hover(|s| s.bg(c("hover"))).focus(|s| s.bg(c("selected")))
}

pub(super) fn decorate_workspace_rows(root: &ShellRoot, name: &str, window: &Window, cx: &mut App) {
    let (kind, prefix, release_id) = match name {
        "spaces" => ("space", "workspace-space-row-", "spaces-release"),
        "tabs" => ("tab", "workspace-tab-row-", "tabs-release"),
        _ => return,
    };
    let window_id = window.window_handle().window_id();
    root.decorate_divs(release_id, move |key, row| {
        let Some(id) = key.strip_prefix(prefix) else { return row };
        row.on_drag(TileSource { kind, id: id.into(), window: Some(window_id) }, |source, _, _, cx| {
            cx.new(|_| source.clone())
        })
    }, cx);
}

impl AppWindow {
    pub(super) fn workspace_menu(&self, o: &Overlay, content: AnyElement, max_height: Pixels, cx: &mut Context<Self>) -> AnyElement {
        if o.kind != OverlayKind::Popup || o.layout.is_some() { return content; }
        let Some(source) = self.copies.get(&o.slot).and_then(|copy| TileSource::from_menu(&copy.inst, &self.model)) else { return content };
        if !self.shows_tab() { return content; }
        let mut panel = div().id("workspace-tile-menu").tab_group().w_full().max_h(max_height.max(px(0.)))
            .overflow_y_scroll().flex().flex_col().text_size(settings::z(12.));
        if !o.tile_picker {
            let menu = o.id.clone();
            let drag_menu = o.id.clone();
            let view = cx.entity().downgrade();
            let handle = button("workspace-tile-source").flex_none().justify_between().px(settings::z(10.))
                .cursor(CursorStyle::OpenHand).child(format!("Tile {}…", source.kind))
                .child(div().text_color(c("dim")).text_size(settings::z(11.)).child("or drag"))
                .on_drag(source, move |source, _, window, cx| {
                    // The popup must not cover the destination after the drag starts.
                    let _ = view.update(cx, |this, cx| this.close_overlay(&drag_menu, window, cx));
                    cx.new(|_| source.clone())
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(o) = this.overlays.iter_mut().find(|o| o.id == menu) {
                        o.tile_picker = true;
                        o.focus.focus(window, cx);
                        cx.notify();
                    }
                }));
            panel = panel.child(handle).child(div().flex_none().w_full().child(content));
        } else {
            panel = panel.p(settings::z(4.)).child(div().pl(settings::z(6.)).text_color(c("muted"))
                .child(format!("Place {}", source.kind)));
            for row in POSITIONS {
                let mut buttons = div().flex_none().flex().w_full();
                for position in row {
                    if let Some((placement, label)) = position {
                        let source = source.clone();
                        let menu = o.id.clone();
                        buttons = buttons.child(button(placement).flex_1().text_size(settings::z(10.5)).child(label)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.close_overlay(&menu, window, cx);
                                this.apply_tile(&source, placement, window, cx);
                            })));
                    } else {
                        buttons = buttons.child(div().flex_1());
                    }
                }
                panel = panel.child(buttons);
            }
            if self.workspace_tiling_active() {
                let menu = o.id.clone();
                panel = panel.child(button("untile-workspace").flex_none().child("Untile workspace")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.close_overlay(&menu, window, cx);
                        this.clear_workspace_tiles();
                        this.sync(window, cx);
                    })));
            }
        }
        panel.into_any_element()
    }

    fn apply_tile(&mut self, source: &TileSource, placement: &str, window: &mut Window, cx: &mut Context<Self>) {
        if source.window.is_some_and(|id| id != window.window_handle().window_id()) { return; }
        if self.place_workspace_tile(source.kind, &source.id, placement) {
            self.sync(window, cx);
        }
    }

    pub(super) fn workspace_drop_target(&self, content: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        if !cx.has_active_drag() { return content; }
        let mut body = div().relative().size_full().flex().child(content);
        // Outer quarters accept drops: one axis at an edge means a half, both
        // at edges mean a corner. Only TileSource can highlight or accept them.
        let hovered = std::rc::Rc::new(std::cell::Cell::new(None));
        let bands = [(0., 0.25), (0.25, 0.5), (0.75, 0.25)];
        for (y, row) in POSITIONS.iter().enumerate() {
            for (x, position) in row.iter().enumerate() {
                let Some((placement, _)) = *position else { continue };
                let hover = hovered.clone();
                body = body.child(div().absolute().left(relative(bands[x].0)).w(relative(bands[x].1))
                    .top(relative(bands[y].0)).h(relative(bands[y].1))
                    .drag_over::<TileSource>(move |s, source, window, _| {
                        if source.window.is_none_or(|id| id == window.window_handle().window_id()) {
                            hover.set(workspace_tiles::Slot::parse(placement));
                        }
                        s
                    })
                    .on_drop(cx.listener(move |this, source: &TileSource, window, cx| {
                        this.apply_tile(source, placement, window, cx);
                    })));
            }
        }
        // Paint last, without a hitbox: the full preview never obscures the corner targets.
        body.child(canvas(|_, _, _| (), move |area, _, window, _| {
            if let Some(slot) = hovered.take() {
                let accent = c("accent");
                window.paint_quad(quad(slot.bounds(area), px(0.), accent.opacity(0.22), px(2.), accent, BorderStyle::Solid));
            }
        }).absolute().inset_0()).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{Instance, Model, Tab, TileSource, Value, json};

    #[test]
    fn menu_drag_uses_the_clicked_owner_and_never_treats_paths_as_owners() {
        let mut model = Model::default();
        model.add_space("a", "API", "/api", Tab::new("ta", "", "pa", "pty:a"));
        model.add_space_unshown("b", "Web", "/web", Tab::new("tb", "", "pb", "/tmp/file"));
        let source = |name: &str, tab: &str, target: Value| {
            TileSource::from_menu(&Instance { name: name.into(), props: json!({ "tab": tab, "target": target }) }, &model)
        };
        for (kind, id, target) in [
            ("space", "b", json!({"id": "b"})),
            ("tab", "tb", json!({"id": "tb", "space": "b"})),
            ("pane", "pb", json!({"pane": "pb", "terminal": "/tmp/file"})),
        ] {
            let clicked = source("menu", kind, target.clone()).unwrap();
            assert_eq!((clicked.kind, clicked.id.as_str()), (kind, id));
            assert!(source("personal-menu", kind, target).is_none());
        }
        assert!(source("menu", "pane", json!({"pane": "/tmp/file"})).is_none());
        assert!(source("menu", "pane", json!({"pane": "tb"})).is_none());
        assert!(source("menu", "tab", json!({"id": "closed-tab"})).is_none());
    }
}
