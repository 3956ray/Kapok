import { WorkspaceEntry } from '../../components/workspace-entry';
import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../../components/shell';
import { safeReturnTo } from '../../../lib/server/domain';
import { isLearningSourceId, isLearningSourceKind } from '../../../lib/contracts/reflections';
import { ReflectionEditor } from '../../components/reflections';
export const dynamic = 'force-dynamic';
export default async function NewReflection({
    searchParams
}: {
    searchParams: Promise<{
        resumeDraft?: string;
        collection?: string;
        training?: string;
        video?: string;
        sourceKind?: string;
        sourceId?: string;
    }>;
}) {
    const context = await getPageContext();
    const query = await searchParams;
    const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
    const collectionId = validId(query.collection);
    const source = query.collection === undefined && query.training === undefined && query.video === undefined &&
        isLearningSourceKind(query.sourceKind) && isLearningSourceId(query.sourceId)
        ? { kind: query.sourceKind, id: query.sourceId } : undefined;
    const trainingId = query.collection !== undefined ? undefined : validId(query.training);
    const videoId = query.collection !== undefined ? undefined : validId(query.video);
    const params = new URLSearchParams(collectionId ? { collection: collectionId } : { ...(trainingId ? { training: trainingId } : {}), ...(videoId ? { video: videoId } : {}) });
    if (source) { params.set('sourceKind', source.kind); params.set('sourceId', source.id); }
    if (query.resumeDraft === '1') params.set('resumeDraft', '1');
    if (!context.user || !canReadPersonal(context.user, context.me) || !context.me?.profile) return <Shell title="想和写" back="/growth" nav={false}>
        <AccessState context={context} returnTo={safeReturnTo('/reflections/new' + (params.size ? '?' + params.toString() : ''))} />
    </Shell>;
    if (context.user && isMember(context.me) && query.resumeDraft !== '1') return <WorkspaceEntry actorId={context.user.userId} path={'/notes/new' + (params.size ? '?' + params : '')} />;
    return <Shell title="想和写" back="/growth" canCompose={isMember(context.me)}>
        <ReflectionEditor
            key={`${context.user.userId}:${collectionId ?? (source ? source.kind + ':' + source.id : 'new')}`}
            actorId={context.user.userId}
            collectionId={collectionId}
            sourceKind={source?.kind}
            sourceId={source?.id}
            trainingId={trainingId}
            videoId={videoId}
        />
    </Shell>;
}
