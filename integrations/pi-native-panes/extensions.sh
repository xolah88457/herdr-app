# Sourced (not run) by pi-native and orchestrator, with _hx_dir set to the prepared copy.
# Reads $_hx_dir/extensions: one extension path per line, blank lines and # comments ignored,
# a leading ~/ is $HOME, a relative path is relative to the copy. Exports the resolved list as
# HERDR_PI_EXTENSIONS (newline-separated) for worker commands, and puts `--extension PATH` for each
# in front of the positional parameters ("$@") of the sourcing script.
_hx_file=$_hx_dir/extensions
_hx_n=$#
_hx_list=
if [ -f "$_hx_file" ]; then
  while IFS= read -r _hx_line || [ -n "$_hx_line" ]; do
    _hx_line=${_hx_line%"$(printf '\r')"}
    while :; do case $_hx_line in ' '*|"$(printf '\t')"*) _hx_line=${_hx_line#?} ;; *) break ;; esac; done
    while :; do case $_hx_line in *' '|*"$(printf '\t')") _hx_line=${_hx_line%?} ;; *) break ;; esac; done
    case $_hx_line in ''|'#'*) continue ;; esac
    case $_hx_line in
      '~/'*) _hx_line=$HOME/${_hx_line#'~/'} ;;
      /*) ;;
      *) _hx_line=$_hx_dir/$_hx_line ;;
    esac
    [ -e "$_hx_line" ] || { echo "Extension listed in $_hx_file not found: $_hx_line" >&2; exit 2; }
    _hx_list=${_hx_list:+$_hx_list
}$_hx_line
    set -- "$@" --extension "$_hx_line"
  done < "$_hx_file"
  # Rotate the original arguments behind the extras.
  while [ "$_hx_n" -gt 0 ]; do _hx_a=$1; shift; set -- "$@" "$_hx_a"; _hx_n=$((_hx_n - 1)); done
fi
if [ -n "$_hx_list" ]; then export HERDR_PI_EXTENSIONS="$_hx_list"; else unset HERDR_PI_EXTENSIONS; fi
unset _hx_file _hx_n _hx_list _hx_line _hx_a
