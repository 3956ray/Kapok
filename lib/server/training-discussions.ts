import type { Principal } from '../contracts/index';
import { assertGuard, DomainError } from './domain.ts';
import { bindLearningMember, commitLearning, learningMemberFence, learningMemberGuard, learningMissing, learningObject, type LearningDependencies } from './learning.ts';

export function createTrainingDiscussions({db,activeMember,clock,operation}:LearningDependencies) {
    const q=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values);
    async function readTrainingDiscussion(p:Principal|null,id:string) {
        const c=await bindLearningMember(activeMember,p), member=learningMemberFence(c);
        const {results}=await q(`SELECT d.id,d.author_id AS authorId,a.disc_name AS authorName,d.root_id AS rootId,d.reply_to_id AS replyToId,
          CASE WHEN d.status='active' THEN d.body END AS text,d.status,d.version,d.created_at AS createdAt,targetProfile.disc_name AS replyTargetName
          FROM trainings t LEFT JOIN training_discussions d ON d.training_id=t.id LEFT JOIN profiles a ON a.user_id=d.author_id
          LEFT JOIN training_discussions target ON target.id=d.reply_to_id AND target.status='active'
          LEFT JOIN profiles targetProfile ON targetProfile.user_id=target.author_id
          WHERE t.id=? AND t.team_id=? AND t.status IN ('published','archived') AND ${member.sql} ORDER BY d.created_at,d.id`,
          id,c.membership.teamId,...member.values).all();
        if (!results.length) throw learningMissing();
        return results.filter(row=>row.id);
    }
    async function writeTrainingDiscussion(p:Principal|null,id:string,comment:string|null,input:unknown,key:string) {
        const c=await bindLearningMember(activeMember,p);
        const r=learningObject(input,comment ? ['action','expectedVersion'] : ['text','rootId','replyToId']);
        if (comment ? r.action!=='delete' || !Number.isSafeInteger(r.expectedVersion) :
            typeof r.text!=='string' || !r.text.trim() || r.text.length>2000 || ((r.rootId==null)!==(r.replyToId==null)) ||
            (r.rootId!=null && (typeof r.rootId!=='string' || typeof r.replyToId!=='string'))) throw new DomainError('INVALID_INPUT','请检查讨论内容。');
        const visible="EXISTS(SELECT 1 FROM trainings WHERE id=? AND team_id=? AND status='published')";
        if (!await q('SELECT 1 WHERE '+visible,id,c.membership.teamId).first()) throw learningMissing();
        const op=await operation(c.user.id,'training-discussion',comment || id,key,{id,...r});
        if (op.replay) return {id:op.replay.result.id};
        const target=comment || crypto.randomUUID();
        const write=[learningMemberGuard(db,op,c,'before'),assertGuard(db,op.opId,'training',visible,[id,c.membership.teamId])];
        if (comment) {
            write.push(assertGuard(db,op.opId,'owner',"EXISTS(SELECT 1 FROM training_discussions WHERE id=? AND training_id=? AND author_id=? AND status='active' AND version=?)",
                [comment,id,c.user.id,r.expectedVersion]),q("UPDATE training_discussions SET body='',status='deleted',version=version+1 WHERE id=?",comment));
        } else {
            if (r.rootId) write.push(assertGuard(db,op.opId,'target',`EXISTS(SELECT 1 FROM training_discussions root JOIN training_discussions t ON t.training_id=root.training_id
                WHERE root.id=? AND root.root_id IS NULL AND root.training_id=? AND t.id=? AND coalesce(t.root_id,t.id)=root.id AND root.status='active' AND t.status='active')`,[r.rootId,id,r.replyToId]));
            write.push(q('INSERT INTO training_discussions(id,training_id,author_id,root_id,reply_to_id,body,created_at) VALUES(?,?,?,?,?,?,?)',
                target,id,c.user.id,r.rootId??null,r.replyToId??null,(r.text as string).trim(),clock().toISOString()));
        }
        write.push(learningMemberGuard(db,op,c,'after'));
        return {id:await commitLearning(op,write,target)};
    }
    return {readTrainingDiscussion,writeTrainingDiscussion};
}
