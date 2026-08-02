-- Run this once in the Supabase SQL editor.
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
-- help-requests modal errors out and renders as "no questions asked".
alter table help_requests add column if not exists response text;
