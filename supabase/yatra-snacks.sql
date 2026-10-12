-- Adds the "S" (Snacks) meal to Yatra attendance. Run once on the live database.
-- Meal codes: M = Breakfast (shown as B), L = Lunch, S = Snacks, D = Dinner.
alter table yatra_coupons drop constraint if exists yatra_coupons_meal_check;
alter table yatra_coupons add constraint yatra_coupons_meal_check check (meal in ('M','L','S','D'));
