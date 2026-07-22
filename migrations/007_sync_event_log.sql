CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  uploaded_at TEXT,
  UNIQUE(device_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_sync_events_outbox ON sync_events(uploaded_at, device_id, sequence);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS sync_events_no_update BEFORE UPDATE ON sync_events
WHEN OLD.id != NEW.id OR OLD.device_id != NEW.device_id OR OLD.sequence != NEW.sequence OR OLD.occurred_at != NEW.occurred_at OR OLD.kind != NEW.kind OR OLD.payload_json != NEW.payload_json
BEGIN SELECT RAISE(ABORT, 'sync_events are immutable'); END;
