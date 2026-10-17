-- Travel Info: the journey date now also carries a time. Existing dates keep working (they become midnight).
alter table yatra_travel alter column journey_date type timestamp using journey_date::timestamp;
