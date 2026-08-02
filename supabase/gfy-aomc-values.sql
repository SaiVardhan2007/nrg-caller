-- APPLIED to the live database on 2026-08-02. Kept as the record of the
-- change, and for rebuilding the schema from scratch.
--
-- contacts.gyc_status carried a CHECK constraint pinned to the original four
-- values, so saving any of the new GFY/AOMC states was rejected outright —
-- that is the "Could not save GFY status." error on the call cards.
--
-- Existing rows are mapped onto the new values first, because adding the new
-- constraint re-validates every row and would fail while old values remain.
-- "Not Registered" was dropped from the list entirely, so those rows are
-- cleared. Adjust the mapping below before running if you want them elsewhere.

alter table contacts drop constraint if exists contacts_gyc_status_check;

update contacts set gyc_status = 'Attended GFY'      where gyc_status = 'Attended';
update contacts set gyc_status = 'Intrested GFY'     where gyc_status = 'Registered';
update contacts set gyc_status = 'Not Intrested GFY' where gyc_status = 'Not Intrested';
update contacts set gyc_status = null                where gyc_status = 'Not Registered';

alter table contacts add constraint contacts_gyc_status_check
  check (gyc_status in (
    'Intrested GFY', 'Not Intrested GFY', 'Attended GFY',
    'Intrested AOMC', 'Not Intrested AOMC', 'Attended AOMC'
  ));

-- The auto-assign trigger's GFY filter matched the bare literal 'Attended'.
-- Re-run supabase/auto-assign-trigger.sql after this to pick up 'Attended GFY'.
