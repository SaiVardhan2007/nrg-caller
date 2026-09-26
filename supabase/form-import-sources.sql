-- Form Import — one row per connected Google Form response sheet ("source").
-- Run this once manually in the Supabase SQL editor.

create table if not exists form_import_sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  sheet_id          text not null,
  tab_name          text,
  column_mapping    jsonb not null default '{}',
  timestamp_column  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_form_import_sources_created_at
  on form_import_sources(created_at desc);
