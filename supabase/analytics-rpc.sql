-- Aggregated call-outcome counts for the Analytics / Reception Analytics tabs.
-- Previously the client fetched every matching call_responses row's `remarks`
-- just to count totals/positives — that costs more egress every month as the
-- permanent call log keeps growing. Counting server-side returns one tiny row
-- no matter how large call_responses gets.
--
-- Mirrors the positive-outcome list in admin.js's ANALYTICS_POSITIVE constant
-- ("joining the session", "next week will join", "will try to attend") — keep
-- the two in sync if that list ever changes.
create or replace function call_outcome_counts(
  p_caller_name text default null,
  p_event_code text default null,
  p_from_ts timestamptz default null,
  p_to_ts timestamptz default null
)
returns table (total bigint, positive bigint)
language sql
stable
as $$
  select
    count(*) as total,
    count(*) filter (
      where lower(remarks) in ('joining the session', 'next week will join', 'will try to attend')
    ) as positive
  from call_responses
  where (p_caller_name is null or caller_name = p_caller_name)
    and (p_event_code is null or event_code = p_event_code)
    and (p_from_ts is null or ts >= p_from_ts)
    and (p_to_ts is null or ts <= p_to_ts)
$$;

grant execute on function call_outcome_counts(text, text, timestamptz, timestamptz) to anon, authenticated;
