# TMCode shell integration (zsh): the user's .zshrc, then the hooks that mark
# prompts and commands (OSC 633, as VS Code's terminal reads them). ZDOTDIR
# goes back to the user's, so .zlogin and nested shells read their own files.
ZDOTDIR=$TMCODE_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
unset TMCODE_USER_ZDOTDIR TMCODE_ZDOTDIR

if [[ -o interactive && -z $__tm_loaded ]]; then
  typeset -g __tm_loaded=1 __tm_status=0 __tm_ran=0 __tm_branch="" __tm_git_part="" __tm_fail_part=""

  # 633 text: backslash, ";" and control characters escaped as \xNN.
  __tm_esc() {
    local s=${1//\\/\\\\}
    s=${s//;/\\x3b}
    s=${s//$'\n'/\\x0a}
    s=${s//$'\r'/\\x0d}
    s=${s//$'\e'/\\x1b}
    s=${s//$'\a'/\\x07}
    builtin print -rn -- "$s"
  }

  __tm_capture() { __tm_status=$? }

  __tm_precmd() {
    if (( __tm_ran )); then
      builtin printf '\e]633;D;%s\a' "$__tm_status"
      __tm_ran=0
    fi
    builtin printf '\e]633;P;Cwd=%s\a' "$(__tm_esc "$PWD")"
    if [[ -n $__tm_prompt ]]; then
      __tm_branch=$(command git symbolic-ref --short -q HEAD 2>/dev/null || command git rev-parse --short -q HEAD 2>/dev/null)
      __tm_git_part=${__tm_branch:+" %F{magenta}($__tm_branch)%f"}
      __tm_fail_part=""
      [[ $__tm_status != 0 ]] && __tm_fail_part=" %F{red}✗%f"
    fi
    # Themes may rebuild PS1 in their own precmd (this one runs last): mark it again.
    if [[ $PS1 != *'633;A'* ]]; then
      PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'
    fi
  }

  __tm_preexec() {
    __tm_ran=1
    builtin printf '\e]633;E;%s\a' "$(__tm_esc "$1")"
    builtin printf '\e]633;C\a'
  }

  # TMCode's coloured prompt: forced on, or "auto" while the prompt has no colours of its own.
  if [[ $TMCODE_PROMPT == on || ( $TMCODE_PROMPT == auto && $PS1 != *'%F'* && $PS1 != *'%K'* && $PS1 != *$'\e['* ) ]]; then
    typeset -g __tm_prompt=1
    setopt prompt_subst
    # prompt_subst expands the parts set in precmd; "%" inside them still works as prompt escapes.
    PS1='%F{green}%n@%m%f %F{blue}%1~%f${__tm_git_part}${__tm_fail_part} %# '
  fi
  unset TMCODE_PROMPT

  autoload -Uz add-zsh-hook
  # First: the command's status before any other precmd changes $?.
  precmd_functions=(__tm_capture $precmd_functions __tm_precmd)
  add-zsh-hook preexec __tm_preexec
fi
