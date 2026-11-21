//! Inline workspace tiles are projections, not a second layout tree. Keep just
//! the owners and rectangles here; the model still owns all nodes and pane IDs.
use super::*;

/// Coordinates and extents in half-workspace units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Slot { x: u8, y: u8, w: u8, h: u8 }

impl Slot {
    pub(super) fn bounds(self, area: Bounds<Pixels>) -> Bounds<Pixels> {
        let half = |n: u8| f32::from(n) / 2.;
        Bounds::new(area.origin + point(area.size.width * half(self.x), area.size.height * half(self.y)),
            size(area.size.width * half(self.w), area.size.height * half(self.h)))
    }

    pub(super) const fn new(x: u8, y: u8, w: u8, h: u8) -> Self {
        Self { x, y, w, h }
    }

    pub(super) const LEFT: Self = Self::new(0, 0, 1, 2);
    pub(super) const RIGHT: Self = Self::new(1, 0, 1, 2);
    pub(super) const TOP: Self = Self::new(0, 0, 2, 1);
    pub(super) const BOTTOM: Self = Self::new(0, 1, 2, 1);
    pub(super) const TOP_LEFT: Self = Self::new(0, 0, 1, 1);
    pub(super) const TOP_RIGHT: Self = Self::new(1, 0, 1, 1);
    pub(super) const BOTTOM_LEFT: Self = Self::new(0, 1, 1, 1);
    pub(super) const BOTTOM_RIGHT: Self = Self::new(1, 1, 1, 1);

    fn opposite(self) -> Self {
        Self { x: 2 - self.w - self.x, y: 2 - self.h - self.y, ..self }
    }

    fn overlaps(self, other: Self) -> bool {
        self.x < other.x + other.w && other.x < self.x + self.w && self.y < other.y + other.h && other.y < self.y + self.h
    }
}

/// What a tile menu or drag carries: the model object being placed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum TileKind { Space, Tab, Pane }

impl TileKind {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Space => "space",
            Self::Tab => "tab",
            Self::Pane => "pane",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Owner { Space(String), Pane(String) }

impl Owner {
    fn root<'m>(&self, model: &'m Model) -> Option<&'m Node> {
        match self {
            Self::Space(id) => Some(model.space(id)?.active_tab()?.shown()),
            Self::Pane(id) => {
                let tab = model.tab_of(id)?;
                tab.root.find(id).filter(|n| n.is_pane() && !n.hidden && tab.root.visible_blocks().iter().any(|b| b.id == *id))
            }
        }
    }

    fn focused_pane(&self, model: &Model) -> Option<String> {
        match self {
            Self::Space(id) => model.space(id)?.active_tab()?.focused_pane(),
            Self::Pane(id) => Some(id.clone()),
        }
    }

    fn current(&self, model: &Model) -> Option<Self> {
        match self {
            Self::Space(_) => Some(Self::Space(model.active_space()?.id.clone())),
            Self::Pane(_) => Some(Self::Pane(model.focused_pane()?)),
        }
    }
}

#[derive(Default)]
pub(super) struct WorkspaceTiles(Vec<(Owner, Slot)>);

impl WorkspaceTiles {
    fn contains(&self, owner: &Owner) -> bool {
        self.0.iter().any(|(o, _)| o == owner)
    }

    fn place(&mut self, model: &mut Model, kind: TileKind, id: &str, slot: Slot) -> bool {
        let owner = match kind {
            TileKind::Space => Owner::Space(id.to_owned()),
            TileKind::Pane => Owner::Pane(id.to_owned()),
            TileKind::Tab => match model.tab(id).and_then(Tab::focused_pane) {
                Some(pane) => Owner::Pane(pane),
                None => return false,
            },
        };
        if owner.root(model).is_none() { return false; }
        let current = owner.current(model);
        // Space and pane layouts don't mix: switching a space's tab could
        // otherwise draw a pane already placed elsewhere in the same frame.
        let mut tiles = self.0.clone();
        tiles.retain(|(o, _)| std::mem::discriminant(o) == std::mem::discriminant(&owner) && o.root(model).is_some());
        tiles.retain(|(o, s)| *o != owner && !s.overlaps(slot));
        if tiles.is_empty() && let Some(active) = current.as_ref().filter(|o| **o != owner && o.root(model).is_some()) {
            tiles.push((active.clone(), slot.opposite()));
        }
        // A lone tile would leave the rest of the workspace blank.
        if tiles.is_empty() { return false; }
        // When the drop covers the active owner, don't leave the keyboard in a
        // hidden terminal. Otherwise keep the user's selection exactly as is.
        if current.as_ref().is_none_or(|o| *o != owner && !tiles.iter().any(|(t, _)| t == o)) && let Some(p) = owner.focused_pane(model) {
            model.focus_pane(&p);
        }
        tiles.push((owner, slot));
        self.0 = tiles;
        true
    }

    pub(super) fn reconcile(&mut self, model: &mut Model) {
        let before = self.0.len();
        self.0.retain(|(o, _)| o.root(model).is_some());
        let Some((first, _)) = self.0.first() else { return };
        let current = first.current(model);
        if self.0.len() < 2 {
            // A lone tile would leave the rest of the workspace blank: show the survivor normally.
            if self.0.len() < before && current.as_ref() != Some(first) && let Some(p) = first.focused_pane(model) {
                model.focus_pane(&p);
            }
            self.0.clear();
            return;
        }
        if current.as_ref().is_some_and(|o| self.contains(o)) { return; }
        // Splitting a tiled pane focuses the new pane: it takes over that tile.
        if self.0.len() == before && let Some(Owner::Pane(now)) = current
            && let Some(tab) = model.tab_of(&now)
            && let Some(parent) = tab.root.parent_of(&now).map(|p| p.id.as_str())
            && let Some(i) = self.0.iter().position(|(o, _)| matches!(o, Owner::Pane(id)
                if *id != now && tab.root.parent_of(id).is_some_and(|p| p.id == parent)))
        {
            self.0[i].0 = Owner::Pane(now);
            return;
        }
        if self.0.len() < before && let Some(p) = first.focused_pane(model) {
            // Closing the active tile can select an unrelated tab/space. Keep
            // the surviving tiles and give the keyboard to one still on screen.
            model.focus_pane(&p);
        } else {
            // Explicit navigation outside the tiles returns to normal content.
            self.0.clear();
        }
    }
}

impl AppWindow {
    /// Native menu/drop handlers sync the window after changing placements.
    pub(super) fn place_workspace_tile(&mut self, kind: TileKind, id: &str, slot: Slot) -> bool {
        self.shows_tab() && self.workspace_tiles.place(&mut self.model, kind, id, slot)
    }

    pub(super) fn clear_workspace_tiles(&mut self) {
        self.workspace_tiles.0.clear();
    }

    pub(super) fn workspace_tiling_active(&self) -> bool {
        !self.workspace_tiles.0.is_empty()
    }

    /// The exact original roots drawn in a Context block, also used for attachment and navigation.
    pub(super) fn workspace_roots(&self) -> impl Iterator<Item = &Node> {
        let ordinary = (!self.workspace_tiling_active()).then(|| self.model.active_tab()).flatten().map(Tab::shown);
        ordinary.into_iter().chain(self.workspace_tiles.0.iter().filter_map(|(o, _)| o.root(&self.model)))
    }

    pub(super) fn render_workspace(&self, focused: &HashSet<String>, cx: &mut Context<Self>) -> AnyElement {
        let frame = self.pane_frame();
        if self.workspace_tiling_active() {
            let mut body = div().relative().size_full().overflow_hidden();
            let half = |n: u8| relative(f32::from(n) / 2.);
            for (owner, slot) in &self.workspace_tiles.0 {
                if let Some(root) = owner.root(&self.model) {
                    body = body.child(div().absolute().left(half(slot.x)).top(half(slot.y)).w(half(slot.w)).h(half(slot.h))
                        .overflow_hidden().child(self.render_node(root, focused, frame, cx)));
                }
            }
            return body.into_any_element();
        }
        if let Some(tab) = self.model.active_tab() {
            return self.render_node(tab.shown(), focused, frame, cx);
        }
        if self.documents.get("").is_some_and(|s| s.layout() == "loading") {
            return div().size_full().into_any_element();
        }
        let key = crate::keys::listing().into_iter().find(|(_, _, a)| a == "space.new").map(|(_, k, _)| format!(" ({k})"));
        div().size_full().flex().items_center().justify_center().text_color(c("dim"))
            .child(format!("No space open. Make one{}.", key.unwrap_or_default())).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{Axis, Content, Model, Node, Slot, Tab, TileKind, WorkspaceTiles, json};
    use crate::window::tile_input::POSITIONS;

    impl Slot {
        /// Named placements keep the tests readable.
        fn named(name: &str) -> Option<Self> {
            POSITIONS.iter().flatten().flatten().find(|(n, ..)| *n == name).map(|(_, slot, _)| *slot)
        }
    }

    #[test]
    fn slot_coverage_and_opposites_match_all_eight_drop_positions() {
        let cells = [("top-left", 1), ("top-right", 2), ("bottom-left", 4), ("bottom-right", 8)];
        let wanted = [("left", 5), ("right", 10), ("top", 3), ("bottom", 12)];
        assert_eq!(POSITIONS.iter().flatten().flatten().count(), cells.len() + wanted.len());
        for (name, bits) in cells.into_iter().chain(wanted) {
            let slot = Slot::named(name).unwrap();
            assert_eq!(slot.opposite().opposite(), slot);
            assert!(!slot.overlaps(slot.opposite()));
            for (corner, bit) in cells {
                assert_eq!(slot.overlaps(Slot::named(corner).unwrap()), bits & bit != 0, "{name}, {corner}");
            }
        }
    }

    fn spaces() -> Model {
        let mut m = Model::default();
        m.add_space("api", "API", "", Tab::new("a", "", "shell", "t1"));
        m.add_space_unshown("web", "Web", "", Tab::new("b", "", "server", "t2"));
        m.add_space_unshown("db", "DB", "", Tab::new("c", "", "query", "t3"));
        m
    }

    fn at<'a>(tiles: &WorkspaceTiles, model: &'a Model, placement: &str) -> Option<&'a Node> {
        let slot = Slot::named(placement)?;
        tiles.0.iter().find(|(_, s)| *s == slot)?.0.root(model)
    }

    #[test]
    fn space_pair_projects_original_split_and_tracks_selected_tab() {
        let mut model = spaces();
        let editor = Node::block("editor", Content::Mod { name: "editor".into(), props: json!({"file":"index"}) });
        assert!(model.split_with("server", Axis::Column, editor));
        model.focus_pane("shell");
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut model, TileKind::Space, "web", Slot::named("right").unwrap()));
        assert_eq!(model.focused_pane().as_deref(), Some("shell"));
        assert_eq!(at(&tiles, &model, "left").unwrap().id, "a");
        let root = at(&tiles, &model, "right").unwrap();
        assert!(std::ptr::eq(root, &model.tab("b").unwrap().root));
        assert_eq!(root.panes().len(), 2);
        assert!(matches!(root.find("editor").unwrap().content(), Some(Content::Mod { .. })));
        model.focus_pane("editor");
        tiles.reconcile(&mut model);
        assert_eq!(tiles.0.len(), 2);
        model.add_tab("web", Tab::new("b2", "", "docs", "t4"));
        tiles.reconcile(&mut model);
        assert_eq!(at(&tiles, &model, "right").unwrap().id, "b2");
        assert_eq!(at(&tiles, &model, "left").unwrap().id, "a");
    }

    #[test]
    fn cross_tab_placements_use_pane_ids_and_leave_source_trees_intact() {
        let mut m = spaces();
        m.add_tab("api", Tab::new("log", "", "tail", "t4"));
        m.split("tail", Axis::Row, "filter", "t5");
        m.focus_pane("shell");
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut m, TileKind::Tab, "log", Slot::named("top-right").unwrap()));
        assert_eq!(at(&tiles, &m, "bottom-left").unwrap().id, "shell");
        assert_eq!(at(&tiles, &m, "top-right").unwrap().id, "filter");
        assert!(!tiles.place(&mut m, TileKind::Pane, "log", Slot::named("top").unwrap())); // not a pane
        m.focus_pane("filter");
        tiles.reconcile(&mut m);
        assert!(tiles.place(&mut m, TileKind::Pane, "filter", Slot::named("right").unwrap()));
        assert!(at(&tiles, &m, "top-right").is_none());
        assert_eq!(tiles.0.len(), 2);
        assert!(tiles.place(&mut m, TileKind::Pane, "tail", Slot::named("top-right").unwrap())); // overlaps the active half
        assert_eq!(m.focused_pane().as_deref(), Some("tail"));
        assert_eq!(tiles.0.len(), 2);
        m.focus_pane("server"); // leave the arrangement
        tiles.reconcile(&mut m);
        assert!(tiles.0.is_empty());
        assert_eq!(m.tab("log").unwrap().root.panes().len(), 2);
        assert_eq!(m.address_of("filter").as_deref(), Some("t5"));
    }

    #[test]
    fn closing_one_of_two_tiles_shows_the_survivor_normally() {
        let mut m = spaces();
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut m, TileKind::Space, "web", Slot::named("top").unwrap()));
        assert!(!tiles.place(&mut m, TileKind::Space, "missing", Slot::named("bottom").unwrap()));
        m.remove_space("api");
        m.active = Some("db".into()); // fallback chosen by the model
        tiles.reconcile(&mut m);
        assert_eq!(m.focused_pane().as_deref(), Some("server"));
        assert!(tiles.0.is_empty());
        assert_eq!(m.active.as_deref(), Some("web"));
    }

    #[test]
    fn a_lone_tile_is_refused_and_a_split_pane_joins_its_tile() {
        let mut m = spaces();
        let mut tiles = WorkspaceTiles::default();
        assert!(!tiles.place(&mut m, TileKind::Space, "api", Slot::named("left").unwrap())); // the active owner alone
        assert!(tiles.0.is_empty());
        m.add_tab("api", Tab::new("log", "", "tail", "t4"));
        m.focus_pane("shell");
        assert!(tiles.place(&mut m, TileKind::Tab, "log", Slot::named("top-right").unwrap()));
        m.split("shell", Axis::Row, "shell2", "t6");
        m.focus_pane("shell2");
        tiles.reconcile(&mut m);
        assert_eq!(tiles.0.len(), 2);
        assert_eq!(at(&tiles, &m, "bottom-left").unwrap().id, "shell2");
    }

    #[test]
    fn splitting_the_second_of_two_tiles_from_one_tab_replaces_that_tile() {
        let mut m = spaces();
        m.split("shell", Axis::Row, "shell2", "t4");
        m.focus_pane("shell");
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut m, TileKind::Pane, "shell2", Slot::RIGHT));
        assert_eq!(tiles.0.len(), 2);
        m.split("shell2", Axis::Column, "shell3", "t5");
        m.focus_pane("shell3");
        tiles.reconcile(&mut m);
        assert_eq!(at(&tiles, &m, "right").unwrap().id, "shell3");
        assert_eq!(at(&tiles, &m, "left").unwrap().id, "shell");
    }

    #[test]
    fn a_drop_covering_every_tile_keeps_the_active_owner_opposite() {
        let mut m = spaces();
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut m, TileKind::Space, "web", Slot::RIGHT));
        assert!(tiles.place(&mut m, TileKind::Space, "db", Slot::TOP));
        assert_eq!(tiles.0.len(), 2);
        assert_eq!(at(&tiles, &m, "top").unwrap().id, "c");
        assert_eq!(at(&tiles, &m, "bottom").unwrap().id, "a");
    }

    #[test]
    fn a_pane_under_a_hidden_ancestor_is_not_a_tile_root() {
        let mut m = spaces();
        m.split("shell", Axis::Row, "shell2", "t4");
        m.focus_pane("shell");
        let mut tiles = WorkspaceTiles::default();
        assert!(tiles.place(&mut m, TileKind::Pane, "shell2", Slot::RIGHT));
        let parent = m.tab("a").unwrap().root.parent_of("shell2").unwrap().id.clone();
        m.tab_mut("a").unwrap().root.find_mut(&parent).unwrap().hidden = true;
        assert!(super::Owner::Pane("shell2".into()).root(&m).is_none());
    }
}
