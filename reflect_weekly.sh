#!/bin/sh
# cron entry point (macOS/Linux). The work is one command: `reflect weekly`.
# Windows Task Scheduler runs `bun <cli.ts> weekly` directly and does not need this file.
set -e

# cron is not a login shell. Without these, the judging step dies silently:
#   ~/.local/bin, ~/.bun/bin, Homebrew — where claude/codex/bun live
#   USER — claude resolves keychain credentials through it ("Not logged in" otherwise)
PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
USER="${USER:-$(id -un)}"
export PATH USER

exec bun "$(dirname "$0")/src/cli.ts" weekly
