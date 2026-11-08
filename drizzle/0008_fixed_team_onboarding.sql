CREATE TABLE `initial_admin_grants` (
	`team_id` text PRIMARY KEY NOT NULL,
	`op_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
INSERT INTO teams (id, singleton, name, description, created_at)
VALUES ('kapok', 1, 'KPark', '记录一次训练，留下可以回看的思考。', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(singleton) DO NOTHING;
--> statement-breakpoint
UPDATE teams SET name = 'KPark' WHERE singleton = 1;
--> statement-breakpoint
INSERT INTO initial_admin_grants (team_id, op_id)
SELECT t.id, NULL
FROM teams t
WHERE EXISTS (SELECT 1 FROM bootstraps b WHERE b.team_id = t.id)
   OR EXISTS (SELECT 1 FROM memberships m WHERE m.team_id = t.id AND m.role = 'admin')
   OR EXISTS (
     SELECT 1 FROM moderation_audit a
     JOIN memberships m ON m.id = a.target_id AND m.team_id = t.id
     WHERE a.action IN ('member-update', 'member-leave')
       AND CASE WHEN json_valid(a.reason) THEN
         json_extract(a.reason, '$.from.role') = 'admin' OR json_extract(a.reason, '$.to.role') = 'admin'
       ELSE 0 END
   );
