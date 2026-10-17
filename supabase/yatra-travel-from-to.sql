-- Travel Info: "From - To" becomes two fields, From and To.
alter table yatra_travel add column if not exists from_place text;
alter table yatra_travel add column if not exists to_place text;

-- carry over anything already typed as "A - B" / "A to B"
update yatra_travel
set from_place = trim(split_part(regexp_replace(from_to, '\s+to\s+', ' - ', 'i'), ' - ', 1)),
    to_place   = nullif(trim(substr(regexp_replace(from_to, '\s+to\s+', ' - ', 'i'), strpos(regexp_replace(from_to, '\s+to\s+', ' - ', 'i'), ' - ') + 3)), '')
where from_to is not null and from_place is null and to_place is null
  and regexp_replace(from_to, '\s+to\s+', ' - ', 'i') like '% - %';
