#!/bin/sh

set -eu


# Generated from assets/installer-badge.png. Chunks stay within Kitty's
# 4096-byte direct-transmission limit.
INSTALLER_BADGE_PNG_1='iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAXNSR0IArs4c6QAAADhlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAABAKADAAQAAAABAAABAAAAAABEIjhzAAAldElEQVR4Ae1dCZhcVZU+te/dSWcla5NOSAgxISyy6eAAbgQXFmX4RBFx+URxGz91xnVkFFRwxCVuBMcRURh1BBFFkC2igoHAQDAhCXQ6kIUk3enu2tc551ZXkkm6qmt97933/svXVKWq3rvn/Pfd/957zrnnukpcCAUIAAFHIuB2pNZQGggAAYUACAAPAhBwMAIgAAc3PlQHAiAAPANAwMEIgAAc3PhQHQh4AYF1ESiUipTIZyhdzFGmwH+lAmX5tcif+91e9Rfw+Cjg8lLI66OQJ2BdZSCZJREAAZjQLMVikbYkd9PT8R20Ob6bnkvuoRfSgzRUSNFoIU3JQoZSxTxlucMT1e+l9ZCLgm4fhT1+irj91O0J0YzAJJofnEwLw9NpSfQoWt49l2LekAlao0orIuBCHEBnm+XF1BA9NLiJ1g1vo43c4bdxR9+Tj1OBiuNU7FKje4kJolQs8Xvu/jzaSykJEfBb9cod3eVSH5K8kffqj9zkdvO/3eVXdeER/3NR1BWgOcFuWsSk8LLoXDpt8gJ6Of95XJ4jfo0P7I0ACKDN7fvXwa30h30b6JGhrfQsj/JDxTTXcHAUl86dLxSpwH/FItOAvOfP1Hvp8W0sLiYDt4vJwOMmjyIFD7+6yOP1kscjnf1gfX4mj7mBHlrZNY/+sWcJvW7aMur2R9ooDW5lRQRAAC22iozwP9/5CN2z9xnakNhBqVLuwB2LhRJ39hzl8wXK5wrc0fPc0Q92ugM/NOGNTCA8njIReH0e8vJ7r5dJQb7g4i65aDYvH07v7qPzZ55A50w7rvwF/m8rBEAATTTnY/v7ac32h2jt8BbalR0+MI7KqJ7Lc4fP5vlVOvt40/wmKjToEun7Xp8QgZd8Ph//HTQRhdim8LLIbLpgxkq6dPZpFGQ7A4r+CIAA6mzDJ0e2043c6e8b/Dvtzo2qq2SdLh09l8tRNsvWec06/ESqlwnBR34/kwF7GTzesteY39HK2Dy6eOZJdMnsU5U3YqJ74XtrIgACqNEu8XyKvt1/H92662+0PTukfil7p3I8wmeyGdXxnbSVSpYMASYDf8DPy4cyGQRdPvqHScfQh+afTaf29NVAE19ZEQEQwDit8sC+jfSt/nvpz8PPUY7t9WJ9z+ay3Olz3PmzB6b841zqmI/EiBhgIgj42Xw4Rgbz2Ih48YyT6YO9Z1PEi5gEHR4GEMAhrfSjgbW0evv99Hxmn/pU1vSZdFp1fLtN7w9Ru+W3Yi8IMhn4fWwX4IlB0OWnVVOW0WcXvoHmhHtavj9u0DkEHE8ASY60u/65u+nmnX+hfYUke8ZcvJ7n6Lu0TPHzB6zinWsC+9xZXI6BoJ/JIFB2PTIbnN7VR59ZeB6dOKnXPoraSBPHEkCWXXJf2vwb+jF3/HgxowJvMpkspXjEx2jf6hPuYiLg0ORAkA2HEp9IdGKsl6455kJa2T2v1Zvj+jYi4DgCyHHwzde23kU3vvgnGuEgnRL76tM84qdS/N5JFr02PkRVb8UhD74AE0EoxF4Ej4otOKXraPrKkotoaWx21cvwhXEIOIoA1mx7kK7t/z3H3Ce5sxNP89Po+AY9az72HoSZCCTYyM1zgrMmLaFvHncJTQ90GyQBqhkPAUcQwF8GN9NHN95GW9IvqehXmeZjxB/vcej8Z342GIbDYRVTIC7Ey486g76w+I3Yh9B56MetwdYEsCc7Slc+dTM9uH8TFV0lFayTSKY4/l522aGYiUCQ7QOhcFBtXprmi9LVC8+ni446yUyRHFm3bQnge9seoGue/y0lilkqcLReIplWgTuObGWLKu3iLYzhUJC9BkF2H7ro9NgCunH5ZVgWGNhetiOArYk99J6nf0T/m3hRrfOTPOLLWh/FughIhGEkGlaGwjAvCz559Ln0gd6zrCuwjSSzFQF8bevv6Ovb7lHRe+LDj8cTcOlp9LAGgwFlH5DcBst549FPV7yXjgpO0kgD/US1BQHIWv/SJ35Aj8UHuMOXKJlMkvj0UfRDQBKaRKNRtRNRshpdu+hCteFIP030kFh7AvifnY/RxzbdRqPs0y+P+nFFAnrADymrISCzgUgozJmOXPSanmNpzfLLsQW5GlgtfK41AXzgqZ/QbXvWqc05iUSS0qkMQndbeBisdqlsOIqxbUAyGM30dtHPV76XlsXmWk1MreXRkgD2ZkbpwvWraUNyB6fWKqi1vmTdQbEjAi6KsLswyN4CyX587aIL6O1zzrCjoqbopB0BPLzvWXrnUzdxrr2U8uuLoQ8hvKY8O4ZWKtuOI9GIeAvprdNPpu8su9TQ+u1amVYEcOPAg/SZLbdTnjPlJlNJSrFvv5LDzq4NBL0OIiDuwliMlwS8NBAvwR0nXkVRpDg/CFAT77QhgH/d+Ev64Y6HlFtvlEd9tVW3CYVxid4IiFEwGolwViIfzfJ3050nfJjmhaforZSJ0lueAGRr7tue+CHds/8ZlUJ7ZJRz6iOU18RHxhpVRyJhEk9BtydIP1v+PnWugTUk00sKSxOAJOtYte4Geir5okqtPTrCLr6xgzL0ghnSdgKBYDBIQgR+PtDku8deSm+aubIT1dj6npYlgFFOyPnqR7+udvBlOQlnfHQUufhs/Sg2p5xkLI5x4JCXSeCGxRfTxbNPae5GDr3KkgQwmI3TOY9eTwPZQRXRF08kDj3ExqFNBbWrIeDjOIFYV4xJwEVf7jufrph/ZrWf4vPDELAcAezik3Zeve4/aGdumDfxZCkhnR8FCEyAgBxo0sVuQo/bQ5/tXUVXLXj1BFfga0GgnNzdIljIyH+g83OKrgRb+1GAQD0I5Hnz1wjbiPKc8u1q3gYu28FRJkbAMgQga36Z9quRXzo/b+OFj3/iBsQvDiKQZ++QIgE2FH9+y6/pJy88fPBLvBsXAUsQgFj7xeAna/7ytJ87PwoQaAIBcRGPsqs4zybjjz/7C/rVrseauItzLjHdBiB+/rMfvU65+mQLr4T2NlpKb/mvRi/B7zVCwPXf72hYWjngtCsWZRehl25e8W46e+rShu/hhAtMnwFIkI/4+ZWrDwY/JzxzhuiY5zRwo/E45UoFuvypH9EmProd5UgETCUACe+VCD/ZySd+fjj6j2wgfNI8Aio/RDJByVKW3rzu2yS7SFH+PwKmEYBs7FGx/Xz+nkT4cZp+FCDQdgTUaU9sVN5TSHBU6TdIToRCOYiAKQQgW3plV5+s/0dGOW8fwnsPtgjetR2BZCKlAsq2Zvaq1HFtr0DjGxpOADINu+zpm9SWXtnVVyiAkTV+fvQQnXMIxONJyucKdB+fEfHVLXfpIbcBUhpOABes/w7tL6TUfn5s6TWghVHFGAIlZRSUpLHXD9xDD+zbCGQYAUMJQHL4PZPcSVk5hVeSeaAAAQMRkCVnXLaT85LzCj47QsLOnV4MIwDJ3isJPFUOP07giSg/pz965uifk1OiUikaLqTpkid/aI4QFqrVEAKQvP2Sulss/cjhZ6HWd6goafYKZLM5FX/yxc13OBSFstqGEMDb1n9f5e2X1N3I3uvo580yysf5WRR7wOrtD9Bj+/stI5fRgnScAOS4rscT21UOP5W332gNUR8QGAeBktgD2AuVpwJnmV7j2PiAjhKAHNQpZ/UJ08Y5LBPr/nGeRHxkGgK5XI43n2V4B+oIfWTDLabJYWbFHSWAd3MMdo4ZNjk23TJTUdQNBMZDQJ7NQr5Iv3xpPf11cOt4P7H1Zx0jgNXb7lNGFvH1Z7I4qNPWT5HGyolhOsGHyRZcRbry7zer6FSN1WlY9I4QgFj9v/L87/jEnrLVv2GpcAEQMBABWQrInoGBzCB9bvPtBtZsflUdIYArn7qZEsUsH9Odchyjmt+kkKAZBMRDJbaqNTvW0kByXzO30PKathPAXwY304Mcb13ggIt0GtF+Wj4VDhRazpcUe4DkD7hqw08dg0Db'
INSTALLER_BADGE_PNG_2='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'
INSTALLER_BADGE_PNG_3='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'
INSTALLER_BADGE_PNG_4='vghNDcZoujdG0/h1JifWODo6jU9bPjjFt4i6EMMiCIAALNIQEAMImIEAhgYzUEedQMAiCIAALNIQEAMImIEACMAM1FEnELAIAiAAizQExAACZiAAAjADddQJBCyCAAjAIg0BMYCAGQiAAMxAHXUCAYsgAAKwSENADCBgBgIgADNQR51AwCIIgAAs0hAQAwiYgQAIwAzUUScQsAgCIACLNATEAAJmIAACMAN11AkELIIACMAiDQExgIAZCIAAzEAddQIBiyAAArBIQ0AMIGAGAiAAM1BHnUDAIgiAACzSEBADCJiBAAjADNRRJxCwCAIgAIs0BMQAAmYgAAIwA3XUCQQsggAIwCINATGAgBkIgADMQB11AgGLIAACsEhDQAwgYAYCIAAzUEedQMAiCIAALNIQEAMImIEACMAM1FEnELAIAiAAizQExAACZiAAAjADddQJBCyCAAjAIg0BMYCAGQiAAMxAHXUCAYsgAAKwSENADCBgBgIgADNQR51AwCIIgAAs0hAQAwiYgQAIwAzUUScQsAgCIACLNATEAAJmIAACMAN11AkELIIACMAiDQExgIAZCIAAzEAddQIBiyAAArBIQ0AMIGAGAiAAM1BHnUDAIgiAACzSEBADCJiBAAjADNRRJxCwCAL/Bwwo9WGyuuZZAAAAAElFTkSuQmCC'

usage() {
  printf '%s\n' \
    "Install KrutrimConnect from GitHub Releases (macOS and Linux)." \
    "" \
    "Usage:" \
    "  sh install.sh" \
    "  sh install.sh --preview             show the banner without installing" \
    "" \
    "Environment:" \
    "  KRUTRIM_CONNECT_VERSION=1.2.3       exact release (default: latest stable)" \
    "  KRUTRIM_CONNECT_GITHUB_AUTH=1       use gh login for internal/private releases" \
    "  KRUTRIM_CONNECT_INSTALL_DIR=/path   installation root (default: ~/.local/share/krutrimconnect)" \
    "  KRUTRIM_CONNECT_BIN_DIR=/path       launcher directory (default: ~/.local/bin)" \
    "  KRUTRIM_CONNECT_ASSET_DIR=/path     install downloaded artifacts; exact version required" \
    "  KRUTRIM_CONNECT_MODIFY_PATH=1       add PATH to bash/zsh profile (explicit opt-in)" \
    "  KRUTRIM_CONNECT_NO_ANIMATION=1      disable terminal animation" \
    "  KRUTRIM_CONNECT_INLINE_IMAGE=1      opt into a supported terminal image protocol" \
    "  NO_COLOR=1                         disable color" \
    "" \
    "Public latest resolves only to a stable release. Use an exact version for an" \
    "intentional prerelease. No system Node.js or npm is required: a private runtime" \
    "is bundled. The installer never invokes sudo or collects a Krutrim API key." \
    "Shell profiles are unchanged unless MODIFY_PATH=1; otherwise PATH instructions are printed."
}

info() {
  printf '%s\n' "-> $1"
}

fail() {
  printf '%s\n' "Error: $1" >&2
  exit 1
}

is_release_version() {
  case "$1" in '' | *[!0-9.next-]*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-next\.(0|[1-9][0-9]*))?$'
}

is_stable_release_version() {
  is_release_version "$1" &&
    ! printf '%s\n' "$1" | grep -q -- '-'
}

color_enabled() {
  [ -t 1 ] &&
    [ "${TERM:-}" != "dumb" ] &&
    [ "${CLICOLOR:-1}" != "0" ] &&
    [ -z "${NO_COLOR+x}" ]
}

animation_enabled() {
  [ -t 1 ] &&
    [ "${TERM:-}" != "dumb" ] &&
    [ -z "${CI:-}" ] &&
    [ "${KRUTRIM_CONNECT_NO_ANIMATION:-0}" != "1" ]
}

inline_image_protocol() {
  [ "${KRUTRIM_CONNECT_INLINE_IMAGE:-0}" = "1" ] || return 1
  [ -z "${CI:-}" ] || return 1
  [ -z "${TMUX:-}" ] || return 1
  [ -z "${STY:-}" ] || return 1
  case "${TERM:-}" in
    screen* | tmux*) return 1 ;;
  esac

  case "${TERM_PROGRAM:-}" in
    iTerm.app | WezTerm | wezterm | WarpTerminal)
      printf '%s\n' "iterm"
      return 0
      ;;
    ghostty)
      printf '%s\n' "kitty"
      return 0
      ;;
  esac

  case "${TERM:-}" in
    xterm-kitty | xterm-ghostty)
      printf '%s\n' "kitty"
      return 0
      ;;
  esac
  if [ -n "${KITTY_WINDOW_ID:-}" ]; then
    printf '%s\n' "kitty"
    return 0
  fi
  return 1
}

print_inline_badge() {
  case "$1" in
    iterm)
      printf '\033]1337;File=inline=1;width=24;height=12;preserveAspectRatio=1:'
      printf '%s%s%s%s' \
        "$INSTALLER_BADGE_PNG_1" \
        "$INSTALLER_BADGE_PNG_2" \
        "$INSTALLER_BADGE_PNG_3" \
        "$INSTALLER_BADGE_PNG_4"
      printf '\a\r\n'
      ;;
    kitty)
      printf '\033_Ga=T,f=100,c=24,r=12,q=2,m=1;%s\033\\' "$INSTALLER_BADGE_PNG_1"
      printf '\033_Gm=1,q=2;%s\033\\' "$INSTALLER_BADGE_PNG_2"
      printf '\033_Gm=1,q=2;%s\033\\' "$INSTALLER_BADGE_PNG_3"
      printf '\033_Gm=0,q=2;%s\033\\\r\n' "$INSTALLER_BADGE_PNG_4"
      ;;
    *) return 1 ;;
  esac
}

print_inline_banner() {
  printf '%s\n' ""
  printf '%s' "                     "
  print_inline_badge "$1"
  printf '%s\n' \
    "                     ${rail_glow}───────${rail_mid}──────────${rail_glow}───────${rail_reset}" \
    "" \
    "                         ${rail_white}KrutrimConnect${rail_reset}" \
    "                ${rail_bright}READY TO BUILD ON INDIA'S AI CLOUD${rail_reset}" \
    "" \
    "             ${rail_bright}✓${rail_reset} ${rail_white}Installed successfully${rail_reset}  ${rail_dim}·  Next:${rail_reset} ${rail_bright}login${rail_reset}"
}





print_pixel_badge() {
  printf '%b\n' '                 \033[0m      \033[0;38;5;35m▄▄\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀\033[0;38;5;35m▄▄\033[0m      \033[0m'
  printf '%b\n' '                 \033[0m   \033[0;38;5;35m▄\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\033[0;38;5;35m▄\033[0m   \033[0m'
  printf '%b\n' '                 \033[0m  \033[0;38;5;35;48;5;35m▀▀▀\033[0;38;5;15;48;5;15m▀▀▀▀▀▀▀▀▀▀▀▀▀▀\033[0;38;5;35;48;5;35m▀▀▀\033[0m  \033[0m'
  printf '%b\n' '                 \033[0m \033[0;38;5;35;48;5;35m▀▀▀▀▀▀\033[0;38;5;35;48;5;15m▀▀▀▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;35;48;5;15m▀▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀\033[0m \033[0m'
  printf '%b\n' '                 \033[0;38;5;35;48;5;35m▀▀▀▀▀\033[0;38;5;35;48;5;15m▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;15;48;5;35m▀▀\033[0;38;5;15;48;5;15m▀▀▀\033[0;38;5;15;48;5;35m▀▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀\033[0m'
  printf '%b\n' '                 \033[0;38;5;35;48;5;35m▀▀▀▀▀\033[0;38;5;15;48;5;35m▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;35;48;5;15m▀▀\033[0;38;5;15;48;5;15m▀▀▀\033[0;38;5;35;48;5;35m▀\033[0;38;5;35;48;5;15m▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀\033[0m'
  printf '%b\n' '                 \033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀\033[0;38;5;15;48;5;35m▀▀▀\033[0;38;5;15;48;5;15m▀▀▀\033[0;38;5;35;48;5;35m▀\033[0;38;5;15;48;5;35m▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀\033[0m'
  printf '%b\n' '                 \033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀▀▀\033[0;38;5;15;48;5;35m▀▀▀\033[0;38;5;35;48;5;15m▀\033[0;38;5;15;48;5;15m▀▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀\033[0m'
  printf '%b\n' '                 \033[0m \033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀▀▀▀▀\033[0;38;5;15;48;5;15m▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀\033[0m \033[0m'
  printf '%b\n' '                 \033[0m  \033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀▀▀▀\033[0;38;5;15;48;5;35m▀\033[0;38;5;15;48;5;15m▀▀▀\033[0;38;5;15;48;5;35m▀\033[0;38;5;35;48;5;35m▀▀▀▀\033[0m  \033[0m'
  printf '%b\n' '                 \033[0m   \033[0;38;5;35m▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\033[0;38;5;35m▀\033[0m   \033[0m'
  printf '%b\n' '                 \033[0m      \033[0;38;5;35m▀▀\033[0;38;5;35;48;5;35m▀▀▀▀▀▀▀▀\033[0;38;5;35m▀▀\033[0m      \033[0m'
}

print_pixel_badge_apple() {
  # Apple-only default-background workaround: https://apple.stackexchange.com/a/446604
  printf '%b\n' '                 \033[0m      \033[0;7;38;5;35;49m▀▀\033[0;48;5;35m        \033[0;7;38;5;35;49m▀▀\033[0m      \033[0m'
  printf '%b\n' '                 \033[0m   \033[0;7;38;5;35;49m▀\033[0;48;5;35m                \033[0;7;38;5;35;49m▀\033[0m   \033[0m'
  printf '%b\n' '                 \033[0m  \033[0;48;5;35m   \033[0;48;5;15m              \033[0;48;5;35m   \033[0m  \033[0m'
  printf '%b\n' '                 \033[0m \033[0;48;5;35m      \033[0;38;5;35;48;5;15m▀▀▀▀\033[0;48;5;15m  \033[0;38;5;35;48;5;15m▀▀▀\033[0;48;5;35m       \033[0m \033[0m'
  printf '%b\n' '                 \033[0;48;5;35m     \033[0;38;5;35;48;5;15m▀\033[0;48;5;15m  \033[0;38;5;15;48;5;35m▀▀\033[0;48;5;15m   \033[0;38;5;15;48;5;35m▀▀\033[0;48;5;15m  \033[0;48;5;35m       \033[0m'
  printf '%b\n' '                 \033[0;48;5;35m     \033[0;38;5;15;48;5;35m▀\033[0;48;5;15m  \033[0;38;5;35;48;5;15m▀▀\033[0;48;5;15m   \033[0;48;5;35m \033[0;38;5;35;48;5;15m▀\033[0;48;5;15m  \033[0;48;5;35m       \033[0m'
  printf '%b\n' '                 \033[0;48;5;35m       \033[0;38;5;15;48;5;35m▀▀▀\033[0;48;5;15m   \033[0;48;5;35m \033[0;38;5;15;48;5;35m▀▀\033[0;48;5;35m        \033[0m'
  printf '%b\n' '                 \033[0;48;5;35m          \033[0;38;5;15;48;5;35m▀▀▀\033[0;38;5;35;48;5;15m▀\033[0;48;5;15m   \033[0;48;5;35m       \033[0m'
  printf '%b\n' '                 \033[0m \033[0;48;5;35m            \033[0;48;5;15m  \033[0;48;5;35m        \033[0m \033[0m'
  printf '%b\n' '                 \033[0m  \033[0;48;5;35m           \033[0;38;5;15;48;5;35m▀\033[0;48;5;15m   \033[0;38;5;15;48;5;35m▀\033[0;48;5;35m    \033[0m  \033[0m'
  printf '%b\n' '                 \033[0m   \033[0;38;5;35;48;5;256m▀\033[0;48;5;35m                \033[0;38;5;35;48;5;256m▀\033[0m   \033[0m'
  printf '%b\n' '                 \033[0m      \033[0;38;5;35;48;5;256m▀▀\033[0;48;5;35m        \033[0;38;5;35;48;5;256m▀▀\033[0m      \033[0m'
}

print_badge() {
  if [ "${TERM_PROGRAM:-}" = "Apple_Terminal" ]; then
    print_pixel_badge_apple
  else
    print_pixel_badge
  fi
}

print_final_banner() {
  if color_enabled; then
    printf '%s\n' ""
    print_badge
    printf '%b\n' \
      "          ${rail_glow}───────────${rail_mid}────────────────${rail_glow}───────────${rail_reset}" \
      "" \
      "                      ${rail_white}KrutrimConnect${rail_reset}" \
      "            ${rail_bright}READY TO BUILD ON INDIA'S AI CLOUD${rail_reset}" \
      "" \
      "         ${rail_bright}✓${rail_reset} ${rail_white}Installed successfully${rail_reset}  ${rail_dim}·  Next:${rail_reset} ${rail_bright}login${rail_reset}"
  else
    printf '%s\n' \
      "" \
      "          ──────────────────────────────────────" \
      "" \
      "                      KrutrimConnect" \
      "            READY TO BUILD ON INDIA'S AI CLOUD" \
      "" \
      "         ✓ Installed successfully  ·  Next: login"
  fi
}

show_banner() {
  if color_enabled; then
    rail_glow="$(printf '\033[38;5;22m')"
    rail_dim="$(printf '\033[38;5;29m')"
    rail_mid="$(printf '\033[38;5;41m')"
    rail_bright="$(printf '\033[1;38;5;84m')"
    rail_white="$(printf '\033[1;39m')"
    badge_edge="$(printf '\033[38;5;35m')"
    badge_face="$(printf '\033[1;38;5;15;48;5;35m')"
    rail_reset="$(printf '\033[0m')"
  else
    rail_glow=""
    rail_dim=""
    rail_mid=""
    rail_bright=""
    rail_white=""
    badge_edge=""
    badge_face=""
    rail_reset=""
  fi
  if color_enabled; then
    inline_protocol="$(inline_image_protocol || true)"
  else
    inline_protocol=""
  fi

  if animation_enabled; then
    printf '%s\n' \
      "" \
      "      ${rail_dim}·       ·${rail_reset}       ${rail_white}KrutrimConnect${rail_reset}" \
      "                          ${rail_dim}INDIA'S AI-FIRST CLOUD${rail_reset}" \
      "" \
      "      ${rail_dim}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${rail_reset}" \
      "      ${rail_dim}○ 01 PACKAGE             ○ 02 CLI                 ○ 03 READY${rail_reset}" \
      ""
    sleep 0.12

    printf '\033[7A'
    printf '\r\033[2K%s\n' \
      "" \
      "      ${rail_mid}·   ·   ·${rail_reset}       ${rail_white}KrutrimConnect${rail_reset}" \
      "                          ${rail_mid}INDIA'S AI-FIRST CLOUD${rail_reset}" \
      "" \
      "      ${rail_mid}████████████████${rail_dim}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${rail_reset}" \
      "      ${rail_bright}✓ 01 PACKAGE${rail_reset}             ${rail_dim}○ 02 CLI                 ○ 03 READY${rail_reset}" \
      ""
    sleep 0.12

    printf '\033[7A'
    printf '\r\033[2K%s\n' \
      "" \
      "      ${rail_bright}✦   ✦   ✦${rail_reset}       ${rail_white}KrutrimConnect${rail_reset}" \
      "                          ${rail_mid}INDIA'S AI-FIRST CLOUD${rail_reset}" \
      "" \
      "      ${rail_mid}████████████████████████████████████${rail_bright}█${rail_dim}░░░░░░░░░░░░░░░░░░░░░░░${rail_reset}" \
      "      ${rail_bright}✓ 01 PACKAGE             ✓ 02 CLI${rail_reset}                 ${rail_dim}○ 03 READY${rail_reset}" \
      ""
    sleep 0.12

    printf '\033[7A'
    printf '\r\033[2K%s\n' \
      "" \
      "      ${rail_bright}✦   ✦   ✦${rail_reset}       ${rail_white}KrutrimConnect${rail_reset}" \
      "                          ${rail_bright}INDIA'S AI-FIRST CLOUD${rail_reset}" \
      "" \
      "      ${rail_mid}████████████████████${rail_bright}████████████████████████████████████████${rail_reset}" \
      "      ${rail_bright}✓ 01 PACKAGE             ✓ 02 CLI                 ✓ 03 READY${rail_reset}" \
      ""
    sleep 0.16

    if [ -n "$inline_protocol" ]; then
      printf '\033[7A'
      clear_line=0
      while [ "$clear_line" -lt 7 ]; do
        printf '\r\033[2K\n'
        clear_line=$((clear_line + 1))
      done
      printf '\033[7A'
      print_inline_banner "$inline_protocol"
      return
    fi

    printf '\033[7A'
    clear_line=0
    while [ "$clear_line" -lt 7 ]; do
      printf '\r\033[2K\n'
      clear_line=$((clear_line + 1))
    done
    printf '\033[7A'
    print_final_banner
  else
    if [ -n "$inline_protocol" ]; then
      print_inline_banner "$inline_protocol"
    else
      print_final_banner
    fi
  fi
}

print_completion() {
  printf '%s\n' \
    "" \
    "  ${rail_white}KrutrimConnect${rail_reset}  ${rail_dim}v${installed_version}${rail_reset}" \
    "" \
    "  Connect Krutrim Cloud models to your AI coding tools." \
    "" \
    "  ${rail_white}Get started:${rail_reset}" \
    "    login                    Store API key." \
    "    models list              List models." \
    "    models show <model>      Show model details." \
    "    codex on --model <id>    Connect Codex." \
    "" \
    "  ${rail_white}Harnesses:${rail_reset}" \
    "    codex                    Codex CLI." \
    "    opencode                 OpenCode." \
    "" \
    "  ${rail_white}Per harness:${rail_reset}" \
    "    <harness> on --model <id>  Enable Krutrim routing." \
    "    <harness> off              Restore settings." \
    "    status / opencode status   Show connection details." \
    "    opencode run [args...]      Start OpenCode." \
    "" \
    "  ${rail_white}Other:${rail_reset}" \
    "    auth status               Show credential status." \
    "    logout                    Remove credentials." \
    "    status                    Show Codex status." \
    "    doctor                    Check setup." \
    "    upgrade                   Install latest release." \
    "    uninstall                 Remove KrutrimConnect." \
    "    chat                      Send a chat request." \
    "    --help                    Show commands." \
    "    <command> --help          Show command options." \
    "" \
    "  ${rail_dim}Login validates your key. Model use may incur charges.${rail_reset}"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
if [ "$#" -eq 1 ] && [ "$1" = "--preview" ]; then
  info "Banner preview only; no installation performed."
  show_banner
  exit 0
fi
if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

REPOSITORY="ola-krutrim/krutrimconnect"
REQUESTED_VERSION="${KRUTRIM_CONNECT_VERSION:-latest}"
INSTALL_DIR="${KRUTRIM_CONNECT_INSTALL_DIR:-${HOME:?HOME is required}/.local/share/krutrimconnect}"
BIN_DIR="${KRUTRIM_CONNECT_BIN_DIR:-${HOME}/.local/bin}"
ASSET_DIR="${KRUTRIM_CONNECT_ASSET_DIR:-}"

case "$REQUESTED_VERSION" in
  latest) ;;
  *) is_release_version "$REQUESTED_VERSION" || fail "KRUTRIM_CONNECT_VERSION must be latest or an exact release version (X.Y.Z or X.Y.Z-next.N)." ;;
esac
case "${KRUTRIM_CONNECT_CHANNEL:-public}" in
  public) ;;
  *) fail "Package channels are no longer used by this installer. Use an exact KRUTRIM_CONNECT_VERSION and KRUTRIM_CONNECT_GITHUB_AUTH=1 for internal releases." ;;
esac
case "${KRUTRIM_CONNECT_GITHUB_AUTH:-0}" in
  0 | 1) ;;
  *) fail "KRUTRIM_CONNECT_GITHUB_AUTH must be 0 or 1." ;;
esac
if [ -n "$ASSET_DIR" ]; then
  [ "$REQUESTED_VERSION" != latest ] || fail "Local artifacts require an exact release version."
  case "$ASSET_DIR" in /*) ;; *) fail "Asset directory must be absolute." ;; esac
  [ -d "$ASSET_DIR" ] || fail "Local asset directory does not exist."
else
  if [ "${KRUTRIM_CONNECT_GITHUB_AUTH:-0}" = 1 ]; then
    command -v gh >/dev/null 2>&1 || fail "GitHub CLI is required for internal releases. Run gh auth login with repository access."
  else
    command -v curl >/dev/null 2>&1 || fail "curl is required to download public releases."
  fi
fi
if [ "$REQUESTED_VERSION" = latest ]; then
  if [ "${KRUTRIM_CONNECT_GITHUB_AUTH:-0}" = 1 ]; then
    tag="$(gh release view --repo "$REPOSITORY" --json tagName --jq .tagName)" || fail "Cannot read GitHub Releases. Check gh authentication and repository access."
  else
    release_url="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 --output /dev/null --write-out '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest")" || fail "Cannot read public GitHub Releases. Check your network, proxy or firewall, and retry; a published release must exist."
    case "$release_url" in
      "https://github.com/$REPOSITORY/releases/tag/"*) tag="${release_url##*/}" ;;
      *) fail "Unexpected GitHub release URL." ;;
    esac
  fi
  case "$tag" in v*) REQUESTED_VERSION="${tag#v}" ;; *) fail "Invalid GitHub release tag." ;; esac
  is_stable_release_version "$REQUESTED_VERSION" || fail "Latest must resolve to a stable release. Use KRUTRIM_CONNECT_VERSION explicitly for a prerelease."
fi
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "Release installation supports macOS and Linux only." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Unsupported CPU architecture." ;;
esac
case "$INSTALL_DIR" in /*) ;; *) fail "Install directory must be absolute." ;; esac
case "$BIN_DIR" in /*) ;; *) fail "Binary directory must be absolute." ;; esac
libc_suffix=""
if [ "$platform" = linux ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
  [ "$arch" = x64 ] || fail "Alpine releases currently support x64 only."
  libc_suffix="-musl"
fi
archive="krutrimconnect-${REQUESTED_VERSION}-${platform}-${arch}${libc_suffix}.tar.gz"
work="$(mktemp -d "${TMPDIR:-/tmp}/krutrimconnect-install.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
info "Downloading KrutrimConnect..."
if [ -n "$ASSET_DIR" ]; then
  cp "$ASSET_DIR/$archive" "$work/$archive"
  cp "$ASSET_DIR/$archive.sha256" "$work/$archive.sha256"
elif [ "${KRUTRIM_CONNECT_GITHUB_AUTH:-0}" = 1 ]; then
  gh release download "v$REQUESTED_VERSION" --repo "$REPOSITORY" --pattern "$archive" --pattern "$archive.sha256" --dir "$work" || fail "Could not download release artifacts. Check repository access, release version, and supported platform."
else
  for asset in "$archive" "$archive.sha256"; do
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 300 --retry 2 --output "$work/$asset" "https://github.com/$REPOSITORY/releases/download/v$REQUESTED_VERSION/$asset" || fail "Could not download release artifact. Check your network, proxy or firewall and retry; also confirm the release version and supported platform."
  done
fi
info "Verifying KrutrimConnect..."
# Accept exactly one checksum for this archive, never arbitrary paths from a manifest.
checksum_line="$(cat "$work/$archive.sha256")"
checksum="${checksum_line%% *}"
printf '%s\n' "$checksum" | grep -Eq '^[0-9a-f]{64}$' || fail "Invalid release checksum."
[ "$checksum_line" = "$checksum  $archive" ] || fail "Invalid release checksum filename."
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$archive")"
else
  actual="$(shasum -a 256 "$work/$archive")"
fi
[ "${actual%% *}" = "$checksum" ] || fail "Release checksum verification failed."
tar -tzf "$work/$archive" > "$work/entries" || fail "Invalid release archive."
if grep -Eq '(^/|(^|/)\.\.(/|$)|\\)' "$work/entries"; then
  fail "Unsafe path in release archive."
fi
tar -tvzf "$work/$archive" > "$work/types" || fail "Invalid release archive."
if grep -Eq '^[^-d]' "$work/types"; then
  fail "Release archive must contain only regular files and directories (no links)."
fi
mkdir "$work/payload"
tar -xzf "$work/$archive" -C "$work/payload" || fail "Could not extract release archive."
for required in bin/node bin/krutrimconnect dist/cli.js package.json release.json install.sh; do
  [ -f "$work/payload/$required" ] || fail "Release archive is missing $required."
done
[ -x "$work/payload/bin/node" ] && [ -x "$work/payload/bin/krutrimconnect" ] || fail "Release executables are not executable."
# All filesystem activation is serialized and validated using the verified private runtime.
"$work/payload/bin/node" --input-type=module - "$work/payload" "$INSTALL_DIR" "$BIN_DIR" "$REQUESTED_VERSION" "$platform" "$arch" "$checksum" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// fs.cpSync creates descendant directories using the process umask.
// Restrict newly created paths without chmod'ing any existing/shared directory.
process.umask(process.umask() | 0o022);
const [payload, suppliedInstall, suppliedBin, version, platform, arch, checksum] = process.argv.slice(2);
const repository = 'ola-krutrim/krutrimconnect';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const stat = (p) => { try { return fs.lstatSync(p); } catch (e) { if(e.code === 'ENOENT') return null; throw e; } };
const requireTrue = (ok, message) => { if (!ok) throw Error(message); };
const owned = (p, kind) => {
  const info = stat(p);
  requireTrue(info && typeof process.getuid === 'function' && info.uid === process.getuid() &&
    (kind === 'symlink' ? info.isSymbolicLink() : (info.mode & 0o022) === 0 && (kind === 'directory' ? info.isDirectory() : info.isFile())),
    'Unsafe ownership, permissions, or type: ' + p);
};
const versionParts = (v) => { requireTrue(/^[0-9]+\.[0-9]+\.[0-9]+(?:-next\.[0-9]+)?$/.test(v), 'Invalid version metadata.'); const [base, pre] = v.split('-next.'); const parts = base.split('.').map(Number); if (pre !== undefined) parts.push(Number(pre)); else parts.push(Infinity); requireTrue(parts.slice(0,3).every(Number.isSafeInteger) && (pre === undefined || Number.isSafeInteger(parts[3])), 'Unsafe version metadata.'); return parts; };
const compare = (a,b) => { const x=versionParts(a), y=versionParts(b); for(let i=0;i<4;i++) if(x[i]!==y[i]) return x[i]<y[i]?-1:1; return 0; };
let lock;
let firstInstallCleanup;
try {
  versionParts(version);
  const meta = read(path.join(payload, 'release.json'));
  const pkg = read(path.join(payload, 'package.json'));
  requireTrue(meta.schemaVersion === 1 && meta.distribution === 'github-release' && meta.repository === repository && meta.version === version && meta.platform === platform && meta.arch === arch && meta.nodeVersion === process.versions.node && pkg.name === 'krutrimconnect' && pkg.version === version, 'Invalid release metadata.');
  requireTrue(process.platform === platform && process.arch === arch, 'Release runtime does not match this platform.');
  for(const dir of [suppliedInstall, suppliedBin]) {
    requireTrue(path.isAbsolute(dir) && path.normalize(dir) === dir && dir !== path.parse(dir).root && dir !== process.env.HOME, 'Unsafe installation directory.');
    requireTrue(!stat(dir)?.isSymbolicLink(), 'Installation directories must not be symlinks.');
  }
  // Canonicalize parent aliases such as macOS /var -> /private/var.
  const canonical = (p) => { const parent=path.dirname(p); fs.mkdirSync(parent,{recursive:true,mode:0o755}); return path.join(fs.realpathSync(parent),path.basename(p)); };
  const installDir=canonical(suppliedInstall), binDir=canonical(suppliedBin);
  requireTrue(installDir !== binDir && !installDir.startsWith(binDir + '/') && !binDir.startsWith(installDir + '/'), 'Installation and binary directories must be separate.');
  const rootStat=stat(installDir);
  if(rootStat) owned(installDir, 'directory');
  if(stat(binDir)) owned(binDir, 'directory');
  if(rootStat) requireTrue(fs.readdirSync(installDir).every(n => ['install.json','current','releases','.install-lock'].includes(n)), 'Refusing an unmanaged installation directory.');
  fs.mkdirSync(installDir,{recursive:true,mode:0o700});
  const lockPath=path.join(installDir,'.install-lock');
  fs.mkdirSync(lockPath,{mode:0o700}); lock=lockPath;
  const markerPath=path.join(installDir,'install.json');
  const releases=path.join(installDir,'releases'), current=path.join(installDir,'current');
  const launcher=path.join(binDir,'krutrimconnect'), launcherTarget=path.join(installDir,'current/bin/krutrimconnect');
  if(stat(markerPath)) {
    owned(markerPath, 'file');
    const marker=read(markerPath);
    requireTrue(marker.schemaVersion===1 && marker.distribution==='github-release' && marker.repository===repository && marker.installDir===installDir && marker.binDir===binDir, 'Invalid installation metadata or changed binary directory.');
    owned(releases, 'directory');
    owned(current, 'symlink');
    const previousLink=fs.readlinkSync(current);
    requireTrue(/^releases\/[0-9]+\.[0-9]+\.[0-9]+(?:-next\.[0-9]+)?$/.test(previousLink), 'Invalid current release link.');
    const previousVersion=previousLink.slice('releases/'.length);
    requireTrue(compare(version,previousVersion)>=0, 'Refusing to downgrade KrutrimConnect.');
  } else {
    requireTrue(!stat(current) && !stat(releases), 'Refusing an unmanaged installation directory.');
  }
  const launcherStat=stat(launcher);
  requireTrue(!launcherStat || (launcherStat.isSymbolicLink() && fs.readlinkSync(launcher)===launcherTarget), 'Refusing to overwrite an unrelated krutrimconnect launcher.');
  if(launcherStat) owned(launcher, 'symlink');
  const installed=execFileSync(path.join(payload,'bin/krutrimconnect'),['--version'],{encoding:'utf8',timeout:30000}).trim();
  requireTrue(installed===version, `Installed version verification failed: expected ${version}, got ${installed}.`);
  const destination=path.join(releases,version);
  if(stat(destination)) {
    // Match lifecycle releaseTree validation before executing any existing code.
    // The saved archive digest identifies the download, not the current tree's contents.
    const directory = (p) => {
      owned(p, 'directory');
      requireTrue(fs.realpathSync(p) === p, 'Unsafe release directory: ' + p);
    };
    const json = (p) => {
      owned(p, 'file');
      requireTrue(stat(p).size <= 16 * 1024, 'Invalid existing release metadata size.');
      const value = read(p);
      requireTrue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid existing release metadata.');
      return value;
    };
    directory(destination);
    const existingMeta = json(path.join(destination, 'release.json'));
    const existingPkg = json(path.join(destination, 'package.json'));
    requireTrue(existingMeta.schemaVersion === 1 && existingMeta.distribution === 'github-release' && existingMeta.repository === repository && existingMeta.version === version && existingMeta.platform === platform && existingMeta.arch === arch && existingMeta.nodeVersion === meta.nodeVersion && existingPkg.name === 'krutrimconnect' && existingPkg.version === version, 'Invalid existing release metadata.');
    for (const dir of ['dist', 'node_modules', 'schemas', 'catalog', 'bin']) directory(path.join(destination, dir));
    for (const file of ['dist/cli.js', 'install.sh', 'bin/node', 'bin/krutrimconnect', '.archive-sha256']) owned(path.join(destination, file), 'file');
    requireTrue(fs.readFileSync(path.join(destination,'.archive-sha256'),'utf8')===checksum, 'Existing release differs; refusing to overwrite immutable files.');
    requireTrue(execFileSync(path.join(destination,'bin/krutrimconnect'),['--version'],{encoding:'utf8',timeout:30000}).trim()===version, 'Existing release verification failed.');
  } else {
    const releasesCreated = !stat(releases);
    fs.mkdirSync(releases,{recursive:true,mode:0o700});
    if (releasesCreated) firstInstallCleanup = { releases, current, markerPath, destination: null };
    // Stage on the destination filesystem so activation cannot expose a partial copy.
    const staging=fs.mkdtempSync(path.join(releases,'.staging-'));
    try {
      fs.cpSync(payload,staging,{recursive:true,dereference:false});
      fs.writeFileSync(path.join(staging,'.archive-sha256'),checksum,{mode:0o600});
      fs.renameSync(staging,destination);
      if (firstInstallCleanup) firstInstallCleanup.destination = destination;
    } finally { fs.rmSync(staging,{recursive:true,force:true}); }
  }
  fs.mkdirSync(binDir,{recursive:true,mode:0o755});
  const markerTemp=path.join(lock,'install.json');
  fs.writeFileSync(markerTemp,JSON.stringify({schemaVersion:1,distribution:'github-release',repository,installDir,binDir})+'\n',{mode:0o600});
  const previousLink = stat(current) ? fs.readlinkSync(current) : null;
  const previousMarker = stat(markerPath) ? fs.readFileSync(markerPath) : null;
  let activated = false;
  let launcherCreated = false;
  try {
    fs.renameSync(markerTemp, markerPath);
    const tempLink = path.join(lock, 'current');
    fs.symlinkSync('releases/' + version, tempLink);
    fs.renameSync(tempLink, current);
    activated = true;
    if (!launcherStat) {
      fs.symlinkSync(launcherTarget, launcher);
      launcherCreated = true;
    }
    requireTrue(execFileSync(launcher, ['--version'], {encoding:'utf8', timeout:30000}).trim() === version, 'Activated release verification failed.');
  } catch (error) {
    if (launcherCreated) fs.unlinkSync(launcher);
    if (activated) {
      if (previousLink === null) fs.unlinkSync(current);
      else {
        const rollback = path.join(lock, 'rollback');
        fs.symlinkSync(previousLink, rollback);
        fs.renameSync(rollback, current);
      }
    }
    if (previousMarker === null) fs.rmSync(markerPath, {force:true});
    else {
      fs.writeFileSync(markerTemp, previousMarker, {mode:0o600});
      fs.renameSync(markerTemp, markerPath);
    }
    throw error;
  }
  firstInstallCleanup = null;
  const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  const pathLine = 'export PATH=' + quote(binDir) + ':"$PATH"';
  if(process.env.KRUTRIM_CONNECT_MODIFY_PATH === '1') {
    const shell=path.basename(process.env.SHELL || '');
    const profileName = shell==='zsh' ? '.zshrc' : shell==='bash' ? (platform==='darwin'?'.bash_profile':'.bashrc') : null;
    if(profileName) {
      const profile=path.join(process.env.HOME,profileName);
      const profileStat=stat(profile);
      requireTrue(!profileStat || profileStat.isFile(), 'Refusing to change a symlink or non-file shell profile.');
      const source=profileStat?fs.readFileSync(profile,'utf8'):'';
      if(!source.split('\n').includes(pathLine)) fs.appendFileSync(profile,'\n# KrutrimConnect PATH\n'+pathLine+'\n',{mode:0o600});
      console.log('PATH configured in '+profile+'. Open a new terminal, or run: '+pathLine);
    } else console.log('Unsupported shell profile; add PATH manually: '+pathLine);
  } else if(!(process.env.PATH || '').split(':').includes(binDir)) {
    console.log('Shell profiles were not changed. Add PATH with: '+pathLine);
  }
  const first=(process.env.PATH || '').split(':').map(d=>path.join(d,'krutrimconnect')).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return true;}catch{return false;}});
  if(first && fs.realpathSync(first)!==fs.realpathSync(launcher)) console.log('Warning: another krutrimconnect shadows this installation at '+first+'. Put '+binDir+' first on PATH.');
} catch(e) {
  console.error('Error: '+e.message); process.exitCode=1;
  // Only remove this attempt's first-install release after activation is undone.
  // Never prune pre-existing versions or recursively remove a shared directory.
  if (firstInstallCleanup && !stat(firstInstallCleanup.current) && !stat(firstInstallCleanup.markerPath)) {
    try {
      if (firstInstallCleanup.destination) fs.rmSync(firstInstallCleanup.destination,{recursive:true,force:true});
      fs.rmdirSync(firstInstallCleanup.releases);
    } catch (cleanupError) { console.error('Error cleaning partial installation: '+cleanupError.message); }
  }
}
finally { if(lock) fs.rmSync(lock,{recursive:true,force:true}); }
NODE
installed_version="$REQUESTED_VERSION"
info "Finalizing install..."
show_banner
print_completion
