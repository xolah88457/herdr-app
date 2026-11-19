#[test]
fn placing_a_space_reuses_its_split_and_mod_inside_the_workspace() {
    in_own_process("inline_space_content");
}

#[gpui::test]
fn inline_space_content(cx: &mut gpui::TestAppContext) {
    use crate::{
        layout::{Axis, Content, Node},
        model::Tab,
    };
    use serde_json::json;
    if !running_alone("inline_space_content") {
        return;
    }
    let (view, cx) = open_window(
        cx,
        "proof",
        "export default () => null;",
        json!({
            "id": "main", "type": "block", "content": {"tab": "active"}
        }),
    );
    cx.update(|window, cx| {
        view.update(cx, |this, cx| {
            this.model
                .add_space("api", "API", "", Tab::new("api-tab", "", "api-pane", "t1"));
            let mut web = Tab::new("web-tab", "", "web-pane", "t2");
            assert!(web.root.split(
                "web-pane",
                Axis::Column,
                Node::block(
                    "web-mod",
                    Content::Mod {
                        name: "proof".into(),
                        props: json!({"marker":"web"}),
                    }
                ),
                "web-split".into()
            ));
            let original = serde_json::to_value(&web.root).unwrap();
            this.model.add_space_unshown("web", "Web", "", web);
            assert!(this.place_workspace_tile("space", "web", "right"));
            this.sync(window, cx);
            let (terms, mods) = this.visible();
            for (pane, address) in [("api-pane", "t1"), ("web-pane", "t2")] {
                assert!(terms.iter().any(|(id, addr)| id == pane && addr == address));
            }
            assert!(
                mods.iter()
                    .any(|(id, instance)| id == "web-mod" && instance.props["marker"] == "web")
            );
            assert!(
                this.overlays.is_empty(),
                "placement belongs to the main workspace"
            );
            this.clear_workspace_tiles();
            this.sync(window, cx);
            assert!(!this.visible().0.iter().any(|(_, addr)| addr == "t2"));
            assert_eq!(
                serde_json::to_value(
                    &this
                        .model
                        .space("web")
                        .unwrap()
                        .tab("web-tab")
                        .unwrap()
                        .root
                )
                .unwrap(),
                original
            );
        })
    });
}

#[test]
fn shipped_row_pointer_drags_place_cancel_and_reorder() {
    in_own_process("workspace_row_gestures");
}

#[gpui::test]
fn workspace_row_gestures(cx: &mut gpui::TestAppContext) {
    use crate::{
        layout::{Axis, Content, Node},
        model::Tab,
    };
    use gpui::{MouseButton, Pixels, Point, VisualTestContext, point, px, size};
    use serde_json::json;
    if !running_alone("workspace_row_gestures") {
        return;
    }

    fn draw(cx: &mut VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    fn drag(cx: &mut VisualTestContext, start: Point<Pixels>, end: Point<Pixels>) {
        let left = MouseButton::Left;
        cx.simulate_mouse_move(start, None, Default::default());
        cx.simulate_mouse_down(start, left, Default::default());
        // Cross GPUI's threshold on the row before moving onto the drop surface.
        cx.simulate_mouse_move(start + point(px(6.), px(0.)), left, Default::default());
        draw(cx);
        cx.simulate_mouse_move(end, left, Default::default());
        draw(cx);
        cx.simulate_mouse_up(end, left, Default::default());
        draw(cx);
    }

    // Keep the shipped renderer and every gesture handler. Only suppress the
    // sidebar's unrelated external `hc machine ls` in the isolated executor.
    let (view, cx) = open_window(
        cx,
        "spaces",
        concat!(
            include_str!("../../defaults/mods/spaces/main.js"),
            "\nSpaces.prototype.refreshMachines = () => {};"
        ),
        json!({"id":"main","type":"block","content":{"tab":"active"}}),
    );
    cx.simulate_resize(size(px(1000.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |this, cx| {
            let mut web = Tab::new("web-tab", "Web", "server", "t1");
            assert!(web.root.split(
                "server",
                Axis::Column,
                Node::block(
                    "inspector",
                    Content::Mod {
                        name: "unused-view".into(),
                        props: json!({"key": "original"}),
                    }
                ),
                "web-split".into()
            ));
            this.model.add_space("web", "Web", "", web);
            let mut logs = Tab::new("logs-tab", "Logs", "tail", "t2");
            assert!(logs.root.split(
                "tail",
                Axis::Row,
                Node::block(
                    "filter",
                    Content::Terminal {
                        terminal: "t3".into()
                    }
                ),
                "logs-split".into()
            ));
            logs.focus("filter");
            this.model.add_space("api", "API", "", logs);
            assert!(
                this.model
                    .add_tab("api", Tab::new("main-tab", "Home", "shell", "t4"))
            );
            this.documents.entry(String::new()).or_default().available = true; // Allow row reorder commands on the offline model.
            this.sync(window, cx); // Publish the spaces before the sidebar takes its initial snapshot.
            this.chrome = serde_json::from_value(json!({"id":"root","type":"row","children":[
                {"id":"sidebar","type":"block","size":{"px":220},"content":{"mod":"spaces"}},
                {"id":"body","type":"column","children":[
                    {"id":"strip","type":"block","size":{"px":40},"content":{"mod":"tabs"}},
                    {"id":"main","type":"block","content":{"tab":"active"}}
                ]}
            ]}))
            .unwrap();
            this.sync(window, cx);
        })
    });
    draw(cx);
    let (space, tab, main) = view.update(cx, |this, _| {
        for slot in ["strip", "sidebar"] {
            let copy = &this.copies[slot];
            assert!(copy.root.is_some(), "{slot}: {:?}", copy.error);
        }
        let b = this.bounds.borrow();
        // Interior of the first space under the heading and the first tab label.
        (
            b["sidebar"].origin + point(px(40.), px(46.)),
            point(b["strip"].left() + px(26.), b["strip"].center().y),
            b["main"],
        )
    });
    let trees = |this: &super::AppWindow| {
        this.model
            .spaces
            .iter()
            .flat_map(|s| {
                s.tabs.iter().map(|t| {
                    (
                        (s.id.clone(), t.id.clone()),
                        serde_json::to_value(&t.root).unwrap(),
                    )
                })
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let originals = view.update(cx, |this, _| trees(this));
    let right = point(main.right() - px(16.), main.center().y);
    let bottom = point(main.center().x, main.bottom() - px(16.));
    let outside = point(main.left() - px(20.), main.center().y); // sidebar, outside all rows

    for start in [space, tab] {
        for end in [main.center(), outside] {
            drag(cx, start, end);
            view.update(cx, |this, _| {
                assert!(
                    !this.workspace_tiling_active(),
                    "canceled drag from {start:?} to {end:?}"
                );
                assert_eq!(this.model.focused_pane().as_deref(), Some("shell"));
                assert_eq!(trees(this), originals);
            });
        }
    }
    // Positive controls for the same starting coordinates as the canceled drags:
    // reorder on a neighbor, then move the new first row back to second.
    let other_space = space + point(px(0.), px(30.));
    let other_tab = tab + point(px(84.), px(0.));
    drag(cx, space, other_space);
    drag(cx, tab, other_tab);
    view.update(cx, |this, _| {
        assert_eq!(
            this.model.spaces.iter().map(|s| &*s.id).collect::<Vec<_>>(),
            ["api", "web"]
        );
        assert_eq!(
            this.model
                .space("api")
                .unwrap()
                .tabs
                .iter()
                .map(|t| &*t.id)
                .collect::<Vec<_>>(),
            ["main-tab", "logs-tab"]
        );
        assert_eq!(this.model.focused_pane().as_deref(), Some("shell"));
        assert_eq!(trees(this), originals);
    });
    drag(cx, space, other_space);
    // The selected tab is now first and has a close button, so the second starts farther right.
    drag(cx, tab, other_tab + point(px(20.), px(0.)));
    drag(cx, space, right);
    view.update(cx, |this, _| {
        let roots: Vec<_> = this.workspace_roots().collect();
        for id in ["main-tab", "web-tab"] {
            assert!(
                roots
                    .iter()
                    .any(|&r| std::ptr::eq(r, &this.model.tab(id).unwrap().root)),
                "original {id} must be drawn"
            );
        }
        let b = this.bounds.borrow();
        assert_eq!(b["web-tab"].left(), main.center().x);
        assert_eq!(b["web-tab"].bottom_right(), main.bottom_right());
        assert_eq!(trees(this), originals);
    });
    drag(cx, tab, bottom);
    view.update(cx, |this, _| {
        let roots: Vec<_> = this.workspace_roots().collect();
        for id in ["shell", "filter"] {
            assert!(
                roots.iter().any(|&r| std::ptr::eq(
                    r,
                    this.model.tab_of(id).unwrap().root.find(id).unwrap()
                )),
                "original {id} must be drawn"
            );
        }
        let b = this.bounds.borrow();
        assert_eq!(b["filter"].top(), main.center().y);
        assert_eq!(b["filter"].bottom_right(), main.bottom_right());
        assert_eq!(trees(this), originals);
    });
}

#[test]
fn dragging_squeezed_layout_blocks_never_crashes() {
    in_own_process("squeezed_layout_drag");
}

#[gpui::test]
fn squeezed_layout_drag(cx: &mut gpui::TestAppContext) {
    use gpui::{point, px, size};
    use serde_json::json;
    if !running_alone("squeezed_layout_drag") {
        return;
    }
    let block = |id: &str, height: f32| {
        json!({
            "id": id, "type": "block", "size": {"px": height}, "content": {"mod": "drag-probe"}
        })
    };
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
    let (view, cx) = open_window(
        cx,
        "drag-probe",
        "export default () => null;",
        layout.clone(),
    );
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
                        let total =
                            f32::from(bounds[&a.id].size.height + bounds[&b.id].size.height)
                                / super::settings::zoom();
                        drop(bounds);
                        let before = serde_json::to_value(parent).unwrap();
                        this.drag = Some(super::Drag {
                            container: container.into(),
                            index,
                            axis: super::Axis::Column,
                        });
                        this.drag_to(point(px(100.0), px(y)));
                        let after = this.chrome.find(container).unwrap();
                        if container == "sidebar" || total <= 48.0 {
                            assert_eq!(
                                serde_json::to_value(after).unwrap(),
                                before,
                                "{container}[{index}], height {height}"
                            );
                        } else {
                            for child in &after.children()[index..=index + 1] {
                                if let Some(super::Span::Px { px }) = child.size {
                                    assert!(
                                        px >= 0.0 && px <= total,
                                        "{}: {px} out of {total}",
                                        child.id
                                    );
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
