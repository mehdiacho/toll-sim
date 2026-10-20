-- Mainline toll plazas replace the open-road gantries.
--
-- The three sites on the A1 become South African-style plazas: five lanes per
-- direction behind booms. Tagged vehicles pay from their account as before
-- (a tag read at the boom is a passage). Everyone else stops at a booth and
-- pays cash or card: a plaza transaction, with no account behind it. The plate
-- camera stays, to audit tag reads (wrong plate, wrong class) and to catch
-- boom runners, which go through the review queue and the enforcement ladder
-- like any other unpaid passage.

ALTER TABLE gantries
  ADD COLUMN kind  text NOT NULL DEFAULT 'gantry' CHECK (kind IN ('gantry', 'plaza')),
  ADD COLUMN lanes smallint CHECK (lanes > 0);

-- Positions from sim/build_network.py once the plazas were cut into the road
-- (Artesia moved about a kilometre so its approach fits on one stretch).
UPDATE gantries SET kind = 'plaza', lanes = 5;
UPDATE gantries SET km = 11.8,  lat = -24.520968, lng = 26.001583 WHERE id = 'A1-G01';
UPDATE gantries SET km = 74.5,  lat = -24.042102, lng = 26.307264 WHERE id = 'A1-G02';
UPDATE gantries SET km = 108.3, lat = -23.773491, lng = 26.458261 WHERE id = 'A1-G03';

-- A passage at a plaza records the lane, the direction and how the boom was
-- passed: 'tag' (paid, or declined, from the account) or 'runner' (drove
-- through without paying). Open-road reads leave these null.
ALTER TABLE passages
  ADD COLUMN plaza_lane         smallint CHECK (plaza_lane >= 0),
  ADD COLUMN direction          text CHECK (direction IN ('N', 'S')),
  ADD COLUMN payment_method     text CHECK (payment_method IN ('tag', 'runner')),
  -- A tag the account could not pay for: the boom stays down and the driver
  -- pays at the booth instead. No violation, nothing owed.
  ADD COLUMN decline_reason     text CHECK (decline_reason IN ('insufficient_funds', 'account_inactive', 'tag_not_found')),
  -- The camera read a different plate from the one the tag is registered to.
  ADD COLUMN tag_plate_mismatch boolean NOT NULL DEFAULT false;

ALTER TABLE passages DROP CONSTRAINT passages_status_check;
ALTER TABLE passages ADD CONSTRAINT passages_status_check
  CHECK (status IN ('charged', 'unpaid', 'waived', 'review', 'refunded', 'declined'));
ALTER TABLE passages ADD CONSTRAINT passages_declined_has_reason
  CHECK ((status = 'declined') = (decline_reason IS NOT NULL));
CREATE INDEX passages_plaza_time ON passages (gantry_id, passed_at) WHERE payment_method IS NOT NULL;

ALTER TABLE violations DROP CONSTRAINT violations_reason_check;
ALTER TABLE violations ADD CONSTRAINT violations_reason_check
  CHECK (reason IN ('insufficient_funds', 'unregistered_vehicle', 'account_inactive', 'boom_runner'));

-- Cash and card taken at a booth. There is no account: the booth classifies
-- the vehicle, the tariff prices it, and the money is the plaza's. Rows are
-- never changed or deleted, like the ledger.
CREATE TABLE plaza_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plaza_id            text NOT NULL REFERENCES gantries(id),
  source_event_id     text NOT NULL,
  lane                smallint NOT NULL CHECK (lane >= 0),
  direction           text NOT NULL CHECK (direction IN ('N', 'S')),
  method              text NOT NULL CHECK (method IN ('cash', 'card')),
  vehicle_class       text NOT NULL REFERENCES vehicle_classes(code),
  amount_thebe        integer NOT NULL CHECK (amount_thebe >= 0),
  tariff_id           uuid REFERENCES tariffs(id),
  transacted_at       timestamptz NOT NULL,
  -- What the plate camera saw, kept for audit only: nobody is billed from it.
  plate_read          text,
  read_confidence     real,
  -- Set when a tag was declined at the boom and the driver then paid here.
  declined_passage_id uuid REFERENCES passages(id),
  received_at         timestamptz NOT NULL DEFAULT now(),
  -- The booth retries on network failure; a payment is recorded once.
  UNIQUE (plaza_id, source_event_id)
);
CREATE INDEX plaza_transactions_time ON plaza_transactions (plaza_id, transacted_at);
CREATE UNIQUE INDEX plaza_transactions_one_per_decline ON plaza_transactions (declined_passage_id)
  WHERE declined_passage_id IS NOT NULL;
CREATE TRIGGER plaza_transactions_append_only BEFORE UPDATE OR DELETE ON plaza_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER plaza_transactions_no_truncate BEFORE TRUNCATE ON plaza_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- South African plazas charge motorcycles the Class 1 (light vehicle) toll.
-- Close the old motorcycle prices and charge the Class 1 price from now on.
-- (A fresh database has no tariffs yet at this point; db/seed.sql already
-- prices M like Class 1.)
WITH light AS (
  SELECT gantry_id, amount_thebe FROM tariffs
  WHERE vehicle_class = '1' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
), closed AS (
  UPDATE tariffs t SET valid_to = now()
  FROM light
  WHERE t.gantry_id = light.gantry_id AND t.vehicle_class = 'M' AND t.valid_to IS NULL
    AND t.valid_from < now() AND t.amount_thebe <> light.amount_thebe
  RETURNING t.gantry_id
)
INSERT INTO tariffs (gantry_id, vehicle_class, amount_thebe, valid_from)
SELECT light.gantry_id, 'M', light.amount_thebe, now() FROM light JOIN closed USING (gantry_id);
