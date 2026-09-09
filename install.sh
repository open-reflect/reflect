#!/bin/sh
# POSIX 진입점. 실제 설치는 install.ts 가 한다 — 윈도우는 `bun install.ts` 를 직접 친다.
exec bun "$(dirname "$0")/install.ts" "$@"
