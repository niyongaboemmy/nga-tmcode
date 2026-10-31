# TMCode shell integration (fish), loaded from vendor_conf.d through
# XDG_DATA_DIRS: marks prompts and commands (OSC 633, as VS Code's terminal reads them).
if set -q TMCODE_FISH_XDG_DATA_DIRS
    set -gx XDG_DATA_DIRS $TMCODE_FISH_XDG_DATA_DIRS
    test -z "$TMCODE_FISH_XDG_DATA_DIRS"; and set -e XDG_DATA_DIRS
    set -e TMCODE_FISH_XDG_DATA_DIRS
end
status is-interactive; or return
set -q __tm_loaded; and return
set -g __tm_loaded 1
set -e TMCODE_PROMPT

function __tm_esc
    string replace -a -- '\\' '\\\\' "$argv" | string replace -a -- ';' '\\x3b' | string replace -a -- \n '\\x0a' | string replace -a -- \e '\\x1b' | string replace -a -- \a '\\x07'
end

function __tm_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a' (__tm_esc "$argv")
    printf '\e]633;C\a'
end

function __tm_postexec --on-event fish_postexec
    printf '\e]633;D;%s\a' $status
end

function __tm_prompt_start --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' (__tm_esc "$PWD")
    printf '\e]633;A\a'
    # config.fish runs after vendor_conf.d: wrap the prompt the user ended up with.
    if not functions -q __tm_user_prompt
        functions -c fish_prompt __tm_user_prompt
        function fish_prompt
            __tm_user_prompt
            printf '\e]633;B\a'
        end
    end
end
