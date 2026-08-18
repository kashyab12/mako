#!/usr/bin/env bash
# Evaluate an expression in the running window and print the result.
#
#   scripts/probe.sh 'document.title'
#   scripts/probe.sh 'const b = document.querySelector("button"); b.textContent'
#
# The expression is wrapped in a function, so declarations are scoped to the
# call — otherwise a `const` from one probe collides with the next and every
# later call fails with a syntax error that has nothing to do with what you
# asked.
#
# Needs the app launched with MAKO_AUTOMATION=<port>. Touches nothing else on
# the machine: no pointer, no focus, no keystrokes.
set -euo pipefail
PORT="${MAKO_AUTOMATION:-7333}"
printf '(async () => { %s })()' "$1" | curl -s --data-binary @- "http://127.0.0.1:${PORT}/eval"
