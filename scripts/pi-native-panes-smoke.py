#!/usr/bin/env python3
"""Opt-in macOS smoke: pi-native-panes-smoke.py SOURCE_PACKAGE_ROOT --herdr-app STANDALONE_BINARY.

Requires a logged-in macOS desktop, Herdr, hc, Pi, and a compatible source package. Opens its own window; never sends desktop input.
"""

import argparse
import contextlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CHILD = "native-smoke-child"
TASK = "native-smoke-child-task"
SUMMARY = "native-smoke-child-summary"
PROMPT = "native-smoke-parent-launch"
MODEL = "native-smoke/stub"


@contextlib.contextmanager
def stub_provider():
    child_started = threading.Event()
    release_child = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/v1/chat/completions" or request.get("model") != "stub":
                self.send_error(400, "unexpected model or route")
                return
            messages = request["messages"]
            rendered = json.dumps(messages)
            if TASK in rendered and PROMPT not in rendered:
                child_started.set()
                if not release_child.wait(45):
                    self.send_error(504, "smoke never observed the child pane")
                    return
                if any(m.get("role") == "tool" for m in messages):
                    delta, reason = {"content": SUMMARY}, "stop"
                else:
                    delta, reason = {"tool_calls": [{
                        "index": 0, "id": "call_write", "type": "function", "function": {
                            "name": "write", "arguments": json.dumps({"path": "worker-proof.txt", "content": SUMMARY}),
                        },
                    }]}, "tool_calls"
            elif PROMPT in rendered and not any(m.get("tool_calls") for m in messages):
                delta, reason = {"tool_calls": [{
                    "index": 0, "id": "call_smoke", "type": "function", "function": {
                        "name": "subagent", "arguments": json.dumps({
                            "agent": "native-smoke", "name": CHILD, "task": TASK,
                        }),
                    },
                }]}, "tool_calls"
            else:
                delta, reason = {"content": "native-smoke-parent-ready"}, "stop"
            def chunk(delta, finish):
                return "data: " + json.dumps({
                    "id": "smoke", "object": "chat.completion.chunk", "created": 1,
                    "model": "stub", "choices": [{"index": 0, "delta": delta,
                                                  "finish_reason": finish}],
                }) + "\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write((chunk({"role": "assistant", **delta}, None)
                              + chunk({}, reason) + "data: [DONE]\n\n").encode())

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/v1", child_started, release_child
        finally:
            release_child.set()
            server.shutdown()
            thread.join()


def await_value(description, read, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f"timed out: {description}")
        time.sleep(0.1)


def smoke(root, args, provider):
    integration = Path(__file__).resolve().parents[1] / "integrations/pi-native-panes"
    home, work, app_home, agent, package, wrappers, tmp = (
        root / name for name in ("home", "work", "app", "pi", "copy", "bin", "tmp"))
    for directory in (home, work, app_home, agent, wrappers, tmp):
        directory.mkdir()

    # Pass no live credentials, HC environment, tmux environment, or Pi settings.
    env = {
        "PATH": f"{wrappers}:{os.environ.get('PATH', os.defpath)}",
        "HOME": str(home), "SHELL": "/bin/sh", "TERM": "xterm-256color",
        "TMPDIR": str(tmp), "HC_SESSION": root.name, "HC_SOCKET": str(root / "hc.sock"),
        "HERDR_APP_HOME": str(app_home), "HERDR_TELEMETRY": "0",
        "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1",
    }
    for name in ("CONFIG_HOME", "DATA_HOME", "STATE_HOME", "CACHE_HOME", "RUNTIME_DIR"):
        directory = root / name.lower()
        directory.mkdir(mode=0o700)
        env[f"XDG_{name}"] = str(directory)
    env["XDG_CONFIG_DIRS"] = env["XDG_CONFIG_HOME"]
    env["XDG_DATA_DIRS"] = env["XDG_DATA_HOME"]
    core_config = Path(env["XDG_CONFIG_HOME"]) / "herdr-core"
    core_config.mkdir()
    (core_config / "config.toml").write_text("notes = false\ndraft_wait = 0\n")
    (agent / "settings.json").write_text(json.dumps({
        "defaultProvider": "native-smoke", "defaultModel": "stub", "mcp": {"enabled": False},
    }))
    (agent / "auth.json").write_text("{}\n")
    (agent / "models.json").write_text(json.dumps({"providers": {"native-smoke": {
        "baseUrl": provider[0], "api": "openai-completions", "apiKey": "loopback-only",
        "models": [{"id": "stub"}],
    }}}))

    def run(*argv, check=True):
        result = subprocess.run(argv, env=env, cwd=work, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=20)
        if check and result.returncode:
            raise RuntimeError(f"{shlex.join(map(str, argv))}: exit {result.returncode}\n"
                               f"{result.stdout}{result.stderr}")
        return result.stdout.strip()

    def hc(*argv, **kwargs):
        return run(wrappers / "hc", *argv, **kwargs)

    def app(*argv):
        answer = json.loads(run(app_bin, *argv))
        if "error" in answer:
            raise RuntimeError(f"Herdr {argv}: {answer['error']}")
        return answer

    def places():
        return {terminal["terminal"]: (space, tab, terminal)
                for space in app("ls")["spaces"] for tab in space["tabs"]
                for terminal in tab["terminals"]}

    def new_child(baseline):
        current = places()
        new = current.keys() - baseline
        if len(new) > 1:
            raise RuntimeError(f"expected one child pane, got {new}")
        return current[next(iter(new))] if new else None

    def open_tab(name, *argv):
        app("do", "terminal.open", json.dumps({"name": name, "folder": str(work), "argv": argv}))
        return await_value(f"tab {name}", lambda: next(
            ((space, tab, tab["terminals"][0]) for space in app("ls")["spaces"]
             for tab in space["tabs"] if tab["name"] == name and len(tab["terminals"]) == 1), None))

    for name, executable in (("hc", args.hc), ("pi", args.pi)):
        found = shutil.which(executable)
        if not found:
            raise RuntimeError(f"not executable: {executable}")
        (wrappers / name).symlink_to(Path(found).absolute())
    app_bin = shutil.which(args.herdr_app)
    if not app_bin:
        raise RuntimeError(f"not executable: {args.herdr_app}")
    app_bin = Path(app_bin).resolve()
    if any(part.endswith(".app") for part in app_bin.parts):
        raise ValueError("Pass an unbundled build via --herdr-app; do not copy a signed .app executable out of its bundle.")
    # Launch a disposable unbundled executable so no install/update action can target
    # an installed .app. Point the release resolver at an empty offline directory.
    app_bin = Path(shutil.copy2(app_bin, wrappers / "herdr-app"))
    env["HERDR_RELEASES_URL"] = (root / "no-releases").as_uri()
    print(f"{run(app_bin, '--version')}, {hc('--version')}, Pi {run(wrappers / 'pi', '--version')}",
          flush=True)
    run(integration / "prepare-copy", args.source.resolve(), package)
    (agent / "agents").mkdir()
    (agent / "agents/native-smoke.md").write_text(
        "---\nname: native-smoke\ndescription: Loopback fixture\nmodel: native-smoke/stub\n"
        "auto-exit: true\nskills: none\nsession-mode: standalone\n---\nSmoke fixture only.\n")

    parent_session, app_log = root / "parent.jsonl", root / "app.log"
    process = None
    parent_address = child_address = None
    try:
        hc("server", "start")
        if not (root / "hc.sock").is_socket():
            raise RuntimeError("hc did not create the private core socket")
        with app_log.open("w") as log:
            process = subprocess.Popen([app_bin], env=env, cwd=work, stdout=log, stderr=log)
        def control_ready():
            if process.poll() is not None:
                raise RuntimeError(f"Herdr exited with {process.returncode}")
            return (app_home / "herdr-app.sock").is_socket()
        await_value("private Herdr control socket", control_ready)
        await_value("Herdr initial layout", lambda: app("ls"))
        app("do", "space.new", json.dumps({"name": "Smoke", "folder": str(work)}))
        parent_space, parent_tab, parent = open_tab(
            "smoke-parent", str(integration / "pi-native"), str(package),
            "--session", str(parent_session), "--model", MODEL, "--thinking", "off",
            "--no-approve", "--no-mcp", "--no-skills", "--no-context-files", "--no-builtin-tools",
        )
        parent_address = parent["terminal"]
        _, decoy_tab, _ = open_tab("smoke-decoy", "/bin/sh", "-i")
        await_value("decoy selected", lambda: app("status")["tab"] == decoy_tab["id"])
        await_value("parent Pi ready", lambda: "stub" in hc("read", parent_address))
        baseline = set(places())
        hc("send", parent_address, PROMPT)

        if not provider[1].wait(20):
            raise RuntimeError("real child Pi did not reach the loopback model")
        # The child remains blocked in the loopback provider until its live pane is observed.
        child_space, child_tab, child = await_value("live child pane", lambda: new_child(baseline))
        child_address = child["terminal"]
        child_record = json.loads(hc("get", "--json", child_address))
        if ((child_space["id"], child_tab["id"]) != (parent_space["id"], parent_tab["id"])
                or child_address == parent_address or child["pane"] == parent["pane"]
                or child_record["state"] != "live"):
            raise RuntimeError(f"wrong child terminal or placement: {child}, {child_record}")
        print(f"parent {parent_address} pane={parent['pane']}; child {child_address} "
              f"pane={child['pane']}; same tab={parent_tab['id']} (decoy={decoy_tab['id']})", flush=True)
        provider[2].set()

        def delivered():
            if not parent_session.exists():
                return None
            text = parent_session.read_text()
            for line in text.splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # The last JSONL entry may still be being written.
                if entry.get("customType") == "subagent_result" and SUMMARY in line:
                    return entry
            return None

        result = await_value("copied extension delivered child's summary to parent session", delivered)
        if (work / "worker-proof.txt").read_text() != SUMMARY:
            raise RuntimeError("native worker did not write the expected file in the target directory")
        details = result["details"]
        if details["name"] != CHILD or details["exitCode"] != 0:
            raise RuntimeError(f"unexpected completion: {result}")
        def pane_cleaned():
            current = places()
            return child_address not in current and current.get(parent_address, ({}, {}, {}))[2].get("pane") == parent["pane"]

        await_value("child pane removed; parent pane intact", pane_cleaned)
        def no_live_child():
            record = hc("get", "--json", child_address, check=False)
            return not record or json.loads(record).get("state") == "finished"
        await_value("child core terminal no longer live", no_live_child)
        print(f"parent received {SUMMARY!r}, exit=0; child pane and live terminal cleaned", flush=True)
    except Exception:
        if app_log.exists():
            print(f"Herdr log:\n{app_log.read_text()[-4000:]}", file=sys.stderr)
        if (root / "hc.sock").is_socket():
            print(f"Private hc terminals:\n{hc('ls', '--all', '--json', check=False)}", file=sys.stderr)
            for address in filter(None, (parent_address, child_address)):
                print(f"{address}:\n{hc('read', address, check=False)[-6000:]}", file=sys.stderr)
        raise
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if (root / "hc.sock").is_socket():
            hc("server", "stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source package passed to prepare-copy")
    parser.add_argument("--herdr-app", required=True, help="standalone Herdr executable, not an installed app bundle")
    parser.add_argument("--hc", default="hc")
    parser.add_argument("--pi", default="pi")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("requires macOS with a logged-in desktop")
    with tempfile.TemporaryDirectory(prefix="pi-native-", dir="/tmp") as directory, stub_provider() as provider:
        smoke(Path(directory), args, provider)
    print("PASS: native Herdr/hc/Pi subagent smoke")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(f"FAIL: {error}")
