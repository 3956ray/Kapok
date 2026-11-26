// Use this part only when the calling query independently fences the viewer's active membership
// and joins the reflection to that same team. A reading grant is independent of publishing to the feed.
export const teamReadableReflection = `r.deleted_at IS NULL AND r.scope='team' AND r.gate='open' AND r.active_op_id IS NULL
    AND EXISTS(SELECT 1 FROM users au JOIN memberships am ON am.user_id=au.id
        WHERE au.id=r.owner_id AND au.status='active' AND am.team_id=r.team_id
        AND am.status='active' AND am.epoch=r.author_epoch)`;

export const reflectionShared = `${teamReadableReflection}
    AND EXISTS(SELECT 1 FROM users ru JOIN memberships rm ON rm.user_id=ru.id
        WHERE ru.id=? AND ru.status='active' AND rm.team_id=r.team_id AND rm.status='active')`;
