# agent-remote shell integration.
# We point ZDOTDIR at this directory so our .zshrc runs and can install hooks.
# zsh therefore looks for .zshenv here too, so load the user's real one.
if [[ -f "${USER_ZDOTDIR:-$HOME}/.zshenv" ]]; then
  source "${USER_ZDOTDIR:-$HOME}/.zshenv"
fi
