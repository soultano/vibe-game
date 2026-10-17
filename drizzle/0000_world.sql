CREATE TABLE records (
  key TEXT PRIMARY KEY NOT NULL,
  json TEXT NOT NULL CHECK (json_valid(json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX records_updated_idx ON records (updated);
--> statement-breakpoint
-- Intentionally empty except inside an atomic D1 batch. A failed assertion
-- aborts the whole transaction, providing compare-and-swap across documents.
CREATE TABLE _atomic_guard (
  assertion INTEGER NOT NULL CHECK (assertion = 1)
);
