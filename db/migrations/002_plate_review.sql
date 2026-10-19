-- Manual review of low-confidence plate reads.
--
-- A camera read the ANPR model is unsure of, with no tag to back it up, is not
-- charged to whoever owns the plate it guessed, and it does not raise a
-- violation against a plate that may belong to someone else. The passage waits
-- in status 'review' until a person confirms the read, corrects it, or marks it
-- unreadable. Only then is it rated, exactly as an automatic read would be.

ALTER TABLE passages DROP CONSTRAINT passages_status_check;
ALTER TABLE passages ADD CONSTRAINT passages_status_check
  CHECK (status IN ('charged', 'unpaid', 'waived', 'review'));

-- 'manual': the plate was settled by a reviewer, not by the camera alone.
ALTER TABLE passages DROP CONSTRAINT passages_match_method_check;
ALTER TABLE passages ADD CONSTRAINT passages_match_method_check
  CHECK (match_method IN ('tag', 'plate', 'manual', 'none'));

CREATE TABLE plate_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passage_id      uuid NOT NULL UNIQUE REFERENCES passages(id),
  plate_read      text,
  read_confidence real,
  -- The model's runner-up readings, [{plate, confidence}], best first.
  candidates      jsonb NOT NULL DEFAULT '[]',
  -- The plate crop the camera sent. Kept only for passages under review.
  image           bytea,
  image_type      text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  decision        text CHECK (decision IN ('confirmed', 'corrected', 'unreadable')),
  resolved_plate  text,
  reviewer        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CHECK ((status = 'open') = (decision IS NULL))
);
CREATE INDEX plate_reviews_open ON plate_reviews (created_at) WHERE status = 'open';
