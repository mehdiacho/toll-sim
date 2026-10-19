-- Step 4: escalating enforcement of unpaid violations, motorist disputes, and
-- the customer app's sign-in.

-- Enforcement ladder: grace -> notice (admin fee) -> final_notice (late fee)
-- -> referred (plate goes on the roadside hotlist). Penalties are kept apart
-- from the toll itself so a statement shows exactly what each part was for.
ALTER TABLE violations
  ADD COLUMN stage            text NOT NULL DEFAULT 'grace'
    CHECK (stage IN ('grace', 'notice', 'final_notice', 'referred')),
  ADD COLUMN penalty_thebe    integer NOT NULL DEFAULT 0 CHECK (penalty_thebe >= 0),
  ADD COLUMN stage_changed_at timestamptz;
CREATE INDEX violations_escalation ON violations (due_by) WHERE status = 'open';

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_kind_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_kind_check
  CHECK (kind IN ('topup', 'toll', 'penalty', 'refund', 'adjustment'));
-- A passage's penalty is paid once, and a passage is refunded at most once.
CREATE UNIQUE INDEX ledger_one_penalty_per_passage ON ledger_entries (passage_id) WHERE kind = 'penalty';
CREATE UNIQUE INDEX ledger_one_refund_per_passage ON ledger_entries (passage_id) WHERE kind = 'refund';

ALTER TABLE passages DROP CONSTRAINT passages_status_check;
ALTER TABLE passages ADD CONSTRAINT passages_status_check
  CHECK (status IN ('charged', 'unpaid', 'waived', 'review', 'refunded'));

-- Every message the system sends: enforcement notices, sign-in codes, dispute
-- outcomes. Nothing leaves the building in this simulation; the outbox is the
-- record of what would have been sent, to whom, and why.
CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      text NOT NULL CHECK (channel IN ('sms', 'email', 'post')),
  recipient    text NOT NULL,
  account_id   uuid REFERENCES accounts(id),
  kind         text NOT NULL,
  subject      text,
  body         text NOT NULL,
  related_type text,
  related_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_account ON outbox (account_id, created_at DESC);
CREATE INDEX outbox_related ON outbox (related_type, related_id);

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passage_id      uuid NOT NULL REFERENCES passages(id),
  violation_id    uuid REFERENCES violations(id),
  account_id      uuid REFERENCES accounts(id),
  raised_by       text NOT NULL,
  reason          text NOT NULL CHECK (reason IN
                    ('not_my_vehicle', 'plate_misread', 'wrong_class', 'already_paid', 'vehicle_stolen', 'other')),
  description     text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'rejected')),
  corrected_class text REFERENCES vehicle_classes(code),
  refund_thebe    integer NOT NULL DEFAULT 0 CHECK (refund_thebe >= 0),
  resolution_note text,
  resolved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CHECK ((status = 'open') = (resolved_at IS NULL))
);
-- One live dispute per passage, and an upheld passage can't be disputed again.
CREATE UNIQUE INDEX disputes_one_open ON disputes (passage_id) WHERE status = 'open';
CREATE UNIQUE INDEX disputes_one_upheld ON disputes (passage_id) WHERE status = 'upheld';
CREATE INDEX disputes_queue ON disputes (created_at) WHERE status = 'open';
CREATE INDEX disputes_account ON disputes (account_id, created_at DESC);

CREATE TABLE dispute_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id   uuid NOT NULL REFERENCES disputes(id),
  filename     text NOT NULL,
  content_type text NOT NULL,
  data         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_evidence_dispute ON dispute_evidence (dispute_id);

-- Customer sign-in: a one-time code by SMS, then a bearer session. Only hashes
-- are stored, so a database leak hands out neither codes nor sessions.
CREATE TABLE login_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text NOT NULL,
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_phone ON login_codes (phone, created_at DESC);

CREATE TABLE customer_sessions (
  token_hash   text PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX accounts_phone ON accounts (phone);
