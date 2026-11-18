import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { checking, spaces, exec, run, theme } from "herdr";

const STATUSES = [
  ["started", "Started", "working"], ["ready", "Ready", "accent"], ["open", "Open", "muted"],
  ["blocked", "Blocked", "blocked"], ["review", "Review", "accent"], ["done", "Done", "done"],
];
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

  refresh(cx) {
    if (checking()) return;
    const space = active(), context = key(space);
    if (this.state?.key === context && this.state.loading) return;
    const rows = this.state?.key === context ? this.state.rows : [];
    const state = { key: context, rows };
    this.state = state;
    if (!absolute(space?.folder)) return;

    const options = { cwd: space.folder, on: space.machine, timeout: 5000 };
    state.loading = true;
    cx.spawn(async cx => {
      try {
        // Like the interactive board, tsk list picks the repo or Desk from its cwd.
        const tasks = await list(options);
        if (!this.current(state)) return;
        const done = await list(options, true);
        if (!this.current(state)) return;
        state.rows = rowsFor([...tasks, ...done]);
        state.folder = options.cwd;
      } catch (error) {
        if (!this.current(state)) return;
        const detail = String(error);
        const missing = /cannot (?:run|start) tsk(?:\.exe)?:.*(?:not found|no such file|cannot find|os error 2\b)/i.test(detail);
        state.error = missing
          ? `tsk not found on ${space.machine ?? "this machine"}. Install it and put it on PATH, then refresh.`
          : `Cannot load tasks: ${detail.slice(0, 220)}`;
        state.rows = [];
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
    if (this.state?.key !== key(space)) this.refresh(cx);
    const state = this.state ?? { rows: [] }, t = theme();
    const { rows, loading, folder, error } = state;
    const listId = "taskboard-list";
    const button = (id, label, action) => div().id(id).px(7).h(26).flex_none().flex().items_center().rounded(6)
      .text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer().on_click(action).child(label);
    let message = loading ? "Loading tasks…" : "No tasks to show.";
    if (!absolute(space?.folder)) message = "Open a space with an absolute folder path.";
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
