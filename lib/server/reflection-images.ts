import type { Principal } from '../contracts/index';
import type { ReflectionPhotoRef } from '../contracts/reflections.ts';
import { DomainError } from './domain.ts';
import { bindLearningMember, learningMemberFence, type LearningDependencies } from './learning.ts';
import { validatedLearningImage } from './learning-image-validation.ts';
import { reflectionShared } from './reflections.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maxBytes = 8 * 1024 * 1024;
const invalid = () => new DomainError('INVALID_INPUT','请检查复盘图片、插入位置和图注。');
const missing = () => new DomainError('NOT_FOUND','复盘图片不存在或已不可见。',404);
const conflict = () => new DomainError('VERSION_CONFLICT','图片已经变更，请重新选择后再保存。',409);

export function validateReflectionPhotos(input: unknown, text: string): ReflectionPhotoRef[] {
    if (!Array.isArray(input) || input.length > 9) throw invalid();
    const seen = new Set<string>();
    return input.map(photo => {
        if (!photo || typeof photo !== 'object' || Object.keys(photo).some(key => !['id','at','caption'].includes(key)) ||
            typeof photo.id !== 'string' || !uuid.test(photo.id) || seen.has(photo.id) ||
            !Number.isSafeInteger(photo.at) || photo.at < 0 || photo.at > text.length ||
            typeof photo.caption !== 'string' || photo.caption.length > 200) throw invalid();
        seen.add(photo.id);
        return {id:photo.id, at:photo.at, caption:photo.caption};
    }).sort((a,b) => a.at-b.at);
}

export function reflectionPhotoUrl(note: string, version: string, id: string) {
    return '/api/v1/reflections/' + note + '/images/' + version + '/' + id;
}

export function createReflectionImages({ db, bucket, activeMember, clock }: LearningDependencies) {
    const q = (sql:string,...values:unknown[]) => db.prepare(sql).bind(...values);
    const store = () => {
        if (!bucket) throw new DomainError('STORAGE_UNAVAILABLE','复盘图片存储暂不可用。',503);
        return bucket;
    };
    // Claim a detached object before deleting it. A concurrent save can only attach ready images.
    async function removeDetached(owner: string, id: string, condition: string, args: unknown[]) {
        const row = await q(`UPDATE reflection_images SET state='deleting' WHERE owner_id=? AND id=? AND reflection_id IS NULL
            AND (${condition}) RETURNING object_key`,owner,id,...args).first<{object_key:string}>();
        if (!row) return;
        await store().delete([row.object_key,row.object_key+'/thumbnail']);
        await q("DELETE FROM reflection_images WHERE object_key=? AND state='deleting' AND reflection_id IS NULL",row.object_key).run();
    }
    async function putReflectionImage(p: Principal | null,id: string,request: Request,key: string) {
        const c = await bindLearningMember(activeMember,p);
        const f = learningMemberFence(c);
        if (!uuid.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw invalid();
        if (Number(request.headers.get('Content-Length')) > maxBytes) throw new DomainError('IMAGE_TOO_LARGE','图片不可超过 8 MB。',413);
        const image = await validatedLearningImage(request.body,request.headers.get('Content-Type'),maxBytes);
        const b = store();
        const owner = c.user.id, team = c.membership.teamId, at = clock().toISOString();
        const objectKey = 'reflection-images/'+crypto.randomUUID();
        await q(`INSERT INTO reflection_images(id,owner_id,team_id,object_key,digest,mime,bytes,state,touched_at)
            SELECT ?,?,?,?,?,?,?,'uploading',? WHERE ${f.sql}
            ON CONFLICT(owner_id,id) DO UPDATE SET touched_at=excluded.touched_at
            WHERE reflection_images.team_id=excluded.team_id AND reflection_images.digest=excluded.digest AND reflection_images.state!='deleting'`,
            id,owner,team,objectKey,image.digest,image.mimeType,image.bytes.length,at,...f.values).run();
        const current = () => q(`SELECT object_key,state,digest FROM reflection_images WHERE id=? AND owner_id=? AND team_id=? AND ${f.sql}`,
            id,owner,team,...f.values).first<{object_key:string;state:string;digest:string}>();
        const row = await current();
        if (!row) throw missing();
        if (row.digest!==image.digest || row.state==='deleting') throw conflict();
        if (row.state!=='ready') {
            const options = {onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:image.mimeType},sha256:image.digest};
            const written = await b.put(row.object_key,image.bytes,options) ?? await b.head(row.object_key);
            if (!written || written.size !== image.bytes.length || written.checksums.toJSON().sha256!==image.digest)
                throw new DomainError('RESULT_UNKNOWN','无法确认图片上传结果，请重试。',503,true);
            const ready = await q(`UPDATE reflection_images SET state='ready' WHERE object_key=? AND state IN ('uploading','ready') AND ${f.sql}
                RETURNING id`,row.object_key,...f.values).first();
            if (!ready) {
                // A cancellation may finish before an in-flight R2 PUT. Only this retired key can be removed.
                if (!await q("SELECT 1 FROM reflection_images WHERE object_key=? AND state!='deleting'",row.object_key).first())
                    await b.delete(row.object_key);
                throw conflict();
            }
        }
        return {id};
    }
    async function putReflectionThumbnail(p: Principal | null,id:string,request:Request,key:string) {
        const c=await bindLearningMember(activeMember,p), f=learningMemberFence(c);
        if (!uuid.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw invalid();
        const image=await validatedLearningImage(request.body,request.headers.get('Content-Type'),128*1024,512);
        const row=await q(`UPDATE reflection_images SET touched_at=? WHERE owner_id=? AND team_id=? AND id=?
            AND state='ready' AND ${f.sql} RETURNING object_key,thumb_digest,reflection_id`,
            clock().toISOString(),c.user.id,c.membership.teamId,id,...f.values).first<{object_key:string;thumb_digest:string|null;reflection_id:string|null}>();
        if (!row) throw missing();
        if (row.thumb_digest===image.digest) return {id};
        if (row.thumb_digest || row.reflection_id) throw conflict();
        const b=store(), objectKey=row.object_key+'/thumbnail';
        const put=await b.put(objectKey,image.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:image.mimeType},sha256:image.digest});
        const written=put ?? await b.head(objectKey);
        if (!written || written.checksums.toJSON().sha256!==image.digest) throw conflict();
        const ready=await q(`UPDATE reflection_images SET thumb_mime=?,thumb_bytes=?,thumb_digest=? WHERE object_key=? AND state='ready'
            AND (thumb_digest=? OR (reflection_id IS NULL AND thumb_digest IS NULL)) AND ${f.sql} RETURNING id`,
            image.mimeType,image.bytes.length,image.digest,row.object_key,image.digest,...f.values).first();
        if (!ready) {
            if (!await q("SELECT 1 FROM reflection_images WHERE object_key=? AND state!='deleting'",row.object_key).first())
                await b.delete(objectKey);
            throw conflict();
        }
        return {id};
    }
    async function cancelReflectionImage(p: Principal | null,id: string,key: string) {
        const c = await bindLearningMember(activeMember,p), f = learningMemberFence(c);
        if (!uuid.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw invalid();
        await removeDetached(c.user.id,id,f.sql,f.values);
        return {id};
    }
    async function readReflectionImage(p: Principal | null,note: string,revision: string,id: string,thumbnail: boolean) {
        const c = await bindLearningMember(activeMember,p);
        const f = learningMemberFence(c);
        if (!uuid.test(id) || !/^\d+-\d+-\d+$/.test(revision)) throw missing();
        const query = q(`SELECT a.object_key,a.mime,a.bytes,a.thumb_mime,a.thumb_bytes FROM reflections r JOIN reflection_images a
            ON a.reflection_id=r.id AND a.owner_id=r.owner_id AND a.team_id=r.team_id
            WHERE r.id=? AND r.team_id=? AND r.deleted_at IS NULL AND a.id=? AND a.state='ready'
            AND r.version||'-'||r.sharing_version||'-'||r.generation=?
            AND EXISTS(SELECT 1 FROM json_each(r.photos) j WHERE json_extract(j.value,'$.id')=a.id)
            AND (r.owner_id=? OR (${reflectionShared})) AND ${f.sql}`,note,c.membership.teamId,id,revision,c.user.id,c.user.id,...f.values);
        const row = await query.first<{object_key:string;mime:string;bytes:number;thumb_mime:string|null;thumb_bytes:number|null}>();
        if (!row) throw missing();
        const useThumb = thumbnail && row.thumb_mime && row.thumb_bytes;
        const file = await store().get(useThumb ? row.object_key+'/thumbnail' : row.object_key);
        if (!file) throw missing();
        try { if (!await query.first()) throw missing(); }
        catch(error) { await file.body.cancel().catch(()=>{}); throw error; }
        return {body:file.body,type:useThumb ? row.thumb_mime! : row.mime,size:useThumb ? row.thumb_bytes! : row.bytes};
    }
    return {putReflectionImage,putReflectionThumbnail,cancelReflectionImage,readReflectionImage};
}
