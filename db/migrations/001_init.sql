-- toll-sim back office: core schema.
-- Money is stored as integer thebe (1 BWP = 100 thebe) everywhere.

CREATE TABLE vehicle_classes (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL
);

CREATE TABLE gantries (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  road      text NOT NULL,
  km        numeric(6,1) NOT NULL,
  direction text NOT NULL CHECK (direction IN ('N', 'S', 'both')),
  lat       double precision,
  lng       double precision,
  active    boolean NOT NULL DEFAULT true
);

-- Tariffs are versioned: a new price closes the previous row (valid_to) rather
-- than overwriting it, so any historic passage can be re-rated exactly.
CREATE TABLE tariffs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gantry_id     text NOT NULL REFERENCES gantries(id),
  vehicle_class text NOT NULL REFERENCES vehicle_classes(code),
  amount_thebe  integer NOT NULL CHECK (amount_thebe >= 0),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX tariffs_lookup ON tariffs (gantry_id, vehicle_class, valid_from DESC);

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_name   text NOT NULL,
  phone         text,
  email         text,
  balance_thebe integer NOT NULL DEFAULT 0 CHECK (balance_thebe >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  plate         text NOT NULL,
  vehicle_class text NOT NULL REFERENCES vehicle_classes(code),
  tag_id        text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- A plate or tag can belong to only one live registration at a time.
CREATE UNIQUE INDEX vehicles_plate_active ON vehicles (plate) WHERE active;
CREATE UNIQUE INDEX vehicles_tag_active ON vehicles (tag_id) WHERE active AND tag_id IS NOT NULL;
CREATE INDEX vehicles_account ON vehicles (account_id);

CREATE TABLE passages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gantry_id       text NOT NULL REFERENCES gantries(id),
  source_event_id text NOT NULL,
  passed_at       timestamptz NOT NULL,
  plate_read      text,
  tag_id          text,
  read_confidence real,
  detected_class  text REFERENCES vehicle_classes(code),
  vehicle_id      uuid REFERENCES vehicles(id),
  account_id      uuid REFERENCES accounts(id),
  charged_class   text NOT NULL REFERENCES vehicle_classes(code),
  amount_thebe    integer NOT NULL CHECK (amount_thebe >= 0),
  status          text NOT NULL CHECK (status IN ('charged', 'unpaid', 'waived')),
  match_method    text NOT NULL CHECK (match_method IN ('tag', 'plate', 'none')),
  class_mismatch  boolean NOT NULL DEFAULT false,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- Gantries retry on network failure; the same event must never be billed twice.
  UNIQUE (gantry_id, source_event_id)
);
CREATE INDEX passages_account ON passages (account_id, passed_at);
CREATE INDEX passages_plate ON passages (plate_read);

CREATE TABLE topups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  provider        text NOT NULL CHECK (provider IN ('orange_money', 'myzaka', 'smega', 'card')),
  amount_thebe    integer NOT NULL CHECK (amount_thebe > 0),
  payer           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_ref    text,
  failure_reason  text,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE UNIQUE INDEX topups_provider_ref ON topups (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX topups_pending ON topups (created_at) WHERE status = 'pending';

CREATE TABLE ledger_entries (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id),
  kind          text NOT NULL CHECK (kind IN ('topup', 'toll', 'adjustment')),
  amount_thebe  integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  passage_id    uuid REFERENCES passages(id),
  topup_id      uuid REFERENCES topups(id),
  description   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_account ON ledger_entries (account_id, id);
-- Database-level guards against double charging and double crediting.
CREATE UNIQUE INDEX ledger_one_toll_per_passage ON ledger_entries (passage_id) WHERE kind = 'toll';
CREATE UNIQUE INDEX ledger_one_credit_per_topup ON ledger_entries (topup_id) WHERE kind = 'topup';

CREATE TABLE violations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passage_id       uuid NOT NULL UNIQUE REFERENCES passages(id),
  plate            text,
  account_id       uuid REFERENCES accounts(id),
  reason           text NOT NULL CHECK (reason IN ('insufficient_funds', 'unregistered_vehicle', 'account_inactive')),
  amount_due_thebe integer NOT NULL CHECK (amount_due_thebe >= 0),
  due_by           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'waived')),
  resolution_note  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX violations_open ON violations (account_id, created_at) WHERE status = 'open';
CREATE INDEX violations_plate ON violations (plate) WHERE status = 'open';

-- Append-only audit log with a hash chain. Each row's hash covers the previous
-- row's hash, so editing or deleting any row (even with the triggers disabled)
-- breaks verification from that point on.
CREATE TABLE audit_log (
  seq         integer PRIMARY KEY,
  at          timestamptz NOT NULL,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE INDEX audit_entity ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_row_digest(prev text, at timestamptz, actor text, action text,
                                 entity_type text, entity_id text, data jsonb)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    prev,
    to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    actor, action, entity_type, entity_id, data::text), 'UTF8')), 'hex')
$$;

-- seq and the chain link are assigned under an advisory lock, so concurrent
-- writers cannot fork the chain.
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  integer;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(74610001);
  SELECT seq, hash INTO last_seq, last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq       := coalesce(last_seq, 0) + 1;
  NEW.at        := clock_timestamp();
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash      := audit_row_digest(NEW.prev_hash, NEW.at, NEW.actor, NEW.action,
                                    NEW.entity_type, NEW.entity_id, NEW.data);
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
