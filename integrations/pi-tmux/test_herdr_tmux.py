import base64
import errno
import fcntl
import os
import pty
import re
import runpy
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest
from pathlib import Path
from unittest.mock import patch

HELPER = str(Path(__file__).with_name("herdr-tmux").resolve())
helper = runpy.run_path(HELPER)
MONITOR = helper["Monitor"]
OSC = re.compile(rb"\x1b\]7501;state=([a-z]+):app=pi(?::msg=([A-Za-z0-9+/=]+))?\x1b\\")


class ManualLaunchTest(unittest.TestCase):
    def test_only_foreground_interactive_forms_are_wrapped(self):
        for args in ([], ['new', '-s', 'test'], ['new-session', '-As', 'test'], ['attach', '-t', 'test']):
            self.assertTrue(helper['interactive_launch'](args), args)
        for args in (['new', '-d', '-s', 'test'], ['list-panes'], ['new-window'], ['-L', 'private', 'attach'], ['-C'], ['new', ';', 'detach']):
            self.assertFalse(helper['interactive_launch'](args), args)


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.monitor = MONITOR(["tmux"], os.environ)
        self.clients = [b"C|10|$1|/dev/pts/9", b"C|42|$0|/dev/pts/8"]
        self.pane = b"P|$0|@7|3|2|%9|/dev/pts/6|0"
        self.options = [self.pane, b"@herdr_pi 123:done", *self.clients]
        self.procs = [b"123 S pts/6 original birth"]

    def sample(self):
        responses = iter([self.clients, [self.pane], self.options, self.procs])
        return self.monitor.read(42, lambda _args, **_kwargs: next(responses))

    def test_live_publisher_then_zombie_and_reused_pid_on_same_tty(self):
        self.assertEqual(self.sample(), (b"done", 3, 2))
        self.procs = [b"123 Z+ pts/6 original birth"]
        self.assertIsNone(self.sample())
        self.procs = [b"123 S pts/6 later birth"]
        self.assertIsNone(self.sample())

    def test_live_pid_on_wrong_tty_is_ignored(self):
        self.procs = [b"123 S pts/7 original birth"]
        self.assertIsNone(self.sample())

    def test_discard_batch_if_client_switched_or_disappeared(self):
        for client_rows in ([b"C|42|$1|/dev/pts/8"], [b"C|10|$0|/dev/pts/9"]):
            self.options = [self.pane, b"@herdr_pi 123:working", *client_rows]
            self.assertIsNone(self.sample())

    def test_query_errors_and_timeouts_return_clear(self):
        errors = [subprocess.CalledProcessError(1, "tmux"), subprocess.TimeoutExpired("tmux", 0.45)]
        for error in errors:
            with self.subTest(error=error), patch("subprocess.run", side_effect=error):
                self.assertIsNone(self.monitor.sample(42))


@unittest.skipUnless(shutil.which("tmux"), "requires tmux")
class AttachTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="herdr-tmux-", dir="/tmp")
        self.addCleanup(directory.cleanup)
        self.socket = os.path.join(directory.name, "socket")
        self.env = dict(os.environ, TERM="xterm-256color", HOME=directory.name)
        self.env.pop("TMUX", None)
        self.env.pop("TMUX_PANE", None)
        self.addCleanup(self.tmux, "kill-server", check=False)

    def tmux(self, *args, check=True):
        result = subprocess.run(
            ["tmux", "-N", "-S", self.socket, *args], env=self.env,
            stdin=subprocess.DEVNULL, capture_output=True, check=check, timeout=4,
        )
        return result.stdout.decode().strip()

    def start_server(self):
        # Only fixtures can start a server or kill it; always at a private socket.
        subprocess.run(
            ["tmux", "-S", self.socket, "-f", "/dev/null", "new-session", "-d", "-s", "first", "exec sleep 60"],
            env=self.env, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=4,
        )

    def start_pty(self, argv, **extra_env):
        pid, fd = pty.fork()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
                # The forked PTY child runs the fixture's explicit argv without a shell.
                os.execvpe(argv[0], argv, dict(self.env, **extra_env))  # noqa: S606
            finally:
                os._exit(127)
        # Cleanups run in reverse: release the PTY before waiting on its child.
        self.addCleanup(self.reap, pid)
        self.addCleanup(os.close, fd)
        return pid, fd

    @staticmethod
    def reap(pid):
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ChildProcessError, ProcessLookupError):
            pass

    def collect(self, fd, expected=None):
        deadline = time.monotonic() + 4
        output = b""
        seen = []
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            try:
                chunk = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                chunk = b""  # Linux reports EOF on PTY master as EIO.
            if not chunk:
                if expected is None:
                    return seen
                break
            output += chunk
            reports = list(OSC.finditer(output))
            if reports:
                output = output[reports[-1].end():]
                seen.extend(
                    (state.decode(), base64.b64decode(msg).decode() if msg else None)
                    for state, msg in (match.groups() for match in reports)
                )
                if expected is not None and expected in seen:
                    return seen
        self.fail(f"PTY expected {expected!r}, saw {seen!r}; remaining bytes: {output[-500:]!r}")

    def set_state(self, pane, state, pid_target=None):
        pid = self.tmux("display-message", "-p", "-t", pid_target or pane, "#{pane_pid}")
        self.tmux("set-option", "-p", "-t", pane, "@herdr_pi", f"{pid}:{state}")
        return pid

    def test_real_attachment_tracks_only_own_client_and_background_panes(self):
        self.start_server()
        self.tmux("new-window", "-d", "-t", "first:10", "exec sleep 60")
        self.tmux("new-session", "-d", "-s", "second", "exec sleep 60")
        first_pid = self.set_state("first:0.0", "done")
        self.set_state("first:10.0", "working")
        self.set_state("second:0.0", "error")
        self.tmux("set-option", "-g", "@herdr_pi", f"{first_pid}:error")
        self.tmux("set-option", "-gw", "@herdr_pi", f"{first_pid}:error")
        _, fd = self.start_pty(
            [HELPER, "-S", self.socket, "first"],
            TMUX="/wrong/socket,1,0", TMUX_PANE="%999999", HC="/not/a/command",
        )
        self.assertEqual(self.collect(fd, ("working", "tmux window 10, pane 0")),
                         [("working", "tmux window 10, pane 0")])
        client = self.tmux("list-clients", "-t", "first", "-F", "#{client_name}")
        _, other_fd = self.start_pty([HELPER, "-S", self.socket, "second"])
        self.collect(other_fd, ("error", "tmux window 0, pane 0"))

        self.set_state("first:0.0", "blocked")
        self.set_state("first:10.0", "error")
        self.collect(fd, ("blocked", "tmux window 0, pane 0"))  # numeric tiebreak

        # A live publisher on the wrong TTY must also be ignored.
        self.set_state("first:10.0", "error", pid_target="second:0.0")
        self.tmux("set-option", "-pu", "-t", "first:0.0", "@herdr_pi")
        self.collect(fd, ("clear", None))  # no fallback to any inherited option

        # Switch between discovery and the local-option batch. The server-side
        # guard must prevent reads of even a still-existing old session.
        actual_pid = int(self.tmux("list-clients", "-t", "first", "-F", "#{client_pid}"))

        def switch_during_sample(args, **_kwargs):
            if args[0] == "if-shell":
                self.tmux("switch-client", "-c", client, "-t", "second")
                self.assertEqual(self.tmux(*args), "")
                return []
            return self.tmux(*args).encode().split(b"\n")

        self.assertIsNone(MONITOR([], self.env).read(actual_pid, switch_during_sample))
        self.collect(fd, ("error", "tmux window 0, pane 0"))
        os.write(fd, b"\x02d")  # tmux's default prefix + detach, through the actual PTY
        self.assertIn(("clear", None), self.collect(fd))
        self.assertEqual(set(self.tmux("list-sessions", "-F", "#{session_name}").splitlines()),
                         {"first", "second"})

    def test_term_cleans_up_client_and_clears_status_without_killing_session(self):
        self.start_server()
        self.set_state("first:0.0", "idle")
        pid, fd = self.start_pty([HELPER, "-S", self.socket, "first"])
        self.collect(fd, ("idle", "tmux window 0, pane 0"))
        os.kill(pid, signal.SIGTERM)
        self.assertIn(("clear", None), self.collect(fd))
        self.assertEqual(self.tmux("list-clients"), "")
        self.assertEqual(self.tmux("list-sessions", "-F", "#{session_name}"), "first")

    def test_missing_server_does_not_start_one(self):
        Path(self.env["HOME"], ".tmux.conf").write_text("new-session -d -s unexpected\n")
        _, fd = self.start_pty([HELPER, "-S", self.socket, "unexpected"])
        self.assertIn(("clear", None), self.collect(fd))
        self.assertFalse(os.path.exists(self.socket))


if __name__ == "__main__":
    unittest.main()
