#!/usr/bin/env python3
"""Opt-in native smoke: python3 scripts/pi-tmux-smoke.py

Run on macOS/Linux with hc 0.1.21, Pi 1.5.2 and tmux on PATH (plus the
Node runtime if Pi needs it). No install, desktop, or provider needed.
"""

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


PROMPT = """export default function (pi) {
  pi.registerCommand("smoke-prompt", {
    handler: async (args, ctx) => {
      if (args === "confirm") await ctx.ui.confirm("Smoke confirm", "Continue?");
      if (args === "select") await ctx.ui.select("Smoke select", ["Continue"]);
    },
  });
}
"""


def until(description, read, accepts):
    deadline = time.monotonic() + 10
    while True:
        value = read()
        if accepts(value):
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f"{description}: timed out; last observation: {value!r}")
        time.sleep(0.1)


def smoke(root, bins, integration):
    home, work, agent, tmp = (root / name for name in ("home", "work", "pi", "tmp"))
    for directory in (home, work, agent, tmp):
        directory.mkdir()
    env = {
        # Keep executable discovery only; don't pass auth, tmux, or hc env through.
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "SHELL": "/bin/sh",
        "TERM": "xterm-256color",
        "TMPDIR": str(tmp),
        "HC_SESSION": root.name,
        "HC_SOCKET": str(root / "hc.sock"),
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_OFFLINE": "1",
    }
    for key in ("CONFIG_HOME", "DATA_HOME", "STATE_HOME", "CACHE_HOME", "RUNTIME_DIR"):
        directory = root / key.lower()
        directory.mkdir(mode=0o700)
        env[f"XDG_{key}"] = str(directory)
    env["XDG_CONFIG_DIRS"] = env["XDG_CONFIG_HOME"]
    env["XDG_DATA_DIRS"] = env["XDG_DATA_HOME"]
    for name in ("settings", "auth", "models"):
        (agent / f"{name}.json").write_text("{}\n")
    prompt = work / "prompt.ts"
    prompt.write_text(PROMPT)
    socket = str(root / "tmux.sock")
    session = "smoke"

    def run(*argv, check=True):
        result = subprocess.run(argv, env=env, cwd=work, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10)
        if check and result.returncode:
            raise RuntimeError(f"{shlex.join(argv)}: exit {result.returncode}\n"
                               f"{result.stdout}{result.stderr}")
        return result.stdout.strip()

    def hc(*args, **kwargs):
        return run(bins["hc"], *args, **kwargs)

    def tmux(*args, **kwargs):
        return run(bins["tmux"], "-f", "/dev/null", "-S", socket, *args, **kwargs)

    def get(name):
        return json.loads(hc("get", "--json", name))

    def attach(name):
        hc("run", "--json", "--bg", "--no-parent", "--name", name, "--",
           str(integration / "herdr-tmux"), "-S", socket, session)
        until("one attached tmux client", clients, lambda value: len(value.splitlines()) == 1)

    def clients():
        return tmux("list-clients", "-t", session, "-F", "#{client_name}")

    def option():
        return tmux("show-options", "-pqv", "-t", pane, "@herdr_pi")

    def screen():
        return tmux("capture-pane", "-p", "-t", pane)

    def window(index):
        until(f"active tmux window {index}",
              lambda: tmux("display-message", "-p", "-t", session, "#{window_index}"),
              lambda active: active == index)

    def observe(name, step, status):
        expected = {"app": "pi", "state": status, "msg": "tmux window 0, pane 0"} if status else None
        state = until(f"{step}: hc status {status!r}", lambda: get(name),
                      lambda value: value["state"] == "live" and value["status"] == expected)
        print(f"{step}: {state['address']} status={state['status']}", flush=True)

    versions = (hc("--version"), run(bins["pi"], "--version"), tmux("-V"))
    if versions[:2] != ("hc 0.1.21", "1.5.2"):
        raise RuntimeError(f"expected hc 0.1.21 / Pi 1.5.2, got {versions[:2]}")
    print(f"{versions[0]}, Pi {versions[1]}, {versions[2]}", flush=True)

    try:
        pane = tmux("new-session", "-d", "-s", session, "-n", "pi", "-x", "100", "-y", "32",
                    "-P", "-F", "#{pane_id}", "/bin/sh", "-i")
        tmux("new-window", "-d", "-t", f"{session}:1", "-n", "quiet", "/bin/sh", "-i")
        pi = shlex.join([bins["pi"], "--offline", "--no-session", "--no-extensions",
                         "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
                         "--no-tools", "-e", str(integration / "herdr-status.ts"), "-e", str(prompt)])
        tmux("send-keys", "-t", pane, "-l", pi)
        tmux("send-keys", "-t", pane, "Enter")
        idle = until("Pi published pane idle", option, lambda value: re.fullmatch(r"[1-9]\d*:idle", value))
        pid = idle.split(":")[0]
        blocked = f"{pid}:blocked"

        hc("server", "start")
        attach("first")
        window("0")
        observe("first", "Pi idle", "idle")

        def start_prompt(title):
            tmux("send-keys", "-t", pane, "-l", f"/smoke-prompt {title}")
            tmux("send-keys", "-t", pane, "Enter")
            until(f"visible {title} prompt", screen, lambda text: f"Smoke {title}" in text)
            until(f"{title} pane blocked", option, lambda value: value == blocked)

        start_prompt("confirm")
        observe("first", "confirm open", "blocked")
        hc("keys", "first", "ctrl+b", "1")
        window("1")
        observe("first", "quiet window active, confirm still open", "blocked")
        # Answer Pi in the background window; the attached client stays on quiet.
        tmux("send-keys", "-t", pane, "Enter")
        observe("first", "confirm answered in background window", "idle")
        window("1")
        hc("keys", "first", "ctrl+b", "0")
        window("0")

        start_prompt("select")
        observe("first", "select open", "blocked")
        hc("keys", "first", "ctrl+b", "d")
        until("tmux client detached", clients, lambda value: value == "")
        detached = until("wrapper finished and cleared", lambda: get("first"),
                         lambda value: value["state"] == "finished" and value["exit_code"] == 0
                         and value["status"] is None)
        if option() != blocked or "Smoke select" not in screen():
            raise RuntimeError("detach lost the original Pi process or pending select")
        print(f"detached: {detached['address']} exit={detached['exit_code']} "
              f"status={detached['status']}; Pi {pid} still blocked", flush=True)

        attach("second")
        window("0")
        observe("second", "reattached to same select", "blocked")
        hc("keys", "second", "enter")
        observe("second", "select answered", "idle")
        until("original Pi returned to idle", option, lambda value: value == idle)
        hc("keys", "second", "ctrl+d")
        until("Pi shutdown removed its pane option", option, lambda value: value == "")
        observe("second", "Pi exited, wrapper still attached", None)
    finally:
        # Every cleanup command targets only this run's private sockets.
        tmux("kill-server", check=False)
        if (root / "hc.sock").exists():
            hc("server", "stop")


def main():
    integration = Path(__file__).resolve().parents[1] / "integrations" / "pi-tmux"
    for name in ("herdr-status.ts", "herdr-tmux"):
        if not (integration / name).is_file():
            raise RuntimeError(f"missing integration: {integration / name}")
    bins = {}
    for name in ("hc", "pi", "tmux"):
        found = shutil.which(name)
        if not found:
            raise RuntimeError(f"{name} is not on PATH")
        bins[name] = os.path.abspath(found)
    # Short socket paths fit sockaddr_un on macOS as well as Linux.
    with tempfile.TemporaryDirectory(prefix="pi-tmux-smoke-", dir="/tmp") as directory:
        smoke(Path(directory), bins, integration)
    print("PASS: native Pi/tmux smoke")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(f"FAIL: {error}")
