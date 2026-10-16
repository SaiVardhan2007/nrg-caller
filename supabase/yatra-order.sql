-- Lets FOLK Yatra cards be dragged into a custom order (never-moved yatras sort last).
alter table yatras add column if not exists position double precision;
