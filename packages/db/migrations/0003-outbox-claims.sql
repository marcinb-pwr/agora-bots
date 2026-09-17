ALTER TABLE outbox
  ADD COLUMN claim_id uuid,
  ADD COLUMN claimed_by text,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT outbox_claim_complete CHECK (
    (claim_id IS NULL AND claimed_by IS NULL AND claim_expires_at IS NULL) OR
    (claim_id IS NOT NULL AND length(claimed_by) > 0 AND claim_expires_at IS NOT NULL)
  );

DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox (topic, created_at, id)
  WHERE published_at IS NULL;
CREATE INDEX outbox_expired_claim_idx ON outbox (topic, claim_expires_at, created_at, id)
  WHERE published_at IS NULL AND claim_id IS NOT NULL;
