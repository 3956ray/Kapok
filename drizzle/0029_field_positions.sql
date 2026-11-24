ALTER TABLE profiles ADD COLUMN new_position TEXT NOT NULL DEFAULT ''
  CONSTRAINT profile_position CHECK (new_position IN ('', 'Cutter', 'Handler', '防守大闸', '六边形'));
--> statement-breakpoint
UPDATE profiles SET new_position = CASE position
  WHEN '接盘手' THEN 'Cutter'
  WHEN '持盘手' THEN 'Handler'
  WHEN '防守组' THEN '防守大闸'
  ELSE position END;
--> statement-breakpoint
ALTER TABLE profiles DROP COLUMN position;
--> statement-breakpoint
ALTER TABLE profiles RENAME COLUMN new_position TO position;
