CREATE TABLE IF NOT EXISTS api_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  cost_microusd INTEGER NOT NULL CHECK(cost_microusd >= 0),
  pricing_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS api_usage_events_no_update
BEFORE UPDATE ON api_usage_events BEGIN SELECT RAISE(ABORT, 'api_usage_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS api_usage_events_no_delete
BEFORE DELETE ON api_usage_events BEGIN SELECT RAISE(ABORT, 'api_usage_events are append-only'); END;

CREATE INDEX IF NOT EXISTS api_usage_events_created_at_idx ON api_usage_events(created_at);
