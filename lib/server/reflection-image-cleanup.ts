const retention = 24 * 60 * 60 * 1000;
const batchSize = 24;
const objectPrefix = 'reflection-images/';
const objectPattern = /^(reflection-images\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/thumbnail)?$/;

async function expireDetached(db:D1Database, bucket:R2Bucket, cutoff:string) {
    // Claim only a still-detached generation. An attachment transaction requires state='ready'.
    const rows = await db.prepare(`UPDATE reflection_images SET state='deleting'
        WHERE reflection_id IS NULL AND touched_at<? AND object_key IN
          (SELECT object_key FROM reflection_images WHERE reflection_id IS NULL AND touched_at<? ORDER BY touched_at,object_key LIMIT ?)
        RETURNING object_key`).bind(cutoff,cutoff,batchSize).all<{object_key:string}>();
    const keys = rows.results.map(row=>row.object_key);
    if (!keys.length) return;
    await bucket.delete(keys.flatMap(key=>[key,key+'/thumbnail']));
    // Failed R2 deletes keep the claimed rows eligible for the next tick. A replacement upload gets a new object key.
    await db.prepare(`DELETE FROM reflection_images WHERE state='deleting' AND reflection_id IS NULL
        AND object_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).run();
}

async function sweepUntracked(db:D1Database, bucket:R2Bucket, cutoff:string) {
    const state = await db.prepare('SELECT cursor FROM reflection_image_sweep WHERE id=1').first<{cursor:string|null}>();
    if (!state) throw new Error('Missing reflection image sweep state');
    const page = await bucket.list({prefix:objectPrefix,limit:64,...(state.cursor ? {cursor:state.cursor} : {})});
    // A PUT may complete after cancellation and lose its worker before it can compensate.
    // Keys are random per D1 reservation and never assigned to another reservation.
    const candidates = page.objects.flatMap(object=>{
        const match = objectPattern.exec(object.key);
        return match && object.uploaded.toISOString()<cutoff ? [{key:object.key,parent:match[1]}] : [];
    });
    if (candidates.length) {
        const parents = [...new Set(candidates.map(item=>item.parent))];
        const rows = await db.prepare('SELECT object_key FROM reflection_images WHERE object_key IN (SELECT value FROM json_each(?))')
            .bind(JSON.stringify(parents)).all<{object_key:string}>();
        const tracked = new Set(rows.results.map(row=>row.object_key));
        const orphans = candidates.filter(item=>!tracked.has(item.parent)).map(item=>item.key);
        if (orphans.length) await bucket.delete(orphans);
    }
    // On failure a later tick repeats the same page. Concurrent ticks cannot rewind a newer cursor.
    await db.prepare('UPDATE reflection_image_sweep SET cursor=? WHERE id=1 AND cursor IS ?')
        .bind(page.truncated ? page.cursor : null,state.cursor).run();
}

export async function cleanupReflectionImages(db:D1Database, bucket:R2Bucket, at:Date) {
    const cutoff = new Date(at.getTime()-retention).toISOString();
    const outcomes = await Promise.allSettled([expireDetached(db,bucket,cutoff),sweepUntracked(db,bucket,cutoff)]);
    for (const result of outcomes) if (result.status==='rejected') throw result.reason;
}
