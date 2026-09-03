-- 090: live print v2, slice C (spec §4.3, §5).
-- The "print is live" go action needs: a once-only forced-open stamp and a
-- stackable extension on the print row, and a durable, claimable request
-- row per press. Additive only (no rebuild): 089's document/lines rebuild
-- is untouched. Timestamps on these columns are ISO-8601 UTC strings written
-- by code (`toISOString()`), read with Date.parse — never datetime('now')
-- text, so the window arithmetic never mixes the two clocks.
--
-- print_id has NO ON DELETE CASCADE on purpose: a go row must never vanish
-- silently. Slice C's event-merge handler repoints these rows to the
-- surviving print BEFORE slice B's handler deletes a donor print (it is
-- registered ahead of B's for exactly that reason).

ALTER TABLE print_watch_prints ADD COLUMN forced_open_at TEXT;
ALTER TABLE print_watch_prints ADD COLUMN window_extended_until TEXT;

CREATE TABLE print_watch_go_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  print_id         INTEGER NOT NULL REFERENCES print_watch_prints(id),
  status           TEXT    NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','claimed','done','failed')),
  requested_at     TEXT    NOT NULL,
  input_kind       TEXT    NOT NULL DEFAULT 'none'
                           CHECK (input_kind IN ('none','url','file')),
  input_url        TEXT,
  input_sha256     TEXT,
  input_bytes_path TEXT,
  claim_token      TEXT,
  claimed_at       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  result_json      TEXT,
  finished_at      TEXT,
  CHECK (
    (input_kind = 'none' AND input_url IS NULL AND input_sha256 IS NULL AND input_bytes_path IS NULL) OR
    (input_kind = 'url'  AND input_url IS NOT NULL) OR
    (input_kind = 'file' AND input_sha256 IS NOT NULL AND input_bytes_path IS NOT NULL)
  )
);
CREATE INDEX idx_pw_go_requests_print  ON print_watch_go_requests(print_id, id);
CREATE INDEX idx_pw_go_requests_status ON print_watch_go_requests(status, claimed_at);
