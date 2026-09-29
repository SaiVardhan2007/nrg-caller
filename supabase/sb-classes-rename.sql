-- One-time migration: renames the already-created SP Classes tables/indexes
-- to their new SB Classes names, to match the sb_class_* names the app code
-- now queries after the SP -> SB rename. Run this once in the Supabase SQL
-- editor (or via the pooler) — RLS policies move with the table automatically,
-- no separate action needed for those.

alter table sp_class_playlists rename to sb_class_playlists;
alter table sp_class_videos rename to sb_class_videos;
alter table sp_class_recommendations rename to sb_class_recommendations;
alter table sp_class_doubts rename to sb_class_doubts;

alter index sp_class_videos_playlist_idx rename to sb_class_videos_playlist_idx;
alter index sp_class_recommendations_video_idx rename to sb_class_recommendations_video_idx;
alter index sp_class_recommendations_user_idx rename to sb_class_recommendations_user_idx;
alter index sp_class_doubts_video_idx rename to sb_class_doubts_video_idx;
alter index sp_class_doubts_user_idx rename to sb_class_doubts_user_idx;
