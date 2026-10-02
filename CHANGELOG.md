# Changelog

## 0.3.0 — 2026-10-02

- Collect pi and omp (oh-my-pi) sessions from `~/.pi/agent/sessions`, `~/.omp/agent/sessions`, `$PI_CODING_AGENT_DIR/sessions` and `$PI_CODING_AGENT_SESSION_DIR` into the same tables, with `pi:` / `omp:` tool-name prefixes (#2).
- Fix: an incremental read saved its watermark one byte past the end of the file, so the next read dropped the first appended line. This affected Claude transcripts too. To recover rows lost before this version, run `sqlite3 ~/.claude-reflect/reflect.db "DELETE FROM ingest_cursor"` and then `reflect collect`; natural keys dedupe the rest (#2).

## 0.2.0 — 2026-10-02

- Collect Codex sessions from `~/.codex/sessions`, `$CODEX_HOME/sessions` and Orca account homes into the same tables, with `codex:` tool-name prefixes. The Codex desktop chat folder, temp dirs and sessions delegated from Claude through the codex plugin are skipped (#1).
- `package.json` still read `0.1.0` at this tag; versions were first recorded in 0.3.0.

## 0.1.0 — 2026-09-09

- First public version: ingest Claude Code transcripts into a local SQLite DB, GROUP BY stats (tokens, tool failures, hook blocks, MCP failure rate, re-read files), and model-written improvement proposals.
