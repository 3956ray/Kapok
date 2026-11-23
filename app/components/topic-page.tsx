import { WorkspaceEntry } from './workspace-entry';
import Link from 'next/link';
import { AccessState, getPageContext, isMember, Shell } from './shell';
import { TopicEditing, TopicReading } from './topic-collections';
import { ManageFeaturedTopics } from './topic-featured';
import { manageFeatured, newTopic, topicPath, topicsTab } from './topic-paths';

const labels = { new: '新建合集', edit: '编辑合集', read: '学习合集', featured: '首页精选管理' };

export async function TopicPage({ view, id }: { view: keyof typeof labels; id?: string }) {
    const context = await getPageContext();
    const member = context.user && isMember(context.me);
    const validId = id && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && id !== 'new';
    const path = validId ? topicPath(id) : topicsTab;
    const returnTo = view === 'featured' ? manageFeatured : view === 'new' ? newTopic : view === 'edit' && validId ? path + '/edit' : path;
    if (context.user && member && view !== 'featured' && (view === 'new' || validId)) return <WorkspaceEntry actorId={context.user.userId} path={view === 'new' ? '/collections/new' : '/collections/' + encodeURIComponent(id!) + (view === 'edit' ? '/edit' : '')} />;
    return <Shell title={labels[view]} surface="index" back={view === 'edit' ? '/learn/mine' : topicsTab} canCompose={!!member}>
        {!context.user || !member ? <AccessState context={context} returnTo={returnTo} />
            : view === 'featured' ? context.me?.membership?.role === 'admin' ? <ManageFeaturedTopics actorId={context.user.userId} />
                : <section className="notice error" role="alert"><h2>此页面仅管理员可访问</h2><Link href={topicsTab}>返回合集列表</Link></section>
            : view === 'new' || (view === 'edit' && validId) ? <TopicEditing actorId={context.user.userId} id={id} />
            : view === 'read' && validId ? <TopicReading actorId={context.user.userId} id={id} />
            : <section className="panel"><h2>此合集暂不可读</h2><Link href={topicsTab}>返回合集列表</Link></section>}
    </Shell>;
}
