# TMCode shell integration (bash), started with --init-file: the user's startup
# files first (as a login shell when TMCode asked for one), then the hooks that
# mark prompts and commands (OSC 633, as VS Code's terminal reads them).
if [ -n "$TMCODE_SHELL_LOGIN" ]; then
  unset TMCODE_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then . ~/.bash_login
  elif [ -r ~/.profile ]; then . ~/.profile
  fi
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi

if [[ $- == *i* && -z $__tm_loaded ]]; then
  __tm_loaded=1
  __tm_status=0
  __tm_ran=0
  __tm_in_prompt=0
  __tm_branch=""

  __tm_esc() {
    local s=${1//\\/\\\\}
    s=${s//;/\\x3b}
    s=${s//$'\n'/\\x0a}
    s=${s//$'\r'/\\x0d}
    s=${s//$'\e'/\\x1b}
    s=${s//$'\a'/\\x07}
    builtin printf '%s' "$s"
  }

  __tm_precmd() {
    __tm_status=$?
    __tm_in_prompt=0
    if [ "$__tm_ran" = 1 ]; then
      builtin printf '\e]633;D;%s\a' "$__tm_status"
      __tm_ran=0
    fi
    builtin printf '\e]633;P;Cwd=%s\a' "$(__tm_esc "$PWD")"
    if [ -n "$__tm_prompt" ]; then
      __tm_branch=$(command git symbolic-ref --short -q HEAD 2>/dev/null || command git rev-parse --short -q HEAD 2>/dev/null)
    fi
    return $__tm_status
  }

  # Last in PROMPT_COMMAND: prompt tools (starship…) may have rebuilt PS1.
  __tm_mark_prompt() {
    if [[ $PS1 != *'633;A'* ]]; then
      PS1='\[\e]633;A\a\]'"$PS1"'\[\e]633;B\a\]'
    fi
    __tm_in_prompt=1
  }

  __tm_preexec() {
    [ "$__tm_in_prompt" = 1 ] || return
    case "$BASH_COMMAND" in __tm_*) return ;; esac
    __tm_in_prompt=0
    __tm_ran=1
    local line
    line=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $line =~ ^[[:space:]]*[0-9]+[*[:space:]]+(.*)$ ]]; then line=${BASH_REMATCH[1]}; else line=$BASH_COMMAND; fi
    builtin printf '\e]633;E;%s\a' "$(__tm_esc "$line")"
    builtin printf '\e]633;C\a'
  }

  __tm_ps1_git() { [ -n "$__tm_branch" ] && builtin printf ' \001\e[35m\002(%s)\001\e[0m\002' "$__tm_branch"; }
  __tm_ps1_fail() { [ "$__tm_status" != 0 ] && builtin printf ' \001\e[31m\002✗\001\e[0m\002'; }

  case "$PS1" in
    *'\e['* | *'\033['* | *$'\e['*) __tm_coloured=1 ;;
    *) __tm_coloured= ;;
  esac
  if [ "$TMCODE_PROMPT" = on ] || { [ "$TMCODE_PROMPT" = auto ] && [ -z "$__tm_coloured" ]; }; then
    __tm_prompt=1
    PS1='\[\e[32m\]\u@\h\[\e[0m\] \[\e[34m\]\W\[\e[0m\]$(__tm_ps1_git)$(__tm_ps1_fail) \$ '
  fi
  unset TMCODE_PROMPT __tm_coloured

  PROMPT_COMMAND="__tm_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __tm_mark_prompt"
  # A DEBUG trap the user already has (bash-preexec…) is kept: prompts are still marked.
  if [ -z "$(trap -p DEBUG)" ]; then
    trap '__tm_preexec' DEBUG
  fi
fi
