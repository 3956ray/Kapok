CREATE INDEX reflection_images_expiry ON reflection_images(touched_at, object_key) WHERE reflection_id IS NULL;
--> statement-breakpoint
CREATE TABLE reflection_image_sweep (
    id INTEGER PRIMARY KEY CHECK(id=1),
    cursor TEXT
);
--> statement-breakpoint
INSERT INTO reflection_image_sweep(id,cursor) VALUES(1,NULL);
