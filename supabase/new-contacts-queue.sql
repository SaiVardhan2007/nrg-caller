-- APPLIED to the live database on 2026-08-02. Kept as the record of the
-- change, and for rebuilding the schema from scratch.
--
-- New contacts added from Reception, Contact Collection and Master Contact no
-- longer land straight in `contacts` — they queue in `contact_collection` and
-- an admin promotes them from the New Contacts page. That means this table now
-- has to hold every field those three forms collect, and can no longer demand
-- profession/gender (Reception and Master Contact don't always ask for them).

alter table contact_collection alter column profession drop not null;
alter table contact_collection alter column gender     drop not null;

alter table contact_collection add column if not exists ws              text;
alter table contact_collection add column if not exists company_name    text;
alter table contact_collection add column if not exists calling_purpose text;
alter table contact_collection add column if not exists gyc_status      text;
alter table contact_collection add column if not exists admin_tag       text;
alter table contact_collection add column if not exists admin_tag_to_users text;
alter table contact_collection add column if not exists core_cultivation   text;
alter table contact_collection add column if not exists source          text;

-- Older databases may predate the One to One answer column; without it the
-- help-requests lists error out and render as "no questions asked", and the
-- admin's response never saves.
alter table help_requests add column if not exists response text;
