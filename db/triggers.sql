-- Append-only guard for `servicing_event`.
--
-- Postgres enforces this with a `BEFORE UPDATE OR DELETE` trigger calling a
-- `forbid_mutation()` function (see the source schema, §7). SQLite has no
-- stored functions, so the guard is inlined directly into each trigger body.
-- Applied idempotently by `db/client.ts` on every connection — drizzle-kit
-- does not manage triggers, so this file is hand-maintained.

create trigger if not exists servicing_event_no_update
before update on servicing_event
begin
  select raise(abort, 'servicing_event is append-only');
end;

create trigger if not exists servicing_event_no_delete
before delete on servicing_event
begin
  select raise(abort, 'servicing_event is append-only');
end;
