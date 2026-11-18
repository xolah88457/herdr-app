import { expect, test } from "bun:test";
import install from "../integrations/pi-tmux/herdr-status";

const socket = "/tmp/pi-tmux-publisher-test";
const tmux = `${socket},123,0`;
const pane = "%7";
const prefix = ["tmux", "-S", socket];
const write = (state: string) => [...prefix, "set-option", "-p", "-t", pane, "@herdr_pi", `${process.pid}:${state}`];
const cleanup = [...prefix, "if-shell", "-F", "-t", pane, `#{m:${process.pid}:*,#{@herdr_pi}}`,
  `set-option -pu -t ${pane} @herdr_pi`];

type Handler = (event: object, ctx: { mode: string }) => unknown;

function harness(options: {
  mode?: string;
  env?: readonly [string | undefined, string | undefined];
  exec?: (args: string[]) => Promise<{ code: number }>;
} = {}) {
  const handlers = new Map<string, Handler>();
  const calls: string[][] = [];
  const previous = [process.env.TMUX, process.env.TMUX_PANE];
  const setEnv = (values: readonly (string | undefined)[]) => {
    ["TMUX", "TMUX_PANE"].forEach((key, index) => {
      const value = values[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  };
  try {
    setEnv(options.env ?? [tmux, pane]);
    install({
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      exec: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return options.exec?.(args) ?? { code: 0 };
      },
    } as unknown as Parameters<typeof install>[0]);
  } finally {
    setEnv(previous);
  }
  const emit = async (name: string, event: object = {}) =>
    handlers.get(name)?.(event, { mode: options.mode ?? "tui" });
  return { calls, emit };
}

test("only publishes from a started interactive session with a tmux socket and pane ID", async () => {
  for (const opts of [
    { mode: "print" }, { mode: "json" }, { mode: "rpc" },
    { env: [undefined, pane] as const }, { env: [tmux, undefined] as const },
    { env: ["not-a-tmux-socket", pane] as const }, { env: [tmux, "0:1.2"] as const },
  ]) {
    const { calls, emit } = harness(opts);
    await emit("session_start");
    await emit("agent_start");
    await emit("ui_prompt_start");
    await emit("agent_settled", { aborted: false });
    await emit("session_shutdown");
    expect(calls).toEqual([]);
  }
});

test("waits for final settlement across retries and continuations; abort takes precedence", async () => {
  const { calls, emit } = harness();
  await emit("agent_start"); // Ignore events before startup.
  await emit("session_start");
  await emit("agent_start");
  await emit("agent_end"); // Retry is still pending.
  await emit("agent_start");
  await emit("agent_before_settle", { outcome: "error" });
  await emit("agent_start"); // Another extension requested continuation.
  await emit("agent_before_settle", { outcome: "completed" });
  expect(calls).toEqual([write("idle"), write("working")]);
  await emit("agent_settled", { aborted: false });
  await emit("agent_start");
  await emit("agent_before_settle", { outcome: "error" });
  await emit("agent_settled", { aborted: true });
  await emit("agent_start");
  await emit("agent_before_settle", { outcome: "error" });
  await emit("agent_settled", { aborted: false });
  expect(calls).toEqual([
    write("idle"), write("working"), write("done"), write("working"), write("idle"), write("working"), write("error"),
  ]);
});

test("a coalesced UI span masks the run state; closing restores the current state", async () => {
  const { calls, emit } = harness();
  const prompt = { get title(): string { throw new Error("must not read title"); } };
  await emit("session_start");
  await emit("ui_prompt_start", prompt);
  await emit("ui_prompt_end", prompt);
  await emit("agent_start");
  // Pi emits only the outer start/end for nested or overlapping dialogs.
  await emit("ui_prompt_start", prompt);
  await emit("ui_prompt_end", prompt);
  await emit("ui_prompt_start", prompt);
  await emit("agent_settled", { aborted: false });
  expect(calls).toEqual([
    write("idle"), write("blocked"), write("idle"), write("working"), write("blocked"), write("working"), write("blocked"),
  ]);
  await emit("ui_prompt_end", prompt);
  expect(calls.at(-1)).toEqual(write("done"));
});

test("serializes fast writes and owner-checked cleanup, ignoring late events", async () => {
  const first = Promise.withResolvers<{ code: number }>();
  const { calls, emit } = harness({ exec: async (args) => args.at(-1) === `${process.pid}:idle` ? first.promise : { code: 0 } });
  const pending = [
    emit("session_start"), emit("agent_start"), emit("ui_prompt_start"), emit("ui_prompt_end"),
    emit("session_shutdown", { reason: "reload" }), emit("agent_settled"), emit("session_shutdown"),
  ];
  await Promise.resolve();
  expect(calls).toEqual([write("idle")]);
  first.resolve({ code: 0 });
  await Promise.all(pending);
  expect(calls).toEqual([write("idle"), write("working"), write("blocked"), write("working"), cleanup]);
  await emit("session_start", { reason: "reload" });
  expect(calls.at(-1)).toEqual(write("idle"));
});

test("exec rejection and a nonzero exit do not poison the publish queue", async () => {
  let attempt = 0;
  const { calls, emit } = harness({ exec: async () => {
    if (++attempt === 1) throw new Error("tmux unavailable");
    return { code: attempt === 2 ? 1 : 0 };
  } });
  await emit("session_start");
  await emit("agent_start");
  await emit("agent_start");
  await emit("agent_start");
  await emit("session_shutdown");
  expect(calls).toEqual([write("idle"), write("working"), write("working"), cleanup]);
});
