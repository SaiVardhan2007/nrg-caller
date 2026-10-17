-- Travel Info: Train Number and Ticket Status (Confirmed / RAC / Waiting List / Cancelled / Not Booked).
alter table yatra_travel add column if not exists train_number text;
alter table yatra_travel add column if not exists ticket_status text;
