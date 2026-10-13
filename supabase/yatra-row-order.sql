-- FOLK Yatras: custom row order. Lets admins drag rows on the Dashboard,
-- Disposables, Cooking / Serving Items and Feedback tabs; the order is stored
-- in `position` (rows without one sort last, oldest first).

alter table yatra_participants add column if not exists position double precision;
alter table yatra_items        add column if not exists position double precision;
alter table yatra_feedback     add column if not exists position double precision;
