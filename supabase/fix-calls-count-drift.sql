-- Fixes the "badge says 2 calls, detail view shows 1" bug.
--
-- contacts.calls_count is a denormalized counter bumped by an AFTER INSERT
-- trigger on call_responses, but there was never a matching AFTER DELETE
-- trigger to decrement it (unlike sessions_count, which already has
-- unbump_sessions_count). The admin bulk-delete-call-responses tool deletes
-- rows directly, so calls_count drifts upward and never recovers while the
-- click-through detail view queries call_responses live and shows the true,
-- smaller count.
--
-- This file (1) reconciles every contact's calls_count to the real row count
-- right now, and (2) adds the missing unbump trigger so it can't drift again.
-- Safe to re-run.

update contacts c
set calls_count = coalesce((
  select count(*) from call_responses r where r.mob_no = c.mob_no
), 0)
where calls_count is distinct from coalesce((
  select count(*) from call_responses r where r.mob_no = c.mob_no
), 0);

create or replace function unbump_calls_count() returns trigger language plpgsql as $$
begin
  update contacts set calls_count = greatest(calls_count - 1, 0) where mob_no = old.mob_no;
  return old;
end $$;

drop trigger if exists trg_calls_unbump on call_responses;
create trigger trg_calls_unbump after delete on call_responses
  for each row execute function unbump_calls_count();
