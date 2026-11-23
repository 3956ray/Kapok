import type { Principal } from '../contracts/index';
import type { LearningAuthor } from '../contracts/learning';
import {
    topicDefaults, type FeaturedTopicAdmin, type FeaturedTopics, type LearningAssociation, type TopicAddOutcome,
    type TopicChoice, type TopicCollection, type TopicDraft, type TopicPolicy, type TopicReference, type TopicSource,
} from '../contracts/topic-collections.ts';
import { assertGuard, DomainError, type StoredResult } from './domain.ts';
import { bindLearningMember, learningConflict, learningMemberFence, learningPostVisible, type LearningContext, type LearningDependencies, type LearningOp } from './learning.ts';

export const topicVideoVisible = "v.status='active' AND t.team_id=v.team_id AND t.status IN ('published','archived')";
export const topicVisible = `tc.status='published' AND EXISTS(SELECT 1 FROM memberships tm JOIN users tu ON tu.id=tm.user_id
    WHERE tm.user_id=tc.owner_id AND tm.team_id=tc.team_id AND tm.epoch=tcp.author_epoch
    AND tm.status='active' AND tu.status='active')`;

const sources = `WITH sources AS (
    SELECT 'post' AS kind,lp.id,lp.team_id,lpub.title,lpub.summary,lpub.category,lpub.kind AS media_kind,NULL AS training_id,
        lp.owner_id AS author_id,p.disc_name,p.jersey_number,
        (SELECT json_object('id',li.id,'mimeType',li.mime_type,'width',li.width,'height',li.height,'bytes',li.bytes,
            'href','/api/v1/learning/posts/'||lp.id||'/images/'||li.id,'alt',lir.alt,
            'decorative',json(CASE lir.decorative WHEN 1 THEN 'true' ELSE 'false' END))
            FROM learning_publication_images lir JOIN learning_images li ON li.id=lir.image_id AND li.post_id=lir.post_id
            WHERE lir.post_id=lp.id AND li.status='ready' ORDER BY lir.position LIMIT 1) AS cover
    FROM learning_posts lp JOIN learning_post_publications lpub ON lpub.post_id=lp.id JOIN profiles p ON p.user_id=lp.owner_id
    WHERE ${learningPostVisible}
    UNION ALL
    SELECT 'video',v.id,v.team_id,v.title,'',NULL,'video',v.training_id,p.user_id,p.disc_name,p.jersey_number,NULL
    FROM videos v JOIN trainings t ON t.id=v.training_id LEFT JOIN profiles p ON p.user_id=v.publisher_id
    WHERE ${topicVideoVisible}
    UNION ALL
    SELECT 'training',t.id,t.team_id,t.title,t.description,NULL,'training',t.id,NULL,NULL,NULL,NULL
    FROM trainings t WHERE t.status IN ('published','archived')
)`;
const sourceJson = `json_object('kind',s.kind,'id',s.id,'title',s.title,'summary',s.summary,'category',s.category,
    'mediaKind',s.media_kind,'trainingId',s.training_id,'cover',json(s.cover),
    'author',CASE WHEN s.author_id IS NOT NULL THEN json_object('id',s.author_id,'discName',s.disc_name,'jerseyNumber',s.jersey_number) END)`;
const projectedItems = (snapshot: number) => `(SELECT json_group_array(json(item)) FROM (
    SELECT ${sourceJson} AS item FROM topic_collection_items ti JOIN sources s ON s.kind=ti.kind AND s.id=ti.source_id AND s.team_id=tc.team_id
    WHERE ti.collection_id=tc.id AND ti.snapshot=${snapshot} ORDER BY ti.position)) AS items`;
const publicFields = `tc.id,tcp.title,tcp.summary,tcp.version AS publishedVersion,tcp.published_at AS publishedAt,
    tc.owner_id,p.disc_name,p.jersey_number,${projectedItems(1)}`;
const collectionJoin = `FROM topic_collections tc JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
    JOIN profiles p ON p.user_id=tc.owner_id`;
const effectiveStatus = `CASE WHEN tc.status='published' AND NOT (${topicVisible}) THEN 'withdrawn' ELSE tc.status END`;
type DraftRow = Omit<TopicDraft, 'items' | 'membershipEpoch'> & { items: string };
type PublicRow = Omit<TopicCollection, 'items' | 'author' | 'isAuthor'> & {
    items: string | TopicSource[]; owner_id: string; disc_name: string; jersey_number: string;
};
type TargetState = { version: number; visible: number; draftCount: number; publicCount: number; draftHas: number; publicHas: number };
type Choice = { id: string; visibilityId: string };

const missing = () => new DomainError('NOT_FOUND', '专题合集或资料不可用。', 404);
const invalid = () => new DomainError('INVALID_INPUT', '请检查专题合集内容。');
const forbidden = () => new DomainError('FORBIDDEN', '当前账号没有此操作权限。', 403);
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const itemKey = ({ kind, id }: TopicReference) => kind + ':' + id;
function object(input: unknown, fields: string[]) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !fields.includes(field))) throw invalid();
    return input as Record<string, unknown>;
}
function version(value: unknown, min = 1) {
    if (!Number.isSafeInteger(value) || Number(value) < min) throw invalid();
    return Number(value);
}
function reference(input: unknown): TopicReference {
    const { kind, id } = object(input, ['kind', 'id']);
    if ((kind !== 'post' && kind !== 'video' && kind !== 'training') || !isId(id)) throw invalid();
    return { kind, id };
}
function references(input: unknown, max: number) {
    if (!Array.isArray(input) || input.length > max) throw invalid();
    return input.map(reference);
}
function publicDto(row: PublicRow, c: LearningContext): TopicCollection {
    const { owner_id: id, disc_name: discName, jersey_number: jerseyNumber, items, ...data } = row;
    const author: LearningAuthor = { id, discName, jerseyNumber };
    return { ...data, author, isAuthor: id === c.user.id, items: typeof items === 'string' ? JSON.parse(items) as TopicSource[] : items };
}

export function createTopicCollections({ db, clock, activeMember, operation, topicPolicy }: LearningDependencies & { topicPolicy?: TopicPolicy }) {
    const maxFeatured = topicPolicy?.maxFeatured ?? topicDefaults.maxFeatured;
    if (!Number.isSafeInteger(maxFeatured) || maxFeatured < 1 || maxFeatured > 10) throw new Error('Invalid featured limit');
    const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
    const contextual = async (p: Principal | null, admin = false) => {
        const c = await bindLearningMember(activeMember, p, admin);
        return { c, f: learningMemberFence(c) };
    };
    const guard = (op: LearningOp, phase: string, { sql, values }: ReturnType<typeof learningMemberFence>) =>
        assertGuard(db, op.opId, phase, sql, values);
    const owned = (op: LearningOp, phase: string, c: LearningContext, id: string, v: number) =>
        assertGuard(db, op.opId, phase, 'EXISTS(SELECT 1 FROM topic_collections WHERE id=? AND team_id=? AND owner_id=? AND version=?)',
            [id, c.membership.teamId, c.user.id, v]);
    async function commit(op: LearningOp, statements: D1PreparedStatement[], result: StoredResult) {
        try { return (await op.commit(statements, result)).result; }
        catch (error) {
            if (error instanceof DomainError) throw error;
            throw learningConflict();
        }
    }

    async function getTopicCollection(p: Principal | null, id: string, view: 'draft'): Promise<TopicDraft>;
    async function getTopicCollection(p: Principal | null, id: string, view?: 'published'): Promise<TopicCollection>;
    async function getTopicCollection(p: Principal | null, id: string, view = 'published') {
        const { c, f } = await contextual(p);
        if (view === 'draft') {
            const row = await q(`${sources} SELECT tc.id,tc.title,tc.summary,tc.version,tc.updated_at AS updatedAt,
                ${effectiveStatus} AS status,CASE WHEN ${topicVisible} THEN tcp.version END AS publishedVersion,${projectedItems(0)}
                FROM topic_collections tc LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
                WHERE tc.id=? AND tc.team_id=? AND tc.owner_id=? AND ${f.sql}`,
            id, c.membership.teamId, c.user.id, ...f.values).first<DraftRow>();
            if (!row) throw missing();
            return { ...row, items: JSON.parse(row.items) as TopicSource[], membershipEpoch: c.membership.epoch };
        }
        const row = await q(`${sources} SELECT ${publicFields} ${collectionJoin}
            WHERE tc.id=? AND tc.team_id=? AND ${topicVisible} AND ${f.sql}`, id, c.membership.teamId, ...f.values).first<PublicRow>();
        if (!row) throw missing();
        return publicDto(row, c);
    }
    async function listTopicCollections(p: Principal | null): Promise<TopicCollection[]> {
        const { c, f } = await contextual(p);
        const { results } = await q(`${sources} SELECT ${publicFields} ${collectionJoin}
            WHERE tc.team_id=? AND ${topicVisible} AND ${f.sql} ORDER BY tcp.published_at DESC,tc.id`,
        c.membership.teamId, ...f.values).all<PublicRow>();
        return results.map(row => publicDto(row, c));
    }
    async function listEditableTopicCollections(p: Principal | null): Promise<TopicChoice[]> {
        const { c, f } = await contextual(p);
        return (await q(`SELECT tc.id,tc.title,${effectiveStatus} AS status
            FROM topic_collections tc LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
            WHERE tc.team_id=? AND tc.owner_id=? AND ${f.sql} ORDER BY tc.updated_at DESC,tc.id`,
        c.membership.teamId, c.user.id, ...f.values).all<TopicChoice>()).results;
    }
    async function listTopicSources(p: Principal | null): Promise<TopicSource[]> {
        const { c, f } = await contextual(p);
        const { results } = await q(`${sources} SELECT ${sourceJson} AS item FROM sources s
            WHERE s.team_id=? AND s.kind<>'training' AND ${f.sql} ORDER BY s.title,s.kind,s.id`, c.membership.teamId, ...f.values).all<{ item: string }>();
        return results.map(row => JSON.parse(row.item) as TopicSource);
    }
    async function saveTopicCollection(p: Principal | null, id: string | null, input: unknown, key: string) {
        const { c, f } = await contextual(p);
        const raw = object(input, ['title', 'summary', ...(id ? ['expectedVersion'] : [])]);
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        const summary = raw.summary === undefined ? '' : raw.summary;
        if (!title || title.length > topicDefaults.maxTitle || typeof summary !== 'string' || summary.length > topicDefaults.maxSummary) throw invalid();
        const expected = id ? version(raw.expectedVersion) : 0;
        const op = await operation(c.user.id, 'topic-save', id ?? 'new', key, { title, summary, expectedVersion: expected });
        if (op.replay) return getTopicCollection(p, op.replay.result.id!, 'draft');
        const target = id ?? crypto.randomUUID();
        const at = clock().toISOString();
        const write = [guard(op, 'before-actor', f)];
        if (id) {
            const draft = await getTopicCollection(p, id, 'draft');
            if (draft.version !== expected) throw learningConflict();
            write.push(owned(op, 'before-topic', c, id, expected), q(
                'UPDATE topic_collections SET title=?,summary=?,version=version+1,updated_at=? WHERE id=?', title, summary, at, id));
        } else {
            write.push(q('INSERT INTO topic_collections(id,team_id,owner_id,title,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                target, c.membership.teamId, c.user.id, title, summary, at, at));
        }
        write.push(owned(op, 'after-topic', c, target, expected + 1), guard(op, 'after-actor', f));
        const receipt = await commit(op, write, { id: target });
        return getTopicCollection(p, receipt.id!, 'draft');
    }
    const sourceSnapshot = `SELECT ti.kind,ti.source_id AS id,EXISTS(SELECT 1 FROM sources s WHERE s.kind=ti.kind
        AND s.id=ti.source_id AND s.team_id=?) AS available FROM topic_collection_items ti
        WHERE ti.collection_id=? AND ti.snapshot=0 ORDER BY ti.position`;
    type ItemState = TopicReference & { available: number };
    async function readItems(c: LearningContext, id: string) {
        return (await q(`${sources} ${sourceSnapshot}`, c.membership.teamId, id).all<ItemState>()).results;
    }
    const itemValues = `SELECT json_extract(value,'$.kind') AS kind,json_extract(value,'$.id') AS id,CAST(key AS INTEGER) AS position FROM json_each(?)`;
    function replaceItems(id: string, snapshot: number, items: TopicReference[]) {
        return [
            q('DELETE FROM topic_collection_items WHERE collection_id=? AND snapshot=?', id, snapshot),
            q(`INSERT INTO topic_collection_items(collection_id,snapshot,kind,source_id,position)
                SELECT ?,?,kind,id,position FROM (${itemValues})`, id, snapshot, JSON.stringify(items)),
        ];
    }
    function itemGuard(op: LearningOp, phase: string, id: string, snapshot: number, items: TopicReference[]) {
        return assertGuard(db, op.opId, phase, `(SELECT json_group_array(json_array(kind,source_id)) FROM (
            SELECT kind,source_id FROM topic_collection_items WHERE collection_id=? AND snapshot=? ORDER BY position))=?`,
        [id, snapshot, JSON.stringify(items.map(item => [item.kind, item.id]))]);
    }
    function sourceGuard(op: LearningOp, phase: string, c: LearningContext, items: ItemState[]) {
        return assertGuard(db, op.opId, phase, `${sources} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) j
            WHERE json_extract(j.value,'$.available')<>EXISTS(SELECT 1 FROM sources s WHERE s.team_id=?
                AND s.kind=json_extract(j.value,'$.kind') AND s.id=json_extract(j.value,'$.id')))`,
        [JSON.stringify(items), c.membership.teamId]);
    }
    async function changeItems(p: Principal | null, id: string, input: unknown, key: string, action: 'add' | 'remove' | 'order') {
        const { c, f } = await contextual(p);
        const field = action === 'remove' ? 'item' : 'items';
        const raw = object(input, ['expectedVersion', field]);
        const expected = version(raw.expectedVersion);
        const requested = action === 'remove' ? [reference(raw.item)] : references(raw.items,
            action === 'add' ? topicDefaults.maxBatch : topicDefaults.maxItems);
        if (action === 'add' && !requested.length) throw invalid();
        const op = await operation(c.user.id, 'topic-items-' + action, id, key, { expectedVersion: expected, requested });
        let receipt = op.replay?.result;
        if (!receipt) {
            const draft = await getTopicCollection(p, id, 'draft');
            if (draft.version !== expected) throw learningConflict();
            const before = await readItems(c, id);
            const outcome: TopicAddOutcome[] = [];
            let next: TopicReference[] = before;
            let observed: ItemState[] = before;
            if (action === 'add') {
                const { results } = await q(`${sources} SELECT i.kind,i.id,EXISTS(SELECT 1 FROM sources s
                    WHERE s.kind=i.kind AND s.id=i.id AND s.team_id=?) AS available FROM (${itemValues}) i ORDER BY i.position`,
                c.membership.teamId, JSON.stringify(requested)).all<ItemState>();
                observed = results;
                next = [...before];
                const seen = new Set(next.map(itemKey));
                for (const { kind, id, available } of results) {
                    const item = { kind, id };
                    const status = !available ? 'unavailable' : seen.has(itemKey(item)) ? 'duplicate'
                        : next.length >= topicDefaults.maxItems ? 'limit' : 'added';
                    outcome.push({ ...item, status });
                    if (status === 'added') {
                        next.push(item);
                        seen.add(itemKey(item));
                    }
                }
            } else if (action === 'remove') {
                next = before.filter(item => itemKey(item) !== itemKey(requested[0]));
                observed = [];
            } else {
                const visible = new Set(before.filter(i => i.available).map(itemKey));
                if (visible.size !== requested.length || new Set(requested.map(itemKey)).size !== visible.size
                    || requested.some(item => !visible.has(itemKey(item)))) throw learningConflict();
                let cursor = 0;
                next = before.map(item => item.available ? requested[cursor++] : item);
            }
            const changed = next.length !== before.length || next.some((item, index) => itemKey(item) !== itemKey(before[index]));
            receipt = await commit(op, [
                guard(op, 'before-actor', f), owned(op, 'before-topic', c, id, expected), itemGuard(op, 'before-items', id, 0, before),
                sourceGuard(op, 'before-sources', c, observed),
                ...(changed ? [...replaceItems(id, 0, next), q('UPDATE topic_collections SET version=version+1,updated_at=? WHERE id=?', clock().toISOString(), id)] : []),
                owned(op, 'after-topic', c, id, expected + Number(changed)), itemGuard(op, 'after-items', id, 0, next),
                sourceGuard(op, 'after-sources', c, observed), guard(op, 'after-actor', f),
            ], { id, topicOutcomes: outcome });
        }
        return { collection: await getTopicCollection(p, id, 'draft'), outcomes: receipt.topicOutcomes! };
    }
    async function changeTopicPublication(p: Principal | null, id: string, input: unknown, key: string, publish: boolean) {
        const { c, f } = await contextual(p);
        const raw = object(input, ['expectedVersion', 'expectedMembershipEpoch']);
        const expected = version(raw.expectedVersion);
        const epoch = version(raw.expectedMembershipEpoch);
        if (epoch !== c.membership.epoch) throw learningConflict();
        const op = await operation(c.user.id, publish ? 'topic-publish' : 'topic-withdraw', id, key,
            { expectedVersion: expected, expectedMembershipEpoch: epoch });
        const draft = await getTopicCollection(p, id, 'draft');
        const status = publish ? 'published' : 'withdrawn';
        const next = expected + 1;
        if (!op.replay) {
            if (draft.version !== expected) throw learningConflict();
            if (!publish && draft.status !== 'published') throw missing();
            const at = clock().toISOString();
            const write = [guard(op, 'before-actor', f), owned(op, 'before-topic', c, id, expected)];
            const items = publish ? await readItems(c, id) : [];
            if (publish) {
                write.push(itemGuard(op, 'before-items', id, 0, items), sourceGuard(op, 'before-sources', c, items),
                    q(`INSERT INTO topic_collection_publications(collection_id,title,summary,version,author_epoch,visibility_id,published_at)
                        SELECT id,title,summary,?,?,?,? FROM topic_collections WHERE id=?
                        ON CONFLICT(collection_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,
                        version=excluded.version,author_epoch=excluded.author_epoch,published_at=excluded.published_at,
                        visibility_id=CASE WHEN ? THEN visibility_id ELSE excluded.visibility_id END`,
                    next, epoch, crypto.randomUUID(), at, id, Number(draft.status === 'published')),
                    ...replaceItems(id, 1, items));
            }
            write.push(q('UPDATE topic_collections SET status=?,version=?,updated_at=? WHERE id=?', status, next, at, id),
                assertGuard(db, op.opId, 'after-publication', `EXISTS(SELECT 1 FROM topic_collections tc
                    LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id WHERE tc.id=? AND tc.version=? AND tc.status=?
                    ${publish ? 'AND tcp.version=? AND ' + topicVisible : ''})`, [id, next, status, ...(publish ? [next] : [])]),
                ...(publish ? [itemGuard(op, 'published-items', id, 1, items), sourceGuard(op, 'after-sources', c, items)] : []),
                guard(op, 'after-actor', f));
            await commit(op, write, { id });
        }
        const after = await getTopicCollection(p, id, 'draft');
        if (after.status !== status || (publish ? after.publishedVersion !== next : after.version !== next)) throw learningConflict();
        return after;
    }
    // Project both revisions in one authorized read. Only the author can receive snapshot zero.
    async function workspaceTopics(p: Principal | null) {
        const { c, f } = await contextual(p);
        const { results } = await q(`${sources}
            SELECT tc.id,tcp.title,tcp.summary,tcp.category,tcp.published_at AS updated,tc.owner_id AS ownerId,
                p.disc_name AS author,1 AS published,tcp.version AS version,'published' AS status,${projectedItems(1)}
            ${collectionJoin} WHERE tc.team_id=? AND ${topicVisible} AND ${f.sql}
            UNION ALL
            SELECT tc.id,tc.title,tc.summary,tc.category,tc.updated_at,tc.owner_id,p.disc_name,0,tc.version,
                ${effectiveStatus},${projectedItems(0)}
            FROM topic_collections tc LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
            JOIN profiles p ON p.user_id=tc.owner_id
            WHERE tc.owner_id=? AND tc.team_id=? AND ${f.sql} ORDER BY updated DESC`,
            c.membership.teamId, ...f.values, c.user.id, c.membership.teamId, ...f.values)
            .all<{id:string; items:string; ownerId:string; updated:string}>();
        return results.map(row => ({ ...row, items: JSON.parse(row.items) as TopicSource[], isAuthor: row.ownerId === c.user.id }));
    }
    async function shareWorkspaceTopic(p: Principal | null, id: string, input: unknown, key: string) {
        const { c, f } = await contextual(p);
        const expected = version(object(input,['expectedPublishedVersion']).expectedPublishedVersion);
        const op = await operation(c.user.id,'workspace-topic-share',id,key,{expected});
        if (!op.replay) {
            const share = crypto.randomUUID();
            const insert = q(`INSERT INTO workspace_topic_shares(id,collection_id,version,visibility_id,title,summary,category,published_at,items)
                SELECT ?,tc.id,tcp.version,tcp.visibility_id,tcp.title,tcp.summary,tcp.category,tcp.published_at,
                    (SELECT json_group_array(json(ref)) FROM (SELECT json_object('kind',ti.kind,'id',ti.source_id) ref
                    FROM topic_collection_items ti WHERE ti.collection_id=tc.id AND ti.snapshot=1 ORDER BY ti.position))
                ${collectionJoin} WHERE tc.id=? AND tc.team_id=? AND tcp.version=? AND ${topicVisible} AND ${f.sql}
                ON CONFLICT(collection_id,version) DO NOTHING`,share,id,c.membership.teamId,expected,...f.values);
            const valid = assertGuard(db,op.opId,'source',`EXISTS(SELECT 1 ${collectionJoin} WHERE tc.id=? AND tc.team_id=?
                AND tcp.version=? AND ${topicVisible})`,[id,c.membership.teamId,expected]);
            await commit(op,[guard(op,'member',f),valid,insert],{id});
        }
        const row = await q(`SELECT sh.id FROM workspace_topic_shares sh JOIN topic_collections tc ON tc.id=sh.collection_id
            JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id AND tcp.visibility_id=sh.visibility_id
            WHERE sh.collection_id=? AND sh.version=? AND tc.team_id=? AND ${topicVisible} AND ${f.sql}`,id,expected,c.membership.teamId,...f.values).first<{id:string}>();
        if (!row) throw missing();
        return row;
    }
    async function readWorkspaceShare(p: Principal | null, id: string) {
        const { c, f } = await contextual(p);
        const row = await q(`${sources} SELECT sh.collection_id AS id,sh.title,sh.summary,sh.category,sh.published_at AS updated,
            tc.owner_id AS ownerId,p.disc_name AS author,1 AS published,sh.version,'published' AS status,
            (SELECT json_group_array(json(item)) FROM (SELECT ${sourceJson} AS item FROM json_each(sh.items) j
                JOIN sources s ON s.team_id=tc.team_id AND s.kind=json_extract(j.value,'$.kind') AND s.id=json_extract(j.value,'$.id')
                ORDER BY CAST(j.key AS INTEGER))) AS items
            FROM workspace_topic_shares sh JOIN topic_collections tc ON tc.id=sh.collection_id
            JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id AND tcp.visibility_id=sh.visibility_id
            JOIN profiles p ON p.user_id=tc.owner_id WHERE sh.id=? AND tc.team_id=? AND ${topicVisible} AND ${f.sql}`,
            id,c.membership.teamId,...f.values).first<{id:string;items:string;ownerId:string}>();
        if (!row) throw missing();
        return {...row, items:JSON.parse(row.items) as TopicSource[], isAuthor:row.ownerId===c.user.id, editionId:id};
    }
    async function publishWorkspaceTopic(p: Principal | null, id: string | null, input: unknown, key: string) {
        const { c, f } = await contextual(p);
        const raw = object(input, ['title','summary','category','items','expectedVersion','expectedMembershipEpoch']);
        const expected = version(raw.expectedVersion, id ? 1 : 0);
        const epoch = version(raw.expectedMembershipEpoch);
        if ((!id && expected !== 0) || epoch !== c.membership.epoch) throw learningConflict();
        const { category, summary } = raw;
        const title = typeof raw.title === 'string' ? raw.title.trim() : '';
        if (!title || title.length > topicDefaults.maxTitle || typeof summary !== 'string' || summary.length > 1200 ||
            typeof category !== 'string' || category.length > 32) throw invalid();
        const items = references(raw.items, topicDefaults.maxItems);
        if (!items.length || new Set(items.map(itemKey)).size !== items.length) throw invalid();
        const op = await operation(c.user.id, 'workspace-topic-publish', id ?? 'new', key, { expected, epoch, title, summary, category, items });
        if (op.replay) return { id: op.replay.result.id! };
        const target = id ?? crypto.randomUUID();
        const next = expected + 1;
        const at = clock().toISOString();
        // Hidden sources cannot be edited by the client. Preserve their positions so restoring
        // their source does not silently remove a legacy chapter after an unrelated title edit.
        const draft = id ? await getTopicCollection(p,id,'draft') : null;
        if (draft && draft.version !== expected) throw learningConflict();
        const existing = id ? await readItems(c,id) : [];
        const hidden = existing.filter(item => !item.available);
        const nextItems = [...items];
        for (const [index, item] of existing.entries()) {
            if (!item.available) nextItems.splice(Math.min(index,nextItems.length),0,{kind:item.kind,id:item.id});
        }
        if (nextItems.length > topicDefaults.maxItems) throw invalid();
        const checked = [...items.map(item => ({ ...item, available: 1 })), ...hidden];
        const write = [guard(op, 'member', f), sourceGuard(op, 'sources', c, checked)];
        const keepVisibility = draft?.status === 'published';
        if (id) {
            write.push(owned(op, 'before', c, target, expected), q(`UPDATE topic_collections SET title=?,summary=?,category=?,
                status='published',version=?,updated_at=? WHERE id=?`,title,summary,category,next,at,target));
        } else {
            write.push(q(`INSERT INTO topic_collections(id,team_id,owner_id,title,summary,category,status,version,created_at,updated_at)
                VALUES(?,?,?,?,?,?,'published',?,?,?)`,target,c.membership.teamId,c.user.id,title,summary,category,next,at,at));
        }
        write.push(q(`INSERT INTO topic_collection_publications(collection_id,title,summary,category,version,author_epoch,visibility_id,published_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(collection_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,
            category=excluded.category,version=excluded.version,author_epoch=excluded.author_epoch,
            visibility_id=CASE WHEN ? THEN visibility_id ELSE excluded.visibility_id END,published_at=excluded.published_at`,
            target,title,summary,category,next,epoch,crypto.randomUUID(),at, Number(keepVisibility)),
            ...replaceItems(target,0,nextItems),...replaceItems(target,1,nextItems),
            owned(op,'after',c,target,next),guard(op,'after-member',f));
        await commit(op,write,{id:target});
        return {id:target};
    }
    async function deleteWorkspaceTopic(p: Principal | null,id: string,input: unknown,key: string) {
        const { c, f } = await contextual(p);
        const raw = object(input, ['expectedVersion','expectedMembershipEpoch']);
        const expected = version(raw.expectedVersion);
        if (version(raw.expectedMembershipEpoch) !== c.membership.epoch) throw learningConflict();
        const op = await operation(c.user.id,'workspace-topic-delete',id,key,{expected,epoch:c.membership.epoch});
        if (!op.replay) {
            const draft = await getTopicCollection(p,id,'draft');
            if (draft.version !== expected) throw learningConflict();
            await commit(op,[guard(op,'before-member',f),owned(op,'owned',c,id,expected),
                q('DELETE FROM topic_collection_items WHERE collection_id=?',id),
                q('DELETE FROM topic_collection_publications WHERE collection_id=?',id),
                q('DELETE FROM topic_collections WHERE id=?',id),guard(op,'after-member',f)],{id});
        }
        return {id};
    }
    async function getFeaturedTopics(p: Principal | null, admin: true): Promise<FeaturedTopicAdmin>;
    async function getFeaturedTopics(p: Principal | null, admin?: false): Promise<FeaturedTopics>;
    async function getFeaturedTopics(p: Principal | null, admin = false) {
        const { c, f } = await contextual(p, admin);
        const row = await q(`${sources} SELECT COALESCE(tf.version,0) AS version,
            (SELECT json_group_array(json(item)) FROM (
                SELECT json_object('id',row.id,'title',row.title,'summary',row.summary,'publishedVersion',row.publishedVersion,
                    'publishedAt',row.publishedAt,'owner_id',row.owner_id,'disc_name',row.disc_name,'jersey_number',row.jersey_number,
                    'items',json(row.items)) AS item
                FROM json_each(tf.choices) j JOIN (SELECT ${publicFields},tc.team_id,tcp.visibility_id ${collectionJoin}
                    WHERE tc.team_id=? AND ${topicVisible}) row
                ON row.id=json_extract(j.value,'$.id') AND row.visibility_id=json_extract(j.value,'$.visibilityId')
                ORDER BY CAST(j.key AS INTEGER) LIMIT ?)) AS entries
            FROM (SELECT ? AS team_id) current LEFT JOIN topic_featured tf ON tf.team_id=current.team_id WHERE ${f.sql}`,
        c.membership.teamId, maxFeatured, c.membership.teamId, ...f.values).first<{ version: number; entries: string }>();
        if (!row) throw forbidden();
        const collections = (JSON.parse(row.entries) as PublicRow[]).map(row => publicDto(row, c));
        return { collections, ...(admin ? { version: row.version, maxFeatured } : {}) };
    }
    async function updateFeaturedTopics(p: Principal | null, input: unknown, key: string): Promise<FeaturedTopicAdmin> {
        const { c, f } = await contextual(p, true);
        const raw = object(input, ['expectedVersion', 'collectionIds']);
        const expected = version(raw.expectedVersion, 0);
        const ids = raw.collectionIds;
        if (!Array.isArray(ids) || ids.length > maxFeatured || !ids.every(isId) || new Set(ids).size !== ids.length) throw invalid();
        const op = await operation(c.user.id, 'topic-featured', c.membership.teamId, key, { expectedVersion: expected, collectionIds: ids });
        if (!op.replay) {
            const team = c.membership.teamId;
            const { results: choices } = await q(`SELECT tc.id,tcp.visibility_id AS visibilityId FROM json_each(?) j
                JOIN topic_collections tc ON tc.id=j.value JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
                WHERE tc.team_id=? AND ${topicVisible} AND ${f.sql} ORDER BY CAST(j.key AS INTEGER)`,
            JSON.stringify(ids), team, ...f.values).all<Choice>();
            if (choices.length !== ids.length) throw missing();
            const value = JSON.stringify(choices);
            const validChoices = (phase: string) => assertGuard(db, op.opId, phase, `NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(
                SELECT 1 FROM topic_collections tc JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id WHERE tc.team_id=?
                AND tc.id=json_extract(j.value,'$.id') AND tcp.visibility_id=json_extract(j.value,'$.visibilityId') AND ${topicVisible}))`, [value, team]);
            await commit(op, [
                guard(op, 'before-actor', f),
                assertGuard(db, op.opId, 'before-featured', 'COALESCE((SELECT version FROM topic_featured WHERE team_id=?),0)=?', [team, expected]),
                validChoices('before-choices'),
                q(`INSERT INTO topic_featured(team_id,version,choices) VALUES(?,?,?)
                    ON CONFLICT(team_id) DO UPDATE SET version=excluded.version,choices=excluded.choices`, team, expected + 1, value),
                assertGuard(db, op.opId, 'after-featured', 'EXISTS(SELECT 1 FROM topic_featured WHERE team_id=? AND version=? AND choices=?)', [team, expected + 1, value]),
                validChoices('after-choices'), guard(op, 'after-actor', f),
            ], { id: team });
        }
        return getFeaturedTopics(p, true);
    }

    const associationSelect = `FROM topic_learning_associations ta JOIN learning_post_publications lpub
        ON lpub.post_id=ta.post_id AND lpub.version=ta.published_version JOIN learning_posts lp ON lp.id=lpub.post_id
        WHERE lp.id=? AND lp.owner_id=? AND lp.team_id=? AND ${learningPostVisible}`;
    async function applyLearningInclusion(p: Principal | null, id: string, expected: number, key: string, initial: boolean): Promise<LearningAssociation> {
        const { c, f } = await contextual(p);
        const team = c.membership.teamId;
        const link = [id, c.user.id, team];
        const currentAssociation = async () => {
            const current = await q(`SELECT lpub.collection_target_id AS targetId,ta.published_version AS publishedVersion,ta.status
                ${associationSelect} AND ${f.sql}`, ...link, ...f.values).first<LearningAssociation>();
            if (!current) throw missing();
            if (current.publishedVersion !== expected) throw learningConflict();
            return current;
        };
        const current = await currentAssociation();
        const op = await operation(c.user.id, initial ? 'topic-inclusion-initial' : 'topic-inclusion-retry', id, key, { expectedPublishedVersion: expected });
        if (op.replay) {
            await currentAssociation();
            return op.replay.result.learningAssociation!;
        }
        const postGuard = (phase: string, status: LearningAssociation['status']) => assertGuard(db, op.opId, phase,
            `EXISTS(SELECT 1 ${associationSelect} AND ta.published_version=? AND lpub.collection_target_id=? AND ta.status=?)`,
            [...link, expected, current.targetId, status]);
        const target = current.targetId;
        const scope = [target, team, c.user.id];
        const targetQuery = `SELECT tc.version,(${topicVisible}) AND tcp.collection_id IS NOT NULL AS visible,
            (SELECT COUNT(*) FROM topic_collection_items WHERE collection_id=tc.id AND snapshot=0) AS draftCount,
            (SELECT COUNT(*) FROM topic_collection_items WHERE collection_id=tc.id AND snapshot=1) AS publicCount,
            EXISTS(SELECT 1 FROM topic_collection_items WHERE collection_id=tc.id AND snapshot=0 AND kind='post' AND source_id=?) AS draftHas,
            EXISTS(SELECT 1 FROM topic_collection_items WHERE collection_id=tc.id AND snapshot=1 AND kind='post' AND source_id=?) AS publicHas
            FROM topic_collections tc LEFT JOIN topic_collection_publications tcp ON tcp.collection_id=tc.id
            WHERE tc.id=? AND tc.team_id=? AND tc.owner_id=?`;
        const write = [guard(op, 'before-actor', f), postGuard('before-post', current.status)];
        let status = current.status;
        if (status === 'pending') {
            const state = await q(targetQuery, id, id, ...scope).first<TargetState>();
            const targetGuard = (phase: string, state: TargetState | null) => assertGuard(db, op.opId, phase,
                state ? `EXISTS(SELECT 1 FROM (${targetQuery}) WHERE version=? AND visible=? AND draftCount=? AND publicCount=? AND draftHas=? AND publicHas=?)`
                    : `NOT EXISTS(${targetQuery})`, [id, id, ...scope, ...(state ? [
                    state.version, state.visible, state.draftCount, state.publicCount, state.draftHas, state.publicHas,
                ] : [])]);
            write.push(targetGuard('before-target', state));
            if (state && (state.draftHas || state.draftCount < topicDefaults.maxItems)
                && (!state.visible || state.publicHas || state.publicCount < topicDefaults.maxItems)) {
                const addDraft = !state.draftHas;
                const addPublic = !!state.visible && !state.publicHas;
                for (const snapshot of [...(addDraft ? [0] : []), ...(addPublic ? [1] : [])]) {
                    write.push(q(`INSERT INTO topic_collection_items(collection_id,snapshot,kind,source_id,position)
                        SELECT ?,?,'post',?,COALESCE(MAX(position)+1,0) FROM topic_collection_items
                        WHERE collection_id=? AND snapshot=?`, target, snapshot, id, target, snapshot));
                }
                const changed = addDraft || addPublic;
                if (changed) write.push(q('UPDATE topic_collections SET version=version+1,updated_at=? WHERE id=?', clock().toISOString(), target));
                if (addPublic) write.push(q('UPDATE topic_collection_publications SET version=? WHERE collection_id=?', state.version + 1, target));
                status = state.visible ? 'added-published' : 'added-draft';
                write.push(q('UPDATE topic_learning_associations SET status=? WHERE post_id=? AND published_version=?', status, id, expected),
                    targetGuard('after-target', { ...state, version: state.version + Number(changed), draftCount: state.draftCount + Number(addDraft),
                        publicCount: state.publicCount + Number(addPublic), draftHas: 1, publicHas: Number(addPublic || state.publicHas) }));
                if (addPublic) write.push(assertGuard(db, op.opId, 'after-target-publication',
                    'EXISTS(SELECT 1 FROM topic_collection_publications WHERE collection_id=? AND version=?)', [target, state.version + 1]));
            }
        }
        write.push(postGuard('after-post', status), guard(op, 'after-actor', f));
        const result = await commit(op, write, { id, learningAssociation: { ...current, status } });
        await currentAssociation();
        return result.learningAssociation!;
    }
    async function retryLearningInclusion(p: Principal | null, id: string, input: unknown, key: string) {
        const expected = version(object(input, ['expectedPublishedVersion']).expectedPublishedVersion);
        return applyLearningInclusion(p, id, expected, key, false);
    }
    async function attemptLearningInclusion(p: Principal | null, id: string, publishedVersion: number, key: string) {
        try { await applyLearningInclusion(p, id, publishedVersion, key, true); }
        catch {
            // An authorized reread of the already committed publication resolves the association state.
        }
    }

    return {
        getTopicCollection, listTopicCollections, listEditableTopicCollections, listTopicSources, saveTopicCollection,
        addTopicItems: (p: Principal | null, id: string, input: unknown, key: string) => changeItems(p, id, input, key, 'add'),
        removeTopicItem: async (p: Principal | null, id: string, input: unknown, key: string) => (await changeItems(p, id, input, key, 'remove')).collection,
        orderTopicItems: async (p: Principal | null, id: string, input: unknown, key: string) => (await changeItems(p, id, input, key, 'order')).collection,
        publishTopicCollection: (p: Principal | null, id: string, input: unknown, key: string) => changeTopicPublication(p, id, input, key, true),
        withdrawTopicCollection: (p: Principal | null, id: string, input: unknown, key: string) => changeTopicPublication(p, id, input, key, false),
        workspaceTopics, publishWorkspaceTopic, deleteWorkspaceTopic, shareWorkspaceTopic, readWorkspaceShare,
        getFeaturedTopics, updateFeaturedTopics, retryLearningInclusion, attemptLearningInclusion,
    };
}
