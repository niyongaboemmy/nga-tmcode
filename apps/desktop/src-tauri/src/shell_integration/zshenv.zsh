# TMCode shell integration (zsh): TMCode points ZDOTDIR here so these files run
# first; each one runs the user's own file of the same name from their ZDOTDIR.
if [[ -f $TMCODE_USER_ZDOTDIR/.zshenv ]]; then
  TMCODE_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$TMCODE_USER_ZDOTDIR
  if [[ $TMCODE_USER_ZDOTDIR != $TMCODE_ZDOTDIR ]]; then
    . $TMCODE_USER_ZDOTDIR/.zshenv
  fi
  # The user's .zshenv may move ZDOTDIR: their other files live there.
  TMCODE_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$TMCODE_ZDOTDIR
fi
