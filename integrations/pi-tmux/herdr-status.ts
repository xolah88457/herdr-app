import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type State = "idle" | "working" | "blocked" | "done" | "error";
const OPTION = "@herdr_pi";

export default function (pi: ExtensionAPI) {
  const socket = process.env.TMUX?.match(/^(\/.+),[1-9]\d*,\d+$/)?.[1];
  const pane = process.env.TMUX_PANE;
  if (!socket || !pane || !/^%\d+$/.test(pane)) return;

  const owner = `${process.pid}:`;
  let active = false;
  let state: Exclude<State, "blocked"> = "idle";
  let prompting = false;
  let failed = false;
  let lastPublished: State | undefined;
  let pending = Promise.resolve();

  const tmux = async (args: string[]) => {
    try {
      const result = await pi.exec("tmux", ["-S", socket, ...args], { timeout: 1000, maxBuffer: 4096 });
      return result.code === 0;
    } catch {
      return false; // tmux is optional; never surface command output in Pi.
    }
  };

  const publish = () => {
    // UI notifications can overlap; capture the state before joining the queue.
    const next = prompting ? "blocked" : state;
    pending = pending.then(async () => {
      if (next === lastPublished) return;
      const ok = await tmux(["set-option", "-p", "-t", pane, OPTION, owner + next]);
      lastPublished = ok ? next : undefined;
    });
    return pending;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || active) return;
    active = true;
    state = "idle";
    prompting = failed = false;
    return publish();
  });

  pi.on("agent_start", () => {
    if (!active) return;
    state = "working";
    failed = false;
    return publish();
  });

  pi.on("agent_before_settle", (event) => {
    // Only record outcome metadata. A continuation may start before settlement.
    if (active) failed = event.outcome === "error";
  });

  pi.on("agent_settled", (event) => {
    if (!active) return;
    state = event.aborted ? "idle" : failed ? "error" : "done";
    return publish();
  });

  // Pi 1.5.2 coalesces nested/overlapping dialogs into one outer prompt span.
  pi.on("ui_prompt_start", () => {
    if (!active) return;
    prompting = true;
    return publish();
  });
  pi.on("ui_prompt_end", () => {
    if (!active) return;
    prompting = false;
    return publish();
  });

  pi.on("session_shutdown", () => {
    if (!active) return pending;
    active = false;
    pending = pending.then(async () => {
      // Check and unset in tmux's command queue, not in two client calls.
      await tmux(["if-shell", "-F", "-t", pane, `#{m:${owner}*,#{${OPTION}}}`,
        `set-option -pu -t ${pane} ${OPTION}`]);
      lastPublished = undefined;
    });
    return pending;
  });
}
