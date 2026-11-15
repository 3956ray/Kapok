import { AccessState, getPageContext, isMember, Shell } from './shell';
import { LearningBrowse, LearningMine, LearningReading } from './learning-posts';
import { LearningEditing } from './learning-editor';

const labels = { index: '学习库', mine: '我的创作', new: '发布内容', edit: '编辑内容', read: '学习资料' };
export async function LearningPage({ view, id, tab }: { view: keyof typeof labels; id?: string; tab?: 'contents' | 'collections' }) {
    const context = await getPageContext();
    const member = context.user && isMember(context.me);
    const postPath = id && /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? `/learn/posts/${id}` : '/learn';
    const back = view === 'index' ? undefined : view === 'edit' ? '/learn/mine' : '/learn';
    const returnTo = view === 'index' && tab ? '/learn?tab=' + tab : view === 'mine' ? '/learn/mine' : view === 'new' ? '/learn/posts/new' : view === 'edit' && id ? postPath + '/edit' : postPath;
    return <Shell title={labels[view]} surface={view === 'read' ? 'video' : 'index'} back={back} canCompose={!!member}
        description={view === 'index' ? '浏览队友分享的资料与合集。' : undefined}>
        {!context.user || !member ? <AccessState context={context} returnTo={returnTo} />
            : view === 'index' ? <LearningBrowse actorId={context.user.userId} tab={tab} />
            : view === 'mine' ? <LearningMine actorId={context.user.userId} />
            : view === 'new' || (view === 'edit' && postPath !== '/learn') ? <LearningEditing key={id ?? 'new'} actorId={context.user.userId} id={id} />
            : view === 'read' && id && postPath !== '/learn' ? <LearningReading key={id} actorId={context.user.userId} id={id} />
            : <p className="notice">此内容暂不可用。</p>}
    </Shell>;
}
