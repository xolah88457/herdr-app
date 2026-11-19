# Source from an interactive Bash or Zsh startup file, with herdr-tmux on PATH.
# Only intercept top-level Herdr shells. Pi's subprocesses still use real tmux.
if [ -n "${HC_TERMINAL_ID:-}" ] && [ -n "${HC_TERMINAL_SOCKET:-}" ] &&
   [ -z "${TMUX:-}" ] && command -v herdr-tmux >/dev/null 2>&1; then
    tmux() { command herdr-tmux --client "$@"; }
fi
