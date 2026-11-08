import { Shell, getPageContext, AccessState, canReadPersonal, isMember } from '../../components/shell';
import { safeReturnTo } from '../../../lib/server/domain';
import { ReflectionEditor } from '../../components/reflections';
export const dynamic = 'force-dynamic';
export default async function NewReflection({
    searchParams
}: {
    searchParams: Promise<{
        collection?: string;
        training?: string;
        video?: string;
    }>;
}) {
    const context = await getPageContext();
    const query = await searchParams;
    const validId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
    const collectionId = validId(query.collection);
    const trainingId = query.collection !== undefined ? undefined : validId(query.training);
    const videoId = query.collection !== undefined ? undefined : validId(query.video);
    const params = new URLSearchParams(collectionId ? { collection: collectionId } : { ...(trainingId ? { training: trainingId } : {}), ...(videoId ? { video: videoId } : {}) });
    if (!context.user || !canReadPersonal(context.user, context.me) || !context.me?.profile) return <Shell title="写复盘" back="/growth" nav={false}>
        <AccessState context={context} returnTo={safeReturnTo('/reflections/new' + (params.size ? '?' + params.toString() : ''))} />
    </Shell>;
    return <Shell title="写复盘" back="/growth" canCompose={isMember(context.me)}>
        <ReflectionEditor
            key={`${context.user.userId}:${collectionId ?? 'new'}`}
            actorId={context.user.userId}
            collectionId={collectionId}
            trainingId={trainingId}
            videoId={videoId}
        />
    </Shell>;
}
