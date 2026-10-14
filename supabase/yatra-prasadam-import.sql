-- Imports the Vrindavan Yatra Prasadam 2026 sheet into the Prasadam Details tab.
-- Run supabase/yatra-prasadam.sql first. It adds the rows to the yatra whose
-- name starts with 'Vrindavan', and skips itself if that yatra already has prasadam rows.
-- Rows keep the sheet's order (position).
do $$
declare yid uuid;
begin
  select id into yid from yatras where name ilike 'Vrindavan%' order by created_at limit 1;
  if yid is null then raise exception 'No yatra whose name starts with Vrindavan was found'; end if;
  if exists (select 1 from yatra_prasadam where yatra_id = yid) then
    raise notice 'This yatra already has prasadam rows - nothing imported';
    return;
  end if;
  insert into yatra_prasadam
    (yatra_id, meal_date, meal_type, for_how_many, menu, vendor, delivery_location, delivery_time, packing_method, serving_location, serving_method, items_required, remarks, position)
  select yid, v.meal_date::date, v.meal_type, v.for_how_many::numeric, v.menu, v.vendor, v.delivery_location, v.delivery_time::time, v.packing_method, v.serving_location, v.serving_method, v.items_required, v.remarks, v.position::double precision from (values
  ('2026-10-18', 'Snacks', 100, 'Mixture with dryfruit 10 kg', 'SRLAP', 'SRLAP', '10:00', null, null, null, null, null, 1),
  ('2026-10-18', 'Snacks', 100, 'Chocolate Cookies 200 pcs', 'SRLAP', 'SRLAP', '10:00', null, null, null, null, null, 2),
  ('2026-10-18', 'Snacks', 100, 'Sweet Kachori (Dry Coconut) 200 pcs', 'SRLAP', 'SRLAP', '10:00', null, null, null, null, null, 3),
  ('2026-10-18', 'Snacks', 100, 'Mini Dry Samosa 300 pcs', 'SRLAP', 'SRLAP', '10:00', null, null, null, null, null, 4),
  ('2026-10-18', 'Snacks', 100, 'Ekadashi Peanut Laddu 120pcs
(Pack in Plastic Box)', 'SRLAP', 'SRLAP', '10:00', null, null, null, null, null, 5),
  ('2026-10-20', 'Breakfast', 100, 'Tomato Bhat 350gm
Biriyani salan 120gm
Buttermilk 250 ml
Pineapple Kesari 120', 'SRLAP
(5 Section Bento Box Packing)', 'SRLAP', '04:00', 'Individual Bento 
Box Packing', null, null, null, null, 6),
  ('2026-10-20', 'Lunch', 100, 'Chintapandu Pulihora 300gm
Lemon Rice 1KG
Tamato chutney 100gm
Aalo deep fry 200gm
Triangle paratha 2
Nanari Sharbat 250ml 
Kala jamun 1 pc
Curd packet 100ml (115 packets)', 'SRLAP
(8 Section Bento Box Packing)', 'SRLAP', '04:00', 'Individual Bento 
Box Packing', null, null, null, null, 7),
  ('2026-10-20', 'Dinner', 100, 'Rs. 145/- 
Rice 300gm
Dal 150gm 
Chapati 2 
Mix Veg Sabji 200gm', 'Sagar Tandekar
8329616034', 'Nagpur Rly Stn

Telangana Exp (12723)', '15:20', 'Individual Bento 
Box Packing', 'Train 
Telangana Exp (12723)', 'Individual Bento 
Box Packing', 'Wooden Spoons
Tissue Papers', null, 8),
  ('2026-10-21', 'Breakfast', 100, 'Idly - 5pc
Vegetable Sambar - 250gm
Peanut/ Coconut Chutney - 200gm
Buttermilk - 250ml', 'PMBP
8184913970', 'VCM', '08:00', null, null, null, null, null, 9),
  ('2026-10-21', 'Lunch', 100, 'Triangle Paratha 1pc
Navaratan Pulav 350gm
Samosa with Chutny
Veg Kurma 200gm
Sweet 1pc
Rose Sharbat 250ml
Curd Rice with Fruits 120gm', 'PMBP
8184913970', 'VCM', '12:30', null, null, null, null, null, 10),
  ('2026-10-21', 'Dinner', 100, 'Mix Veg Khichdi 350gm
Fryms - 50gm
Ghee Chappati 2pc
Beans Poriyal 150gm', 'PMBP
8184913970', 'PMBP Guest House', '18:30', null, null, null, null, null, 11),
  ('2026-10-22', 'Breakfast', 100, 'Banana - 3pc
Watermelon - 150gm
Boiled Peanuts with Grated Cucumber & Carrot - 150gm
Buttermilk - 250ml', 'PMBP
8184913970', 'VCM', '08:00', null, null, null, null, null, 12),
  ('2026-10-22', 'Lunch', 100, 'Mix Veg Sabudana Pulav 250gm
Mix Veg Paneer Gravy 150gm
Curd Sabudana 150gm
Cabbage Pakoda 80gm
Lemon Mint Juice 250ml', 'PMBP
8184913970', 'VCM', '12:30', null, null, null, null, null, 13),
  ('2026-10-22', 'Dinner', 100, 'Carrot & Cucumber slices 75gm
Mix Veg Sabudana Pulav 250gm
Dosakay Koora 150m
Vegetable Soup 250ml', 'PMBP
8184913970', 'PMBP Guest House', '18:30', null, null, null, null, null, 14),
  ('2026-10-23', 'Breakfast', 100, 'Veg Uttapam - 4pc
Peanut Chutney - 250gm
Buttermilk - 250ml', 'PMBP
8184913970', 'VCM', '08:00', null, null, null, null, null, 15),
  ('2026-10-23', 'Lunch', 100, 'Not Required / Annadan at Ramanreti', 'Murari Lal Raman Reti
9634505128', 'Raman Reti', '12:30', null, null, null, null, null, 16),
  ('2026-10-23', 'Dinner', 100, 'Rice 400gm
Tomato Pesarapappu 175 gm
Ghee Chappati 2pc
Alu Menthakura Dum Fry 175 gm', 'PMBP
8184913970', 'PMBP Guest House', '18:30', null, null, null, null, null, 17),
  ('2026-10-24', 'Breakfast', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 18),
  ('2026-10-24', 'Lunch', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 19),
  ('2026-10-24', 'Dinner', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 20),
  ('2026-10-25', 'Breakfast', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 21),
  ('2026-10-25', 'Lunch', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 22),
  ('2026-10-25', 'Dinner', 100, 'Tattava Retreat', 'N/A', 'N/A', null, null, null, null, null, null, 23),
  ('2026-10-26', 'Breakfast', 100, 'Bisi bele bath - 400gm
Khara Bundi - 75gm
Buttermilk - 250ml', 'PMBP
8184913970', 'VCM', '08:00', null, null, null, null, null, 24),
  ('2026-10-26', 'Lunch', 100, 'Methi Paratha 1pc
Paneer Khurma 200gm
Special Pulav 350gm
Stuffed Mirchi Bajji & Lemon 1pc
Double ka Meetha 120gm
Muskmelon Juice 250ml
Curd rice with fruits 120gm', 'PMBP
8184913970', 'Radha Kund', '12:30', null, null, null, null, null, 25),
  ('2026-10-26', 'Dinner', 100, 'Note required / FG Party', 'FG', 'VCM', '18:30', null, null, null, null, null, 26),
  ('2026-10-27', 'Breakfast', 100, 'Vegetable Poha 350 gm
Kadhi 150gm
Butter milk 250 ml', 'YTD', 'Bina Jn Rly Stn
Train 
Dakshin Exp (12722)', '07:25', 'Individual Bento 
Box Packing', 'Train 
Dakshin Exp (12722)', 'Individual Bento 
Box Packing', 'Wooden Spoons
Tissue Papers', null, 27),
  ('2026-10-27', 'Lunch', 100, 'Rs 160/-
Rice 300gm
Dal 150gm
Chapthi 2 
Allo Chole Sabji 200gm
Butter Milk 250 ml
Gulabjanum 1 PC', 'Yamuna Tatchar 
Mathaji 
62639 07840
91797 38142', 'Itarsi Rly Stn
Train 
Dakshin Exp (12722)', '11:50', 'Individual Bento 
Box Packing', 'Train 
Dakshin Exp (12722)', 'Individual Bento 
Box Packing', 'Wooden Spoons
Tissue Papers', null, 28),
  ('2026-10-27', 'Dinner', 100, 'Rs. 145/- 
Rice 300gm
Dal 150gm 
Chapati 2 
Mix Veg Sabji 200gm', 'Sagar Tandekar
8329616034', 'Nagpur Rly Stn
Train 
Dakshin Exp (12722)', '17:05', 'Individual Bento 
Box Packing', 'Train 
Dakshin Exp (12722)', 'Individual Bento 
Box Packing', 'Wooden Spoons
Tissue Papers', null, 29)
  ) as v(meal_date, meal_type, for_how_many, menu, vendor, delivery_location, delivery_time, packing_method, serving_location, serving_method, items_required, remarks, position);
end $$;
