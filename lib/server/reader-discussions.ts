import type { Principal } from '../contracts/index';
import { assertGuard, DomainError } from './domain.ts';
import { bindLearningMember, commitLearning, learningConflict, learningMemberFence, learningMemberGuard, learningMissing,
    learningObject, type LearningContext, type LearningDependencies } from './learning.ts';
import { reflectionShared } from './reflections.ts';

type SourceKind = 'reflection' | 'announcement';
type ReaderComment = {
    id:string; authorId:string; authorName:string; rootId:string|null; replyToId:string|null;
    replyTargetName:string|null; text:string|null; status:'active'|'deleted'; version:number; createdAt:string;
};
const scope = 'team_id=? AND source_kind=? AND source_id=? AND discussion_epoch=?';
const positive = (value:unknown):value is number => typeof value==='number' && Number.isSafeInteger(value) && value>0;
const validId = (value:unknown):value is string => typeof value==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const invalid = () => new DomainError('INVALID_INPUT','请检查讨论内容与页面版本。');

function visibleSource(kind:SourceKind,id:string,c:LearningContext) {
    const member=learningMemberFence(c);
    const sql=kind==='reflection'
        ? `SELECT r.discussion_epoch AS epoch FROM reflections r WHERE r.id=? AND r.team_id=? AND ${reflectionShared}`
        : "SELECT a.discussion_epoch AS epoch FROM announcements a WHERE a.id=? AND a.team_id=? AND a.status='published'";
    const args=kind==='reflection' ? [id,c.membership.teamId,c.user.id] : [id,c.membership.teamId];
    return {sql:`${sql} AND ${member.sql}`,values:[...args,...member.values]};
}

export function createReaderDiscussions({db,activeMember,clock,operation}:LearningDependencies) {
    const q=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values);
    async function readReaderDiscussion(p:Principal|null,kind:SourceKind,id:string) {
        const c=await bindLearningMember(activeMember,p);
        const visible=visibleSource(kind,id,c);
        const {results}=await q(`WITH visible AS (${visible.sql})
            SELECT visible.epoch,d.id,d.author_id AS authorId,author.disc_name AS authorName,d.root_id AS rootId,
                d.reply_to_id AS replyToId,recipient.disc_name AS replyTargetName,
                CASE WHEN d.status='active' THEN d.body END AS text,d.status,d.version,d.created_at AS createdAt
            FROM visible LEFT JOIN reader_discussions d ON d.team_id=? AND d.source_kind=? AND d.source_id=? AND d.discussion_epoch=visible.epoch
            LEFT JOIN profiles author ON author.user_id=d.author_id
            LEFT JOIN reader_discussions target ON target.id=d.reply_to_id AND target.status='active'
                AND target.team_id=d.team_id AND target.source_kind=d.source_kind AND target.source_id=d.source_id AND target.discussion_epoch=d.discussion_epoch
            LEFT JOIN profiles recipient ON recipient.user_id=target.author_id
            ORDER BY d.created_at,d.id`,...visible.values,c.membership.teamId,kind,id).all<ReaderComment & {epoch:number}>();
        if (!results.length) throw learningMissing();
        const items=results.filter(row=>row.id).map(row=>({
            id:row.id,authorId:row.authorId,authorName:row.authorName,rootId:row.rootId,replyToId:row.replyToId,
            replyTargetName:row.replyTargetName,text:row.text,status:row.status,version:row.version,createdAt:row.createdAt,
        }));
        return {items,discussionEpoch:results[0].epoch,membershipEpoch:c.membership.epoch};
    }
    async function writeReaderDiscussion(p:Principal|null,kind:SourceKind,id:string,comment:string|null,input:unknown,key:string) {
        const c=await bindLearningMember(activeMember,p);
        const raw=learningObject(input,['expectedMembershipEpoch','expectedDiscussionEpoch',
            ...(comment ? ['action','expectedVersion'] : ['text','rootId','replyToId'])]);
        const epoch=raw.expectedDiscussionEpoch;
        if (!positive(epoch) || !positive(raw.expectedMembershipEpoch)) throw invalid();
        if (raw.expectedMembershipEpoch!==c.membership.epoch) throw learningConflict();
        const expectedVersion=raw.expectedVersion, text=typeof raw.text==='string' ? raw.text.trim() : '';
        if (comment) {
            if (!validId(comment) || !positive(expectedVersion) || raw.action!=='delete') throw invalid();
        } else if (!text || typeof raw.text!=='string' || raw.text.length>2000 ||
            ((raw.rootId==null)!==(raw.replyToId==null)) ||
            (raw.rootId!=null && (!validId(raw.rootId) || !validId(raw.replyToId)))) throw invalid();
        const visible=visibleSource(kind,id,c);
        const sourceEpoch=await q(visible.sql,...visible.values).first<number>('epoch');
        if (!sourceEpoch) throw learningMissing();
        if (sourceEpoch!==epoch) throw learningConflict();

        const op=await operation(c.user.id,'reader-discussion-'+kind,comment ?? id,key,{id,comment,epoch,member:c.membership.epoch,
            ...(comment ? {expectedVersion} : {text,rootId:raw.rootId ?? null,replyToId:raw.replyToId ?? null})});
        const currentSource=`EXISTS(SELECT 1 FROM (${visible.sql}) WHERE epoch=?)`;
        const sourceArgs=[...visible.values,epoch];
        const scoped=[c.membership.teamId,kind,id,epoch];
        const target=op.replay?.result.id ?? comment ?? crypto.randomUUID();
        if (op.replay) {
            if (!await q(`SELECT id FROM reader_discussions WHERE id=? AND ${scope} AND ${currentSource}`,target,...scoped,...sourceArgs).first())
                throw learningMissing();
            return {id:target};
        }
        const writes=[learningMemberGuard(db,op,c,'before'),assertGuard(db,op.opId,'source',currentSource,sourceArgs)];
        if (comment) {
            const owned=`EXISTS(SELECT 1 FROM reader_discussions WHERE id=? AND ${scope} AND author_id=? AND version=? AND status='active')`;
            writes.push(assertGuard(db,op.opId,'owned',owned,[comment,...scoped,c.user.id,expectedVersion]),
                q("UPDATE reader_discussions SET body='',status='deleted',version=version+1 WHERE id=?",comment));
        } else {
            if (raw.rootId!=null) {
                writes.push(assertGuard(db,op.opId,'reply',`EXISTS(SELECT 1 FROM reader_discussions root JOIN reader_discussions target
                    ON target.team_id=root.team_id AND target.source_kind=root.source_kind AND target.source_id=root.source_id
                    AND target.discussion_epoch=root.discussion_epoch AND coalesce(target.root_id,target.id)=root.id
                    WHERE root.id=? AND root.root_id IS NULL AND root.team_id=? AND root.source_kind=? AND root.source_id=? AND root.discussion_epoch=?
                    AND target.id=? AND target.status='active')`,[raw.rootId,...scoped,raw.replyToId]));
            }
            writes.push(q(`INSERT INTO reader_discussions(id,team_id,source_kind,source_id,discussion_epoch,author_id,root_id,reply_to_id,body,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)`,target,...scoped,c.user.id,raw.rootId ?? null,raw.replyToId ?? null,text,clock().toISOString()));
        }
        writes.push(assertGuard(db,op.opId,'result',`EXISTS(SELECT 1 FROM reader_discussions WHERE id=? AND ${scope}
            AND author_id=? AND status=? AND version=?)`,[target,...scoped,c.user.id,comment ? 'deleted':'active',comment ? Number(expectedVersion)+1 : 1]),
            assertGuard(db,op.opId,'current',currentSource,sourceArgs),learningMemberGuard(db,op,c,'after'));
        return {id:await commitLearning(op,writes,target)};
    }
    return {readReaderDiscussion,writeReaderDiscussion};
}
