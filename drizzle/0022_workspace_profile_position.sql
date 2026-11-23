ALTER TABLE profiles ADD COLUMN position TEXT NOT NULL DEFAULT '' CHECK(position IN ('','接盘手','持盘手','防守组'));
