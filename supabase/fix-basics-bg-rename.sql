-- One-time repair: outward sales still use the old "Basics of Bhagavad Gita" name.
-- 1) Preview what will change:
select name, language, count(*) from book_outward_stock where name ilike 'Basics of Bhagavad Gita%' group by 1,2;
select name, language, count(*) from book_inward_stock where name ilike 'Basics of BG%' group by 1,2;

-- 2) Apply (only affects the renamed books' outward rows):
update book_outward_stock
   set name = regexp_replace(name, '^Basics of Bhagavad Gita', 'Basics of BG', 'i')
 where name ilike 'Basics of Bhagavad Gita%';
