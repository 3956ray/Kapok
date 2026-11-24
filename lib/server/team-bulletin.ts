import type { Principal } from '../contracts/index';
import { assertGuard, DomainError } from './domain.ts';
import { bindLearningMember, commitLearning, learningMemberFence, learningMemberGuard, learningObject, learningPostVisible, type LearningContext, type LearningDependencies } from './learning.ts';
import { reflectionShared } from './reflections.ts';
import { topicCoverVersion } from './topic-cover.ts';
import { topicVisible } from './topic-collections.ts';

// Store only a source key and its visibility generation. Re-read the public title,
// summary and permissions at every display, including when the viewer is the author.
const team = '(SELECT team FROM scope)';
const sharedReflection = reflectionShared.replace('ru.id=?', 'ru.id=(SELECT viewer FROM scope)');
const training = `t.team_id=${team} AND t.status IN ('published','archived')`;
const videos = `videos v JOIN trainings t ON t.id=v.training_id AND t.team_id=v.team_id`;
const video = `${training} AND v.status='active'`;
const posts = 'learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id';
const dailyEvent = "(SELECT la.id FROM learning_activity_events la WHERE la.post_id=lp.id AND la.author_epoch=lpub.author_epoch AND la.revoked_at IS NULL)";
const daily = "(lpub.kind='article' AND lpub.category='随谈')";
const post = `lp.team_id=${team} AND ${learningPostVisible} AND (NOT ${daily} OR ${dailyEvent} IS NOT NULL)`;
const uploadedPhoto = (details: string) => `'/api/v1/material-assets/'||json_extract(${details},'$.photos[0].id')`;
const trainingCover = `coalesce(${uploadedPhoto('t.workspace_details')},
    (SELECT CASE WHEN v.source IN ('bilibili','youtube') THEN '/api/v1/video-covers/video/'||v.id END
        FROM videos v WHERE v.training_id=t.id AND v.team_id=t.team_id AND v.status='active' ORDER BY v.position,v.id LIMIT 1),
    '/workspace-assets/media/sideline-team.webp')`;
const postEpoch = `lp.bulletin_epoch||':'||lpub.author_epoch||':'||CASE WHEN ${daily} THEN ${dailyEvent} ELSE '' END`;
const note = `r.team_id=${team} AND r.published_at IS NOT NULL AND ${sharedReflection}`;
const notice = `a.team_id=${team} AND a.status='published' AND a.published_at IS NOT NULL`;
const topics = 'topic_collections tc JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id';
const topic = `tc.team_id=${team} AND ${topicVisible}`;
const noteEpoch = "r.discussion_epoch||':'||r.published_at";
const commentSummary = `CASE WHEN d.text<>'' OR d.timestamp_sec IS NULL THEN d.text ELSE
    '视频时刻 · '||(SELECT group_concat(printf('%02d:%02d',value/60,value%60),'、')
        FROM json_each(coalesce(d.reference_times,json_array(d.timestamp_sec)))) END`;
const videoEpoch = "t.bulletin_epoch||':'||v.bulletin_epoch";

type Source = ReturnType<typeof source>;
function source(prefix: string, id: string, epoch: string, type: string, title: string, summary: string, href: string, date: string, from: string, visible: string, cover = 'NULL') {
    const sql = `SELECT '${prefix}:'||${id}||':'||${epoch} AS key,${type} AS type,${title} AS title,
        substr(${summary},1,160) AS summary,${href} AS href,${date} AS date,${cover} AS cover FROM ${from} WHERE ${visible}`;
    return { prefix, id, sql };
}

function sources() {
    // Canonical source routes are generated here. Titles and URLs are never accepted from the editor.
    return [
        source('t','t.id','t.bulletin_epoch',"'训练'",'t.title','t.description',"'/trainings/'||t.id",'t.date','trainings t',training,trainingCover),
        source('v','v.id',videoEpoch,"'视频'",'v.title','t.title',"'/trainings/'||t.id||'?video='||v.id",'t.date',videos,video,
            `coalesce(${uploadedPhoto('t.workspace_details')},CASE WHEN v.source IN ('bilibili','youtube') THEN '/api/v1/video-covers/video/'||v.id END)`),
        source('p','lp.id',postEpoch,"CASE lpub.kind WHEN 'video' THEN '视频' ELSE '图文' END",'lpub.title','lpub.summary',
            "'/trainings/'||lp.id","coalesce(json_extract(lpub.workspace_details,'$.date'),lpub.published_at)",posts,post,
            `coalesce((SELECT '/api/v1/learning/posts/'||lp.id||'/images/'||li.id
                FROM learning_publication_images lir JOIN learning_images li ON li.id=lir.image_id AND li.post_id=lir.post_id
                WHERE lir.post_id=lp.id AND li.status='ready' ORDER BY lir.position LIMIT 1),
                ${uploadedPhoto('lpub.workspace_details')},
                CASE WHEN lpub.video_source IN ('bilibili','youtube') THEN '/api/v1/video-covers/post/'||lp.id END)`),
        source('n','r.id',noteEpoch,"'复盘'","coalesce(nullif(r.title,''),'无标题复盘')",'r.text',"'/notes/'||r.id",'r.date','reflections r',note),
        source('a','a.id','a.discussion_epoch',"'公告'",'a.title','a.text',"'/announcements/'||a.id",'a.published_at','announcements a',notice),
        source('topic','tc.id','tcp.visibility_id',"'合集'",'tcp.title','tcp.summary',"'/shared/'||tc.id",'tcp.published_at',topics,topic,
            `'/api/v1/workspace/topic-covers/published/'||tc.id||'/'||${topicCoverVersion('tcp.version')}`),
        source('edition','sh.id','sh.visibility_id',"'合集'",'sh.title','sh.summary',"'/shared/'||sh.id",'sh.published_at',
            topics+' JOIN workspace_topic_shares sh ON sh.collection_id=tc.id AND sh.visibility_id=tcp.visibility_id',topic,
            `'/api/v1/workspace/topic-covers/share/'||sh.id||'/'||${topicCoverVersion('sh.version')}`),
        source('vc','d.id',videoEpoch+"||':'||d.bulletin_epoch","'讨论'",'v.title',commentSummary,
            "'/trainings/'||t.id||'?video='||v.id||'&comment='||d.id",'d.created_at',
            videos+' JOIN video_comments d ON d.video_id=v.id AND d.team_id=v.team_id',video+" AND d.status='active'"),
        source('tc','d.id','t.bulletin_epoch',"'讨论'",'t.title','d.body',
            "'/trainings/'||t.id||'?thread=training&comment='||d.id",'d.created_at',
            'trainings t JOIN training_discussions d ON d.training_id=t.id',training+" AND d.status='active'"),
        source('pc','d.id',postEpoch+"||':'||d.bulletin_epoch","'讨论'",'lpub.title',commentSummary,
            "'/trainings/'||lp.id||'?comment='||d.id",'d.created_at',
            posts+' JOIN learning_comments d ON d.post_id=lp.id AND d.team_id=lp.team_id',post+" AND d.status='active'"),
        source('rc','d.id',noteEpoch,"'讨论'","coalesce(nullif(r.title,''),'无标题复盘')",'d.body',
            "'/notes/'||r.id||'?comment='||d.id",'d.created_at',
            "reflections r JOIN reader_discussions d ON d.source_kind='reflection' AND d.source_id=r.id AND d.team_id=r.team_id AND d.discussion_epoch=r.discussion_epoch",
            note+" AND d.status='active'"),
        source('ac','d.id','a.discussion_epoch',"'讨论'",'a.title','d.body',
            "'/announcements/'||a.id||'?comment='||d.id",'d.created_at',
            "announcements a JOIN reader_discussions d ON d.source_kind='announcement' AND d.source_id=a.id AND d.team_id=a.team_id AND d.discussion_epoch=a.discussion_epoch",
            notice+" AND d.status='active'"),
    ];
}
const scope = 'WITH scope(team,viewer) AS (VALUES(?,?)) ';
type Item = {key:string;type:string;title:string;summary:string;href:string;date:string;cover:string|null;author?:string};
const invalid = () => new DomainError('INVALID_INPUT','请检查公告板设置。');
function match(key: string) {
    const [kind,id] = key.split(':');
    const def = sources().find(s=>s.prefix===kind);
    if (!def || !id || key.length>300) throw invalid();
    return { def, id };
}
function target(def: Source) { return scope+`SELECT * FROM (${def.sql} AND ${def.id}=?) WHERE key=?`; }

export function createTeamBulletin({db,activeMember,operation}: Pick<LearningDependencies,'db'|'activeMember'|'operation'>) {
    const q = (sql:string,...args:unknown[])=>db.prepare(sql).bind(...args);
    const values = (c:LearningContext)=>[c.membership.teamId,c.user.id];
    async function readBulletin(p:Principal|null) {
        const c=await bindLearningMember(activeMember,p), f=learningMemberFence(c);
        const row=await q(`SELECT coalesce(b.version,0) AS version,b.selection FROM (SELECT ? AS team) s
            LEFT JOIN team_bulletins b ON b.team_id=s.team WHERE ${f.sql}`,c.membership.teamId,...f.values).first<{version:number;selection:string|null}>();
        if(!row) throw new DomainError('FORBIDDEN','当前无法访问队伍公告板。',403);
        let item: Item|null=null;
        if(row.selection) {
            const {def,id}=match(row.selection);
            item=await q(target(def)+` AND ${f.sql} AND EXISTS(SELECT 1 FROM team_bulletins WHERE team_id=? AND version=?)`,
                ...values(c),id,row.selection,...f.values,c.membership.teamId,row.version).first<Item>();
        }
        const fallback = item ? null : await q(`SELECT 't:'||t.id||':'||t.bulletin_epoch AS key,'训练' AS type,t.title,
            substr(t.description,1,160) AS summary,'/trainings/'||t.id AS href,t.date,${trainingCover} AS cover,
            coalesce((SELECT p.disc_name FROM profiles p JOIN users u ON u.id=p.user_id
                WHERE p.user_id=t.publisher_id AND u.status='active'),'队内训练') AS author
            FROM trainings t WHERE t.team_id=? AND t.status='published' AND ${f.sql}
            ORDER BY t.date DESC,t.id DESC LIMIT 1`,c.membership.teamId,...f.values).first<Item>();
        return {version:row.version,item,fallback,unavailable:!!row.selection&&!item&&c.membership.role==='admin'};
    }
    async function bulletinOptions(p:Principal|null, search:string, cursor:string|null) {
        const c=await bindLearningMember(activeMember,p,true), f=learningMemberFence(c);
        const term=search.trim();
        if(term.length>160) throw invalid();
        let date='',key='';
        if(cursor) {
            try {
                if(cursor.length>2400) throw invalid();
                const decoded=JSON.parse(decodeURIComponent(cursor));
                if(!Array.isArray(decoded)||decoded.length!==3||decoded[0]!==term||
                    typeof decoded[1]!=='string'||decoded[1].length>80||typeof decoded[2]!=='string'||decoded[2].length>300) throw invalid();
                [,date,key]=decoded;
            } catch { throw invalid(); }
        }
        // D1 permits at most five terms in each compound SELECT.
        const catalog=sources(), groups=[];
        for(let i=0;i<catalog.length;i+=4) groups.push('SELECT * FROM ('+catalog.slice(i,i+4).map(s=>s.sql).join(' UNION ALL ')+')');
        const {results}=await q(scope+'SELECT * FROM ('+groups.join(' UNION ALL ')+`) WHERE ${f.sql}
            AND instr(lower(title||' '||type||' '||summary),lower(?))>0
            AND (?='' OR date<? OR (date=? AND key>?)) ORDER BY date DESC,key LIMIT 31`,
            ...values(c),...f.values,term,key,date,date,key).all<Item>();
        const items=results.slice(0,30),last=items.at(-1);
        return {items,next:results.length>30&&last?encodeURIComponent(JSON.stringify([term,last.date,last.key])):null};
    }
    async function setBulletin(p:Principal|null, input:unknown, requestKey:string) {
        const c=await bindLearningMember(activeMember,p,true), team=c.membership.teamId;
        const raw=learningObject(input,['key','expectedVersion']), key=raw.key, expected=raw.expectedVersion;
        if((key!==null && typeof key!=='string') || !Number.isSafeInteger(expected) || Number(expected)<0) throw invalid();
        const selection=key===null?null:match(key);
        const op=await operation(c.user.id,'team-bulletin',team,requestKey,{key,expectedVersion:expected});
        if(!op.replay){
            const check=(phase:string)=>selection?[assertGuard(db,op.opId,phase+'-selection','EXISTS('+target(selection.def)+')',
                [...values(c),selection.id,key])]:[];
            await commitLearning(op,[
                learningMemberGuard(db,op,c,'before'),
                assertGuard(db,op.opId,'version','coalesce((SELECT version FROM team_bulletins WHERE team_id=?),0)=?',[team,expected]),
                ...check('before'),
                q('INSERT INTO team_bulletins(team_id,selection,version) VALUES(?,?,?) ON CONFLICT(team_id) DO UPDATE SET selection=excluded.selection,version=excluded.version',
                    team,key,Number(expected)+1),
                assertGuard(db,op.opId,'saved','EXISTS(SELECT 1 FROM team_bulletins WHERE team_id=? AND selection IS ? AND version=?)',[team,key,Number(expected)+1]),
                ...check('after'),learningMemberGuard(db,op,c,'after'),
            ],team);
        }
        return readBulletin(p);
    }
    return {readBulletin,bulletinOptions,setBulletin};
}
