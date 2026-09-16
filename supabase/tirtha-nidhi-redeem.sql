-- Tirtha Nidhi: Redeem requests. A user can ask to redeem part of their
-- (or, org-wide for admin) Srila Prabhupada's Contribution; an admin reviews
-- each request and approves or rejects it. Only approved amounts count
-- against the "Redeemed"/"Remaining" figures shown in General Data/Tapasya.

create table if not exists tirtha_nidhi_redeem_requests (
  id                uuid primary key default gen_random_uuid(),
  user_name         text not null,
  requested_amount  numeric not null check (requested_amount > 0),
  approved_amount   numeric check (approved_amount >= 0),
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at      timestamptz not null default now(),
  reviewed_by       text,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_tirtha_nidhi_redeem_requests_user_name on tirtha_nidhi_redeem_requests(user_name);

alter table tirtha_nidhi_redeem_requests enable row level security;
drop policy if exists app_all on tirtha_nidhi_redeem_requests;
create policy app_all on tirtha_nidhi_redeem_requests for all to anon, authenticated using (true) with check (true);

-- touch_updated_at() is defined in schema.sql, applied before this file.
drop trigger if exists trg_tirtha_nidhi_redeem_requests_touch on tirtha_nidhi_redeem_requests;
create trigger trg_tirtha_nidhi_redeem_requests_touch before update on tirtha_nidhi_redeem_requests
  for each row execute function touch_updated_at();
