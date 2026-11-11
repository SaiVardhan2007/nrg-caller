-- Tirtha Nidhi: reason for an admin withdrawal.
alter table tirtha_nidhi_redeem_requests add column if not exists reason text;
