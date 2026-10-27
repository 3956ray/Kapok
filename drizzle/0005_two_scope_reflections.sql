-- Install both fences before revoking legacy grants. Run this file as one D1 batch.
-- Retain the legacy table/CHECK layout and lifecycle revocation triggers.
CREATE TRIGGER reflection_two_scope_insert BEFORE INSERT ON reflections
WHEN NEW.scope NOT IN ('private','team') OR NEW.coach_id IS NOT NULL OR NEW.coach_epoch IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'reflection_two_scope_required');
END;
--> statement-breakpoint
CREATE TRIGGER reflection_two_scope_update BEFORE UPDATE ON reflections
WHEN NEW.scope NOT IN ('private','team') OR NEW.coach_id IS NOT NULL OR NEW.coach_epoch IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'reflection_two_scope_required');
END;
--> statement-breakpoint
-- Include deleted rows: restoring a body must never resurrect its old grant.
-- Keep body version, generation, timestamps, ownership and associations untouched.
UPDATE reflections SET scope='private',coach_id=NULL,coach_epoch=NULL,author_epoch=NULL,
    published_at=NULL,gate='closed',active_op_id=NULL,sharing_version=sharing_version+1
WHERE scope='coach' OR coach_id IS NOT NULL OR coach_epoch IS NOT NULL;
