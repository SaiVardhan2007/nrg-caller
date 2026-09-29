-- SB Classes (FNRG Sadhana > SB Classes): YouTube class links organized into
-- playlists, each tracked with category (playlist), recommend level (0-3),
-- and completion status.

create table if not exists sb_class_playlists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table sb_class_playlists enable row level security;
drop policy if exists app_all on sb_class_playlists;
create policy app_all on sb_class_playlists for all to anon, authenticated using (true) with check (true);

create table if not exists sb_class_videos (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references sb_class_playlists(id) on delete cascade,
  title text not null,
  youtube_url text not null,
  class_date date,
  recommend_level smallint not null default 0 check (recommend_level between 0 and 3),
  completion_status text not null default 'not_started' check (completion_status in ('not_started', 'partially_completed', 'completed')),
  added_by text,
  created_at timestamptz not null default now()
);

alter table sb_class_videos enable row level security;
drop policy if exists app_all on sb_class_videos;
create policy app_all on sb_class_videos for all to anon, authenticated using (true) with check (true);

create index if not exists sb_class_videos_playlist_idx on sb_class_videos(playlist_id);

-- Admin recommends a class to one or more specific users. No uniqueness
-- constraint: the same class can be (re-)recommended to the same or
-- different users more than once.
create table if not exists sb_class_recommendations (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references sb_class_videos(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  recommended_by text,
  recommended_at timestamptz not null default now()
);

alter table sb_class_recommendations enable row level security;
drop policy if exists app_all on sb_class_recommendations;
create policy app_all on sb_class_recommendations for all to anon, authenticated using (true) with check (true);

create index if not exists sb_class_recommendations_video_idx on sb_class_recommendations(video_id);
create index if not exists sb_class_recommendations_user_idx on sb_class_recommendations(user_id);

-- A user asks a doubt about a specific class, at a specific point in the
-- video (timestamp_label is free text, e.g. "12:34" or "1:02:15" — however
-- they choose to type it). Admin sees every doubt on the Doubts page, with a
-- link straight to the class so they can watch the moment in question.
create table if not exists sb_class_doubts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references sb_class_videos(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  timestamp_label text not null,
  doubt_text text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

alter table sb_class_doubts enable row level security;
drop policy if exists app_all on sb_class_doubts;
create policy app_all on sb_class_doubts for all to anon, authenticated using (true) with check (true);

create index if not exists sb_class_doubts_video_idx on sb_class_doubts(video_id);
create index if not exists sb_class_doubts_user_idx on sb_class_doubts(user_id);
