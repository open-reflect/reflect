// Shared with the Python edition of reflect: both read and write the same database file.
export const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  cwd          TEXT,
  git_branch   TEXT,
  version      TEXT,
  first_ts     TEXT,
  last_ts      TEXT,
  is_sidechain INTEGER,
  file_path    TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id   TEXT NOT NULL,
  uuid         TEXT NOT NULL,
  tool_use_id  TEXT NOT NULL,
  ts           TEXT,
  tool_name    TEXT,
  is_mcp       INTEGER,
  is_sidechain INTEGER,
  input_json   TEXT,
  is_error     INTEGER,
  attribution_skill      TEXT,
  attribution_plugin     TEXT,
  attribution_mcp_server TEXT,
  attribution_mcp_tool   TEXT,
  PRIMARY KEY (session_id, tool_use_id)
);

-- One hook run = one attachment record (hook_* subtypes only).
CREATE TABLE IF NOT EXISTS hook_events (
  session_id  TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  ts          TEXT,
  hook_name   TEXT,
  hook_event  TEXT,
  subtype     TEXT,
  command     TEXT,
  exit_code   INTEGER,
  duration_ms INTEGER,
  tool_use_id TEXT,
  stderr      TEXT,
  PRIMARY KEY (session_id, uuid)
);

-- Denials only (toolDenialKind). Approved prompts leave no trace in the transcript,
-- so approvals cannot be counted; this table measures friction.
CREATE TABLE IF NOT EXISTS permission_events (
  session_id  TEXT NOT NULL,
  uuid        TEXT NOT NULL,
  ts          TEXT,
  denial_kind TEXT,
  tool_use_id TEXT,
  detail      TEXT,
  PRIMARY KEY (session_id, uuid)
);

-- One assistant turn = one model call. cache_read exposes the resident prompt,
-- thinking_tokens the reasoning cost; the model name identifies the provider.
CREATE TABLE IF NOT EXISTS model_turns (
  session_id      TEXT NOT NULL,
  uuid            TEXT NOT NULL,
  ts              TEXT,
  model           TEXT,
  input_tokens    INTEGER,
  cache_read      INTEGER,
  cache_create    INTEGER,
  output_tokens   INTEGER,
  thinking_tokens INTEGER,
  service_tier    TEXT,
  is_sidechain    INTEGER,
  PRIMARY KEY (session_id, uuid)
);

-- Memory-file paths found inside Bash command strings. Only this one path shape is extracted:
-- it is unique enough to have no false positives, unlike paths in general.
CREATE TABLE IF NOT EXISTS path_refs (
  session_id  TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  ts          TEXT,
  path        TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_use_id, path)
);

-- Memory files that changed during a turn, detected by mtime/size at the Stop hook.
-- Tool-independent: catches heredocs, cp, editors. Reads are invisible here.
CREATE TABLE IF NOT EXISTS memory_snapshot (
  path  TEXT PRIMARY KEY,
  mtime REAL NOT NULL,
  size  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_changes (
  session_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  path       TEXT NOT NULL,
  change     TEXT NOT NULL,   -- created | modified | deleted
  PRIMARY KEY (session_id, ts, path)
);

-- Per-file byte watermark for speed; correctness comes from natural-key INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS ingest_cursor (
  file_path   TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  inode       INTEGER,
  size        INTEGER,
  mtime       REAL,
  updated_at  TEXT
);

-- Correction candidates (keyword heuristic). Only the scrubbed head of a matching
-- utterance is kept, never full user text.
CREATE TABLE IF NOT EXISTS corrections (
  session_id TEXT NOT NULL,
  uuid       TEXT NOT NULL,
  ts         TEXT,
  pattern    TEXT,
  excerpt    TEXT,
  PRIMARY KEY (session_id, uuid)
);

CREATE INDEX IF NOT EXISTS ix_tc_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS ix_tc_skill   ON tool_calls(attribution_skill);
CREATE INDEX IF NOT EXISTS ix_he_name    ON hook_events(hook_name);
CREATE INDEX IF NOT EXISTS ix_pe_kind    ON permission_events(denial_kind);
CREATE INDEX IF NOT EXISTS ix_corr_ptn   ON corrections(pattern);
CREATE INDEX IF NOT EXISTS ix_mt_model   ON model_turns(model);

-- References are already in tool_calls.input_json; this view extracts them.
-- input_json is capped at 4000 chars, so truncated rows are not valid JSON and drop out.
-- Paths inside Bash command strings are not extracted (too many false positives).
-- connect() recreates the view when its definition changes; a DROP here would make every command a writer.
CREATE VIEW IF NOT EXISTS io_refs AS
SELECT * FROM (
  SELECT
    session_id, ts, tool_name, is_mcp, is_error, attribution_skill,
    CASE
      WHEN json_extract(input_json, '$.skill') IS NOT NULL THEN 'skill'
      WHEN json_extract(input_json, '$.url')   IS NOT NULL THEN 'url'
      WHEN json_extract(input_json, '$.uri')   IS NOT NULL THEN 'mcp_resource'
      WHEN COALESCE(json_extract(input_json, '$.file_path'),
                    json_extract(input_json, '$.notebook_path')) LIKE '%/memory/%' THEN 'memory'
      ELSE 'file'
    END AS kind,
    COALESCE(
      json_extract(input_json, '$.skill'),
      json_extract(input_json, '$.url'),
      json_extract(input_json, '$.uri'),
      json_extract(input_json, '$.file_path'),
      json_extract(input_json, '$.notebook_path'),
      json_extract(input_json, '$.path')
    ) AS ref
  FROM tool_calls
  WHERE json_valid(input_json)
  UNION ALL
  SELECT p.session_id, p.ts, 'Bash' AS tool_name, 0 AS is_mcp, tc.is_error, tc.attribution_skill,
         'memory' AS kind, p.path AS ref
  FROM path_refs p LEFT JOIN tool_calls tc ON tc.tool_use_id = p.tool_use_id
)
WHERE ref IS NOT NULL;

-- Evaluator for applied interventions: snapshot a metric (hook_blocks:<hook> | error_rate:<tool>)
-- at apply time, re-measure on review, judge improvement with SQL alone.
CREATE TABLE IF NOT EXISTS interventions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at      TEXT NOT NULL,
  proposal_slug   TEXT NOT NULL,
  metric_kind     TEXT NOT NULL,   -- 'hook_blocks' | 'error_rate'
  metric_param    TEXT NOT NULL,   -- hook name or tool name
  baseline_value  REAL NOT NULL,
  note            TEXT,
  reviewed_at     TEXT,
  current_value   REAL,
  delta_pct       REAL
);

-- Review state of each proposal file. A person sees pending items in the SessionStart
-- notice and changes the status; reflect applies files only through the judged path.
CREATE TABLE IF NOT EXISTS proposal_log (
  path       TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'  -- pending | approved | rejected | applied | superseded
);
`;
