#[test]
fn placing_a_space_reuses_its_split_and_mod_inside_the_workspace() {
    in_own_process("inline_space_content");
}

#[gpui::test]
fn inline_space_content(cx: &mut gpui::TestAppContext) {
    use crate::{layout::{Axis, Content, Node}, model::Tab};
    use serde_json::json;
    if !running_alone("inline_space_content") { return; }
    let (view, cx) = open_window(cx, "proof", "export default () => null;", json!({
        "id": "main", "type": "block", "content": {"tab": "active"}
    }));
    cx.update(|window, cx| view.update(cx, |this, cx| {
        this.model.add_space("api", "API", "", Tab::new("api-tab", "", "api-pane", "t1"));
        let mut web = Tab::new("web-tab", "", "web-pane", "t2");
        assert!(web.root.split("web-pane", Axis::Column, Node::block("web-mod", Content::Mod {
            name: "proof".into(), props: json!({"marker":"web"}),
        }), "web-split".into()));
        let original = serde_json::to_value(&web.root).unwrap();
        this.model.add_space_unshown("web", "Web", "", web);
        assert!(this.place_workspace_tile("space", "web", "right"));
        this.sync(window, cx);
        let (terms, mods) = this.visible();
        for (pane, address) in [("api-pane", "t1"), ("web-pane", "t2")] {
            assert!(terms.iter().any(|(id, addr)| id == pane && addr == address));
        }
        assert!(mods.iter().any(|(id, instance)| id == "web-mod" && instance.props["marker"] == "web"));
        assert!(this.overlays.is_empty(), "placement belongs to the main workspace");
        this.clear_workspace_tiles();
        this.sync(window, cx);
        assert!(!this.visible().0.iter().any(|(_, addr)| addr == "t2"));
        assert_eq!(serde_json::to_value(&this.model.space("web").unwrap().tab("web-tab").unwrap().root).unwrap(), original);
    }));
}

#[test]
fn dragging_squeezed_layout_blocks_never_crashes() {
    in_own_process("squeezed_layout_drag");
}

#[gpui::test]
fn squeezed_layout_drag(cx: &mut gpui::TestAppContext) {
    use gpui::{point, px, size};
    use serde_json::json;
    if !running_alone("squeezed_layout_drag") { return; }
    let block = |id: &str, height: f32| json!({
        "id": id, "type": "block", "size": {"px": height}, "content": {"mod": "drag-probe"}
    });
    let layout = json!({"id": "root", "type": "row", "children": [
        {"id": "sidebar", "type": "column", "size": {"px": 268}, "resizable": false, "children": [
            block("brand", 46.0), block("button", 52.0),
            {"id": "lists", "type": "column", "divider": {"width": 1, "color": "border"}, "children": [
                block("heading", 34.0),
                {"id": "stack", "type": "stack", "children": [
                    {"id": "list", "type": "block", "content": {"mod": "drag-probe"}}
                ]},
                block("zero1", 0.0), block("zero2", 0.0), block("zero3", 0.0), block("zero4", 0.0), block("zero5", 0.0)
            ]},
            block("pendientes", 200.0), block("vistas", 46.0)
        ]}
    ]});
    let (view, cx) = open_window(cx, "drag-probe", "export default () => null;", layout.clone());
    for height in [800.0, 380.0, 344.0, 300.0] {
        cx.simulate_resize(size(px(900.0), px(height)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.update(cx, |this, _| {
            for (container, count) in [("sidebar", 4), ("lists", 6)] {
                for index in 0..count {
                    for y in [-2000.0, 0.0, 2000.0] {
                        this.chrome = serde_json::from_value(layout.clone()).unwrap();
                        let parent = this.chrome.find(container).unwrap();
                        let a = &parent.children()[index];
                        let b = &parent.children()[index + 1];
                        let bounds = this.bounds.borrow();
                        let total = f32::from(bounds[&a.id].size.height + bounds[&b.id].size.height) / super::settings::zoom();
                        drop(bounds);
                        let before = serde_json::to_value(parent).unwrap();
                        this.drag = Some(super::Drag { container: container.into(), index, axis: super::Axis::Column });
                        this.drag_to(point(px(100.0), px(y)));
                        let after = this.chrome.find(container).unwrap();
                        if container == "sidebar" || total <= 48.0 {
                            assert_eq!(serde_json::to_value(after).unwrap(), before, "{container}[{index}], height {height}");
                        } else {
                            for child in &after.children()[index..=index + 1] {
                                if let Some(super::Span::Px { px }) = child.size {
                                    assert!(px >= 0.0 && px <= total, "{}: {px} out of {total}", child.id);
                                }
                            }
                        }
                    }
                }
            }
            this.drag = None;
        });
    }
}
