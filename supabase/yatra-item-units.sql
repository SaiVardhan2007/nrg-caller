-- Unit now also allows Liter / Kg / Gm, and Cooking / Serving items use it too.
alter table yatra_items drop constraint if exists yatra_items_unit_check;
alter table yatra_items add constraint yatra_items_unit_check
  check (unit in ('Number','Pieces','Packets','Bags','Liter','Kg','Gm'));
