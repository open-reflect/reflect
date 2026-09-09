---
name: reflect
version: 0.2.0
description: Query what this agent actually did (tokens, tool calls, MCP, references, friction) with reflect, and change its provider, model and settings. Triggers — token usage, resident prompt cost, which files get reopened, MCP failure rate, what hooks blocked, switch provider, judge model, reflect settings, pending proposals, /reflect. 토큰 사용량 · provider 바꿔 · reflect 설정 · 대기 중인 제안.
triggers:
  - reflect
  - reflect settings
  - token usage
  - switch provider
  - pending proposals
  - reflect 설정
  - 토큰 사용량
  - provider 바꿔
  - 제안 확인
---

# reflect — query the record, change the settings

The CLI is `reflect` (or `bun ~/.claude/tools/reflect/src/cli.ts`). Every query reads local
SQLite and calls no model. The only command that calls a model is `propose`.

## Question → command

| The user asks | Run |
|---|---|
| where tokens go / how big the resident prompt is | `reflect stats tokens` |
| last week only | `reflect stats tokens --since <YYYY-MM-DD>` |
| which tools fail | `reflect stats tools` |
| MCP server / tool failure rates | `reflect stats mcp` |
| which files, URLs, skills, memories get reopened | `reflect stats io` |
| what hooks blocked / which hooks are slow | `reflect stats hooks` |
| unused skills | `reflect stats skills` |
| high-friction sessions | `reflect stats sessions` |
| pending proposals | `reflect queue` |
| change a proposal's status | `reflect mark <path> approved\|rejected\|applied` |

All `stats` take `--since YYYY-MM-DD`, `--limit N`, `--json`. Use `--json` when you need to
post-process the table.

## Settings

```sh
reflect config                       # current values and their source (default / config.json / env)
reflect config provider codex        # judging and synthesis run on codex
reflect config judge_model sonnet    # model for drafts and votes
reflect config window_days 14        # evidence window
reflect config language ko           # language for generated proposals
reflect config provider --unset      # back to the default
```

Precedence: **env var > `~/.claude-reflect/config.json` > default**. To change one cron run only,
use the env var: `REFLECT_PROVIDER=codex reflect propose`.

## Provider login

```sh
reflect providers                # installed? logged in? which command logs in
reflect login                    # pick a provider from a list, then log in
reflect login codex --api-key    # pipe $OPENAI_API_KEY in instead of a browser
reflect logout claude            # drop stored credentials
```

reflect keeps no credentials; it runs each CLI's own login (`claude auth login`, `codex login`).

🔴 **`reflect login` waits for browser approval.** An agent cannot approve on the user's behalf —
ask the user to run it in their own terminal (`!reflect login <provider>` inside Claude Code).

⚠️ API keys are never passed as arguments (`ps` would show them). `--api-key` reads the
provider's environment variable and passes it on stdin.

## Collect and propose

```sh
reflect collect   # incremental ingest (the Stop hook normally does this)
reflect verify    # coverage and no-row-loss check
reflect propose   # miners -> proposals -> qualitative ones judged and applied
```

⚠️ `propose` makes 13–35 headless model calls. Run it only when the user asks explicitly.
A qualitative proposal that passes judging is saved as `<name>.apply.md` for review (default), or
written straight to `learned-rules.md` / project memory when `auto_apply` is on. Originals are
backed up to `~/.claude-reflect/rollback/` first; `reflect rollback <backup> <target>` restores.
