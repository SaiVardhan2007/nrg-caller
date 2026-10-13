-- Feedback entries get a category.
alter table yatra_feedback add column if not exists category text;
