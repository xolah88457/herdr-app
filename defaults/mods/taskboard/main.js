import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { checking, spaces, exec, run, theme, layout } from "herdr";

const STATUSES = [
  ["started", "Started", "working"], ["ready", "Ready", "accent"], ["open", "Open", "muted"],
  ["blocked", "Blocked", "blocked"], ["review", "Review", "accent"], ["done", "Done", "done"],
];
const FOLDER_DELAY = 400;
const STALE = 10000;
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
const active = () => spaces().find(s => s.active);
const key = space => JSON.stringify([space?.id, space?.machine, space?.folder]);
const absolute = path => /^(?:\/|[a-z]:[\\/]|\\\\[^\\])/i.test(path ?? "");

async function list(options, done = false) {
  const result = await exec("tsk", ["list", "--json", ...(done ? ["--done"] : [])], options);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `tsk list exited with code ${result.code}.`);
  const tasks = JSON.parse(result.stdout);
  if (!Array.isArray(tasks) || tasks.some(task => !task || !Number.isSafeInteger(task.number) ||
    typeof task.title !== "string" || !STATUSES.some(([status]) => task.status === status))) {
    throw new Error("Unexpected output from tsk list.");
  }
  return tasks;
}

function rowsFor(tasks) {
  const rows = [];
  for (const [status, label, color] of STATUSES) {
    const group = tasks.filter(task => task.status === status);
    if (group.length) rows.push({ status, label: `${label} · ${group.length}`, color }, ...group);
  }
  return rows;
}

export default class Taskboard extends View {
  current(state) {
    return this.state === state && state.key === key(active());
  }

  // The panel is alive while hidden or behind another panel; only a shown board needs tasks.
  visible() {
    const tree = layout(), panel = find(tree, "panel"), body = find(tree, "panel-body");
    return !panel || (!panel.hidden && (!body || body.active === "taskboard"));
  }

  // A `cd` changes the folder many times a minute: the same space's new folder waits briefly.
  refresh(cx) {
    if (checking() || !this.visible()) return;
    const space = active(), context = key(space);
    if (this.state?.key === context && this.state.loading) return;
    const before = this.state;
    const same = before?.key === context;
    const moved = !same && before?.space === space?.id && before?.machine === space?.machine;
    const state = { key: context, space: space?.id, machine: space?.machine, rows: same ? before.rows : [], folder: same ? before.folder : undefined };
    this.state = state;
    if (!absolute(space?.folder)) return;

    const options = { cwd: space.folder, on: space.machine, timeout: 5000 };
    state.loading = true;
    if (moved) cx.timer.after(FOLDER_DELAY, cx => { if (this.current(state)) this.load(state, options, cx); });
    else this.load(state, options, cx);
  }

  load(state, options, cx) {
    cx.spawn(async cx => {
      try {
        // Like the interactive board, tsk list picks the repo or Desk from its cwd.
        const [tasks, done] = await Promise.all([list(options), list(options, true)]);
        if (!this.current(state)) return;
        state.rows = rowsFor([...tasks, ...done]);
        state.folder = options.cwd;
        state.at = Date.now();
        state.error = undefined;
      } catch (error) {
        if (!this.current(state)) return;
        const detail = String(error);
        // A missing program and a missing working folder both fail to start (ENOENT).
        const missing = /cannot (?:run|start) tsk(?:\.exe)?:.*(?:not found|no such file|cannot find|os error 2\b)/i.test(detail);
        state.error = missing
          ? `tsk not found on ${options.on ?? "this machine"}, or the folder no longer exists. Install tsk and put it on PATH, or open an existing folder, then refresh.`
          : `Cannot load tasks: ${detail.slice(0, 220)}`;
        state.rows = [];
        state.folder = undefined;
      } finally {
        state.loading = false;
        if (this.current(state)) cx.notify();
      }
    });
  }

  open(state) {
    if (!this.current(state) || state.loading || !state.folder) return;
    run("tab.new", { name: "tsk", space: active().id, folder: state.folder, argv: ["tsk"] });
  }

  render(cx) {
    const space = active();
    const shown = this.state;
    if (shown?.key !== key(space)) this.refresh(cx);
    // Render only runs when something notifies: looking at a stale board again reloads it (not polling).
    else if (shown.at && !shown.loading && Date.now() - shown.at > STALE && this.visible()) this.refresh(cx);
    const state = this.state ?? { rows: [] }, t = theme();
    const { rows, loading, folder, error } = state;
    const listId = "taskboard-list";
    const button = (id, label, action) => div().id(id).px(7).h(26).flex_none().flex().items_center().rounded(6)
      .text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer().on_click(action).child(label);
    let message = loading ? "Loading tasks…" : "No open tasks.";
    if (!absolute(space?.folder)) message = "Tasks needs a space with a folder.";
    if (error) message = error;
    return v_flex().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("Tasks"))
        .when(absolute(space?.folder), el => el.child(button("taskboard-refresh", "Refresh", (_e, cx) => { this.refresh(cx); cx.notify(); })))
        .when(Boolean(folder), el => el.child(button("taskboard-open", "Open tsk", () => this.open(state)))))
      .when(Boolean(folder), el => el.child(div().px(12).pt(6).truncate().text_size(11).text_color(t.dim).child(folder)))
      .when(!rows.length, el => el.child(div().p(12).text_color(t.muted).child(message)))
      .when(rows.length > 0, el => el.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list(listId, rows.length, 28, i => String(rows[i].number ?? rows[i].status), range =>
          rows.slice(range.start, range.end).map(row => h_flex().h(28).px(12).gap(8).items_center()
            .when(Boolean(row.label), item => item.text_color(t[row.color]).font_semibold().text_size(12).child(row.label))
            .when(!row.label, item => item
              .child(div().flex_none().text_size(11).text_color(t.dim).child(`T${row.number}`))
              .child(div().flex_1().min_w(0).truncate().child(row.title))))).size_full())
        .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0())));
  }
}
