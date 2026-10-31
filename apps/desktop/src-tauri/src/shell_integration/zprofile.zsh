# TMCode shell integration (zsh): the user's .zprofile.
if [[ -o login ]]; then
  TMCODE_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$TMCODE_USER_ZDOTDIR
  [[ -f $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
  TMCODE_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$TMCODE_ZDOTDIR
fi
