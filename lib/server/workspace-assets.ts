import type { Principal } from '../contracts/index';
import { learningPostVisible, bindLearningMember, learningMemberFence, learningMemberGuard, learningObject, commitLearning, type LearningContext, type LearningDependencies } from './learning.ts';
import { assertGuard, DomainError } from './domain.ts';
import { validatedLearningImage } from './learning-image-validation.ts';
import { inspectMP4Ranges } from './media.ts';
import { HOSTED_MEDIA_POLICY, MEDIA_MAX_SECONDS, type MediaPolicy } from '../contracts/media.ts';

const missing = () => new DomainError('NOT_FOUND','文件不存在或已不可见。',404);
const invalid = () => new DomainError('INVALID_INPUT','请重新选择有效的图片或视频。');
type Asset = { id:string; team_id:string; owner_id:string; parent_kind:'training'|'post'; parent_id:string; mime:string; bytes:number; digest:string; ready:number };

// WebM uses EBML variable-length integers. Inspect segment Info and a video TrackEntry;
// unknown-size Segments are valid, while unbounded or truncated child metadata is not.
function webmDuration(buffer:ArrayBuffer, size:number) {
    const bytes=new Uint8Array(buffer), view=new DataView(buffer);
    const fail=():never=>{ throw new DomainError('UNSUPPORTED_MEDIA','无法读取 WebM 视频轨道或片长，请重新导出视频。',415); };
    function integer(at:number, id=false) {
        const first=bytes[at];
        if (!first) return fail();
        let mask=128,width=1;
        while (!(mask & first)) { mask>>=1; width++; }
        if (width>(id?4:8) || at+width>bytes.length) return fail();
        let value=id ? first : first-mask, unknown=!id && value===mask-1;
        for (let n=1;n<width;n++) { value=value*256+bytes[at+n]; unknown=unknown && bytes[at+n]===255; }
        return {value:unknown ? Infinity : value, width};
    }
    function elements(start:number,end:number) {
        const out=[];
        while (start<end && start<bytes.length) {
            if (out.length>=4096) return fail();
            const id=integer(start,true), length=integer(start+id.width);
            const data=start+id.width+length.width;
            const next=length.value===Infinity ? end : data+length.value;
            if (!Number.isSafeInteger(next) || next>end || next<data) return fail();
            out.push({id:id.value,start:data,end:next});
            start=next;
        }
        return out;
    }
    const top=elements(0,size);
    const header=top[0], segment=top.find(e=>e.id===0x18538067);
    if (header?.id!==0x1a45dfa3 || header.end>bytes.length || !segment) return fail();
    const type=elements(header.start,header.end).find(e=>e.id===0x4282);
    if (!type || new TextDecoder().decode(bytes.slice(type.start,type.end))!=='webm') return fail();
    const fields=elements(segment.start,segment.end);
    const info=fields.find(e=>e.id===0x1549a966), tracks=fields.find(e=>e.id===0x1654ae6b);
    if (!info || !tracks || info.end>bytes.length || tracks.end>bytes.length) return fail();
    if (!fields.some(e=>e.id===0x1f43b675 && e.end>e.start)) return fail();
    const track=elements(tracks.start,tracks.end).some(e=>{
        if (e.id!==0xae) return false;
        const entry=elements(e.start,e.end),codec=entry.find(child=>child.id===0x86);
        return entry.some(k=>k.id===0x83 && k.end-k.start===1 && bytes[k.start]===1)
            && codec && ['V_VP8','V_VP9','V_AV1'].includes(new TextDecoder().decode(bytes.slice(codec.start,codec.end)));
    });
    const metadata=elements(info.start,info.end), scale=metadata.find(e=>e.id===0x2ad7b1), d=metadata.find(e=>e.id===0x4489);
    if (!track || !d || ![4,8].includes(d.end-d.start) || (scale && scale.end-scale.start>6)) return fail();
    const ticks=scale ? bytes.slice(scale.start,scale.end).reduce((n,v)=>n*256+v,0) : 1000000;
    const seconds=(d.end-d.start===4?view.getFloat32(d.start):view.getFloat64(d.start))*ticks/1e9;
    if (!Number.isFinite(seconds) || seconds<=0 || seconds>MEDIA_MAX_SECONDS) return fail();
    return seconds;
}

export function createWorkspaceAssets({ db,bucket,clock,activeMember,operation,mediaPolicy=HOSTED_MEDIA_POLICY }: LearningDependencies & {mediaPolicy?:MediaPolicy}) {
    const q=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values);
    const noStore=()=>{if(!bucket) throw new DomainError('STORAGE_UNAVAILABLE','私有文件存储暂不可用。',503); return bucket;};
    function parent(c:LearningContext,kind:string,id:string) {
        return kind==='training' ? { sql:"EXISTS(SELECT 1 FROM trainings WHERE id=? AND team_id=? AND status!='deleted') AND ?='admin'", values:[id,c.membership.teamId,c.membership.role] } :
            {sql:"EXISTS(SELECT 1 FROM learning_posts WHERE id=? AND team_id=? AND owner_id=? AND status!='hidden')", values:[id,c.membership.teamId,c.user.id]};
    }
    async function reserveMaterialAsset(p:Principal|null,input:unknown,key:string) {
        noStore();
        const c=await bindLearningMember(activeMember,p);
        const r=learningObject(input,['kind','parentId','mime','bytes','digest']);
        const {kind,parentId,mime,bytes,digest}=r;
        if ((kind!=='post' && kind!=='training') || typeof parentId!=='string' || typeof digest!=='string' || !/^[a-f0-9]{64}$/.test(digest)
            || !['image/png','image/webp','image/jpeg','video/mp4','video/webm'].includes(String(mime)) || !Number.isSafeInteger(bytes) ||
            Number(bytes)<1 || Number(bytes)>(String(mime).startsWith('image/')?2*1024*1024:Math.min(mediaPolicy.maxBytes,(mime==='video/webm'?64:100)*1024*1024))) throw invalid();
        const canWrite=parent(c,kind,parentId);
        if (!await q('SELECT 1 WHERE '+canWrite.sql,...canWrite.values).first()) throw missing();
        const op=await operation(c.user.id,'material-reserve',parentId,key,r);
        if (op.replay) return {id:op.replay.result.id!};
        const id=crypto.randomUUID();
        const quota='(SELECT coalesce(sum(bytes),0) FROM material_storage_usage WHERE team_id=?)+?<=?';
        const quotaArgs=[c.membership.teamId,bytes,mediaPolicy.teamBytes];
        if (!await q('SELECT 1 WHERE '+quota,...quotaArgs).first()) throw new DomainError('UPLOAD_LIMIT','队伍文件容量已满。',413);
        await commitLearning(op,[learningMemberGuard(db,op,c,'before'),assertGuard(db,op.opId,'parent',canWrite.sql,canWrite.values),
            assertGuard(db,op.opId,'quota',quota,quotaArgs),
            q('INSERT INTO material_assets(id,team_id,owner_id,parent_kind,parent_id,mime,bytes,digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                id,c.membership.teamId,c.user.id,kind,parentId,mime,bytes,digest,clock().toISOString()),learningMemberGuard(db,op,c,'after')],id);
        return {id};
    }
    async function putMaterialAsset(p:Principal|null,id:string,request:Request,key:string) {
        const c=await bindLearningMember(activeMember,p), b=noStore();
        const a=await q('SELECT * FROM material_assets WHERE id=? AND owner_id=? AND team_id=?',id,c.user.id,c.membership.teamId).first<Asset>();
        if (!a) throw missing();
        const canWrite=parent(c,a.parent_kind,a.parent_id), member=learningMemberFence(c);
        if (!await q('SELECT 1 WHERE '+canWrite.sql+' AND '+member.sql,...canWrite.values,...member.values).first()) throw missing();
        if (request.headers.get('Content-Type')!==a.mime || Number(request.headers.get('Content-Length'))!==a.bytes || !request.body) throw invalid();
        if (a.ready) return {id};
        const objectKey='workspace/'+id;
        let duration=0;
        const image=a.mime.startsWith('image/');
        const options={onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:a.mime},sha256:a.digest};
        if (image) {
            const checked=await validatedLearningImage(request.body,a.mime,a.bytes);
            if (checked.digest!==a.digest || checked.bytes.length!==a.bytes) throw invalid();
            await b.put(objectKey,checked.bytes,options);
        } else if (a.bytes <= 2*1024*1024) {
            const bytes=new Uint8Array(a.bytes);
            const reader=request.body.getReader();
            let offset=0;
            try {
                while (true) {
                    const part=await reader.read();
                    if (part.done) break;
                    if (offset+part.value.length>bytes.length) throw invalid();
                    bytes.set(part.value,offset);
                    offset+=part.value.length;
                }
            } finally {await reader.cancel().catch(()=>{});}
            if (offset!==bytes.length) throw invalid();
            await b.put(objectKey,bytes,options);
        } else {
            // R2 requires a stream with a known length and enforces the reserved SHA-256.
            const bounded=new FixedLengthStream(a.bytes);
            const writing=request.body.pipeTo(bounded.writable);
            await Promise.all([writing,b.put(objectKey,bounded.readable,options)]);
        }
        const object=await b.head(objectKey);
        if (!object || object.size!==a.bytes || object.checksums.toJSON().sha256!==a.digest) throw invalid();
        const read=async(offset:number,length:number)=>{
            const part=await b.get(objectKey,{range:{offset,length}});
            if (!part) throw missing();
            return part.arrayBuffer();
        };
        try {
            if (!image) duration=a.mime==='video/webm' ? webmDuration(await read(0,Math.min(a.bytes,512*1024)),a.bytes)
                : (await inspectMP4Ranges(a.bytes,read)).durationSec;
            if (duration>mediaPolicy.maxSeconds) throw new DomainError('UPLOAD_LIMIT','视频超过队伍允许的片长。',413);
        } catch(error) {
            if (error instanceof DomainError && ['UNSUPPORTED_MEDIA','UNSUPPORTED_CODEC','UPLOAD_LIMIT'].includes(error.code)) {
                await b.delete(objectKey);
                await q('DELETE FROM material_assets WHERE id=? AND ready=0',id).run();
            }
            throw error;
        }
        const op=await operation(c.user.id,'material-ready',id,key,{digest:a.digest});
        if (!op.replay) await commitLearning(op,[learningMemberGuard(db,op,c,'before'),assertGuard(db,op.opId,'parent',canWrite.sql,canWrite.values),
            q('UPDATE material_assets SET ready=1 WHERE id=?',id),
            ...(a.parent_kind==='training' && !image ? [q(`INSERT INTO uploads(id,team_id,owner_id,bytes,status,object_key,mime,duration_sec,created_at)
                VALUES(?,?,?,?,'ready',?,?,?,?) ON CONFLICT(id) DO NOTHING`,id,c.membership.teamId,c.user.id,a.bytes,objectKey,a.mime,duration,clock().toISOString())] : []),
            learningMemberGuard(db,op,c,'after')],id);
        return {id};
    }
    async function getMaterialAsset(p:Principal|null,id:string,range:string|null) {
        const b=noStore(), c=await bindLearningMember(activeMember,p),member=learningMemberFence(c);
        const contains=(json:string)=>`EXISTS(SELECT 1 FROM json_each(${json},'$.photos') WHERE json_extract(value,'$.id')=a.id)`;
        const visible=q(`SELECT a.* FROM material_assets a WHERE a.id=? AND a.team_id=? AND a.ready=1 AND ${member.sql} AND (
           (a.parent_kind='training' AND EXISTS(SELECT 1 FROM trainings t WHERE t.id=a.parent_id AND t.team_id=a.team_id
               AND (t.status IN ('published','archived') OR (?='admin' AND t.status!='deleted')) AND ${contains('t.workspace_details')}))
           OR (a.parent_kind='post' AND EXISTS(SELECT 1 FROM learning_posts lp LEFT JOIN learning_post_publications lpub ON lpub.post_id=lp.id
               WHERE lp.id=a.parent_id AND lp.team_id=a.team_id AND (
                  (lp.owner_id=? AND (${contains('lp.workspace_details')} OR lp.video_url='/api/v1/material-assets/'||a.id))
                  OR (${learningPostVisible} AND (${contains('lpub.workspace_details')} OR lpub.video_url='/api/v1/material-assets/'||a.id))))))`,
            id,c.membership.teamId,...member.values,c.membership.role,c.user.id);
        const a=await visible.first<Asset>();
        if (!a) throw missing();
        const headers=new Headers({'Cache-Control':'private, no-store, max-age=0',Vary:'Cookie, oai-authenticated-user-id, Cf-Access-Jwt-Assertion',
            'Content-Type':a.mime,'X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});
        let start=0,end=a.bytes-1;
        if (range) {
            const m=/^bytes=(\d*)-(\d*)$/.exec(range);
            start=m?.[1]?Number(m[1]):Math.max(0,a.bytes-Number(m?.[2]));
            if (m?.[1] && m[2]) end=Math.min(end,Number(m[2]));
            if (!m || (!m[1]&&!m[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end) {
                headers.set('Content-Range','bytes */'+a.bytes); return new Response(null,{status:416,headers});
            }
            headers.set('Content-Range',`bytes ${start}-${end}/${a.bytes}`);
        }
        const obj=await b.get('workspace/'+id,{range:{offset:start,length:end-start+1}});
        if (!obj) throw missing();
        try {if (!await visible.first()) throw missing();} catch(error){await obj.body.cancel().catch(()=>{});throw error;}
        headers.set('Content-Length',String(end-start+1));
        return new Response(obj.body,{status:range?206:200,headers});
    }
    async function listWorkspaceExportAssets(principal: Principal | null) {
        const account = await bindLearningMember(activeMember, principal);
        const member = learningMemberFence(account);
        const owner = account.user.id, team = account.membership.teamId;
        const publishedPhoto = (details: string) =>
            `EXISTS (SELECT 1 FROM json_each(${details},'$.photos') WHERE json_extract(value,'$.id')=a.id)`;
        const { results } = await q(`SELECT id,parentKind,parentId FROM (
            SELECT a.id,a.parent_kind AS parentKind,a.parent_id AS parentId
            FROM material_assets a WHERE a.ready=1 AND a.owner_id=? AND a.team_id=? AND (
                (a.parent_kind='training' AND EXISTS (SELECT 1 FROM trainings t WHERE t.id=a.parent_id
                    AND t.team_id=a.team_id AND t.publisher_id=a.owner_id AND t.status IN ('published','archived')
                    AND ${publishedPhoto('t.workspace_details')})) OR
                (a.parent_kind='post' AND EXISTS (SELECT 1 FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id
                    WHERE lp.id=a.parent_id AND lp.owner_id=a.owner_id AND lp.team_id=a.team_id AND ${learningPostVisible}
                    AND (${publishedPhoto('lpub.workspace_details')} OR lpub.video_url='/api/v1/material-assets/'||a.id))))
            UNION ALL
            SELECT v.id,'video',v.training_id FROM videos v JOIN uploads u ON u.id=v.upload_id AND u.team_id=v.team_id
            JOIN trainings t ON t.id=v.training_id AND t.team_id=v.team_id
            WHERE u.owner_id=? AND u.team_id=? AND u.status='ready' AND u.cleanup_state='none' AND u.transfer_active=0
                AND v.status='active' AND t.publisher_id=u.owner_id AND t.status IN ('published','archived')
        ) WHERE ${member.sql}`,owner,team,owner,team,...member.values).all();
        return results;
    }
    return {reserveMaterialAsset,putMaterialAsset,getMaterialAsset,listWorkspaceExportAssets};
}
