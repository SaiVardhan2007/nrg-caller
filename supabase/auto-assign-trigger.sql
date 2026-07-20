-- NRG Caller — continuous auto-assign.
-- Whenever a contact is inserted or edited (e.g. calling_purpose/admin_tag
-- changed via inline edit, or a fresh row from CSV import) so that it now
-- matches the currently active event + tag filter, assign it right away
-- instead of waiting for the next manual "Assign Contacts" click.
--
-- Core Cultivation is never touched by this trigger — that link is admin-only
-- (set by choosing a Core Cultivation in Master Contact, which creates the
-- assignment directly from the app). Otherwise the contact goes to whichever
-- eligible user currently has the fewest assignments for this event, skipping
-- anyone already at their call_limit.

create or replace function auto_assign_new_contact() returns trigger language plpgsql as $$
declare
  cur_event text;
  tag_filter_raw text;
  tag_list text[];
  target_user text;
begin
  select value into cur_event from settings where key = 'current_event';
  if cur_event is null or cur_event = '' or new.calling_purpose is distinct from cur_event then
    return new;
  end if;
  if new.admin_tag = 'Don''t Call' or new.admin_tag = 'Coordinator' then
    return new;
  end if;
  if new.core_cultivation is not null then
    return new;
  end if;

  select value into tag_filter_raw from settings where key = 'tag_filter';
  if tag_filter_raw is not null and length(trim(tag_filter_raw)) > 0 then
    select array_agg(trim(x)) into tag_list from unnest(string_to_array(tag_filter_raw, ',')) as x;
    if new.admin_tag is null or not (new.admin_tag = any(tag_list)) then
      return new;
    end if;
  end if;

  -- already assigned for this event? nothing to do
  if exists (select 1 from assignments where contact_id = new.id and event_code = cur_event) then
    return new;
  end if;

  select u.user_name into target_user
  from users u
  left join (
    select user_name, count(*) as c from assignments where event_code = cur_event group by user_name
  ) a on a.user_name = u.user_name
  where u.role = 'Coordinator' and u.auto_assign = true
    and (u.call_limit is null or coalesce(a.c, 0) < u.call_limit)
  order by coalesce(a.c, 0) asc, u.user_name asc
  limit 1;

  if target_user is not null then
    insert into assignments (contact_id, user_name, event_code) values (new.id, target_user, cur_event)
      on conflict (contact_id, event_code) do nothing;
  end if;

  return new;
end $$;

drop trigger if exists trg_auto_assign_new_contact on contacts;
create trigger trg_auto_assign_new_contact after insert or update on contacts
  for each row execute function auto_assign_new_contact();
