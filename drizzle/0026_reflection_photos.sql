ALTER TABLE reflections ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(photos) AND json_type(photos)='array' AND json_array_length(photos)<=9);
--> statement-breakpoint
ALTER TABLE reflections ADD COLUMN local_photos_pending INTEGER NOT NULL DEFAULT 0 CHECK(local_photos_pending IN (0,1));
--> statement-breakpoint
CREATE TABLE reflection_images (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    team_id TEXT NOT NULL REFERENCES teams(id),
    object_key TEXT UNIQUE NOT NULL,
    digest TEXT NOT NULL CHECK(length(digest)=64),
    mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 8388608),
    thumb_mime TEXT CHECK(thumb_mime IN ('image/jpeg','image/png','image/webp')),
    thumb_bytes INTEGER CHECK(thumb_bytes BETWEEN 1 AND 131072),
    thumb_digest TEXT CHECK(length(thumb_digest)=64),
    state TEXT NOT NULL CHECK(state IN ('uploading','ready','deleting')),
    reflection_id TEXT REFERENCES reflections(id) ON DELETE SET NULL,
    touched_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,id),
    CHECK((thumb_mime IS NULL AND thumb_bytes IS NULL AND thumb_digest IS NULL) OR
          (thumb_mime IS NOT NULL AND thumb_bytes IS NOT NULL AND thumb_digest IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX reflection_images_attachment ON reflection_images(owner_id, reflection_id, touched_at);
