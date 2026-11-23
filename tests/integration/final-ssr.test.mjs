import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setServerMe } from '../helpers/server-stubs.mjs';
import { runWithSitesIdentity, runWithAccessIdentity } from '../../lib/server/request-identity.ts';
const sitesTest = (name, run) => test(name, () => runWithSitesIdentity(run));
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { HomeScreen, TrainingsScreen, TrainingScreen, MyScreen, JoinScreen } = await import('../../app/components/legacy-screens.tsx');
const h = React.createElement;
const me = { user: { id: 'user-A', status: 'active' }, profile: { discName: 'private A name', jerseyNumber: '07', version: 1 }, membership: { id: 'm', teamId: 't', status: 'active', role: 'admin', epoch: 1, version: 1 }, team: { id: 't', name: 'private team', description: 'private description' } };
const training = { id: 't', title: 'private training', date: '2026-10-16', description: 'private training body', status: 'published', version: 1 };
const video = { id: 'v', title: 'private video', trainingId: 't', source: 'upload', status: 'active', version: 1, position: 0, durationSec: 60, training };
const comment = { id: 'c', videoId: 'v', authorId: 'user-A', authorName: 'private A name', text: 'withdrawn body', rootId: null, timestampSec: 4, status: 'active', version: 1, createdAt: '2026-10-16' };
const videoProps = { actorId: 'A', videoId: 'v', userId: 'user-A', admin: true, video, initialComments: [comment] };
test('final C1 production video initial SSR conceals all private payload', () => {
    const html = renderToStaticMarkup(h(VideoDiscussion, videoProps));
    assert.ok(!html.includes('withdrawn body'));
    assert.ok(!html.includes('private video'));
    for (const component of [HomeScreen, TrainingsScreen, MyScreen]) {
        const output = renderToStaticMarkup(h(component, { actorId: 'A' }));
        assert.ok(!output.includes('private A name') && !output.includes('private team'));
        assert.match(output, /hidden/);
    }
    assert.match(renderToStaticMarkup(h(JoinScreen, { actorId: 'A', returnTo: '/' })), /data-kapok-sensitive[^>]*hidden/);
    assert.match(renderToStaticMarkup(h(TrainingScreen, { actorId: 'A', id: 't' })), /hidden/);
});
sitesTest('final C1 actual server-page SSR omits personalized business headings, and profile', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe(me);
    const cases = [
        ['../../app/page.tsx', {}], ['../../app/home/page.tsx', {}], ['../../app/me/page.tsx', {}], ['../../app/trainings/page.tsx', {}],
        ['../../app/trainings/[id]/page.tsx', { params: Promise.resolve({ id: 't' }) }],
        ['../../app/videos/[id]/page.tsx', { params: Promise.resolve({ id: 'v' }), searchParams: Promise.resolve({ t: '12' }) }],
        ['../../app/admin/members/page.tsx', {}]
    ];
    for (const [path, props] of cases) {
        const Page = (await import(path)).default;
        const tree = await Page(props);
        const stream = await renderToReadableStream(tree);
        await stream.allReady;
        const html = await new Response(stream).text();
        for (const secret of ['private A name', 'private team', 'private training', 'private video', 'withdrawn body']) assert.ok(!html.includes(secret), path + ': ' + secret);
        assert.match(html, /data-kapok-sensitive[^>]*hidden/);
        if (path === '../../app/page.tsx' || path === '../../app/home/page.tsx') {
            assert.match(html, /data-bloom-workspace/);
        }
    }
});

sitesTest('final C1 unjoined old Sites identities see a generic gate without business data or new enrollment', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe({ user: null, profile: null, membership: null, team: null });
    for (const path of ['../../app/page.tsx', '../../app/me/page.tsx']) {
        const Page = (await import(path)).default;
        const stream = await renderToReadableStream(await Page());
        await stream.allReady;
        const html = await new Response(stream).text();
        assert.match(html, /当前账号没有队伍访问权限/);
        assert.doesNotMatch(html, /private A name|完善 KPark|\/internal\/bootstrap|workspace-date/);
    }
    setServerMe(me);
});

sitesTest('final I5 actual disabled My server page does not render profile/team/admin payload', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe({ ...me, user: { ...me.user, status: 'deleted' } });
    const Page = (await import('../../app/me/page.tsx')).default;
    const stream = await renderToReadableStream(await Page());
    await stream.allReady;
    const html = await new Response(stream).text();
    for (const secret of ['private A name', 'private team', '/admin/invites', '/admin/members']) assert.ok(!html.includes(secret));
    setServerMe(me);
});

sitesTest('B route shells retain the main landmark and show workspace navigation on permitted reflection pages', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe(me);
    const params = { params: Promise.resolve({ id:'r', token:'synthetic-invite-token' }), searchParams: Promise.resolve({}) };
    const routes = [
        ['', true], ['trainings', true], ['trainings/[id]', true], ['videos/[id]', true], ['growth', true],
        ['reflections/new', true], ['reflections/[id]', true], ['reflections/[id]/edit', true], ['reflections/[id]/sharing', true],
        ['me', true], ['me/edit', true], ['me/data', true], ['me/recycle', true], ['members', true], ['members/[id]', true],
        ['activity', true], ['announcements/[id]', true], ['admin/announcements', true], ['admin/members', true],
        ['login', false],
    ];
    assert.equal(routes.length, 20);
    for (const [route, nav] of routes) {
        const Page = (await import(`../../app/${route ? route + '/' : ''}page.tsx`)).default;
        const stream = await renderToReadableStream(await Page(params)); await stream.allReady;
        const html = await new Response(stream).text();
        assert.match(html, /<main\b[^>]*id="main-content"[^>]*tabindex="-1"[^>]*>/, route);
        if (nav) {
            assert.match(html,/data-bloom-workspace/,route);
            assert.match(html,/data-kapok-sensitive[^>]*hidden/,route);
            assert.doesNotMatch(html,/class="mobile-drawer"|class="frame"|class="bottom-nav"/,route);
        } else {
            assert.equal(html.includes('aria-label="主要导航"'),false,route);
            assert.equal(html.includes('aria-label="工作区导航"'),false,route);
        }
        for (const secret of ['private A name', 'private team', 'synthetic-invite-token']) assert.ok(!html.includes(secret), route + ': ' + secret);
    }
});

test('reflection editor and sharing pages keep both navigation surfaces behind the existing access gate', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    const principal = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'A', verifiedEmail: 'synthetic@example.test' };
    const routes = ['new', '[id]/edit', '[id]/sharing'];
    const pages = await Promise.all(routes.map(async route => (await import(`../../app/reflections/${route}/page.tsx`)).default));
    try {
        for (const [identity, account, message] of [
            [null, null, /登录后即可继续/],
            [principal, { ...me, membership: { ...me.membership, status: 'paused' } }, /成员资格已暂停/],
        ]) {
            await runWithAccessIdentity(identity, async () => {
                setServerMe(account);
                for (const [i, Page] of pages.entries()) {
                    const stream = await renderToReadableStream(await Page({
                        params: Promise.resolve({ id: 'r' }),
                        searchParams: Promise.resolve({ training: 't', video: 'v' }),
                    }));
                    const html = await new Response(stream).text();
                    assert.match(html, message, routes[i]);
                    assert.doesNotMatch(html, /workspace-sidebar|bottom-nav|workspace-compose|data-kapok-sensitive|<form/, routes[i]);
                }
            });
        }
    } finally { setServerMe(me); }
});

test('nonmember Access SSR offers an explicit registration choice, offers logout, and keeps paused members out of personal routes', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    const principal = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'A', verifiedEmail: 'synthetic@example.test' };
    await runWithAccessIdentity(principal, async () => {
        setServerMe({ user: null, profile: null, membership: null, team: null });
        const Me = (await import('../../app/me/page.tsx')).default;
        const onboarding = await new Response(await renderToReadableStream(await Me())).text();
        assert.match(onboarding, /该邮箱尚未注册/);
        assert.match(onboarding, /href="\/register\?returnTo=%2Fme"/);
        assert.doesNotMatch(onboarding, /<form|name="discName"/);
        assert.doesNotMatch(onboarding, /邀请|初始化|仅合成业务数据/);
        assert.match(onboarding, /\/cdn-cgi\/access\/logout/);
        setServerMe({ ...me, profile: null, team: null, membership: { ...me.membership, status: 'paused' } });
        const Growth = (await import('../../app/growth/page.tsx')).default;
        const blocked = await new Response(await renderToReadableStream(await Growth())).text();
        assert.match(blocked, /成员资格已暂停/);
        assert.ok(!blocked.includes('/reflections/new'));
        const { chatGPTSignInPath } = await import('../../app/chatgpt-auth.ts');
        assert.equal(chatGPTSignInPath('//other.test'), '/');
        assert.equal(chatGPTSignInPath('/join/synthetic-token-here?returnTo=https%3A%2F%2Fother.test'), '/');
        assert.equal(chatGPTSignInPath('/videos/v?t=8#comment-c'), '/videos/v?t=8#comment-c');
    });
    setServerMe(me);
});

test('V2 account and detail shells opt in to compose only for active members', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    const principal = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'A', verifiedEmail: 'synthetic@example.test' };
    try {
        await runWithAccessIdentity(principal, async () => {
            const routes = ['me', 'me/data', 'me/recycle', 'members/[id]', 'announcements/[id]', 'me/edit', 'admin/members', 'admin/announcements'];
            const pages = await Promise.all(routes.map(async route => (await import(`../../app/${route}/page.tsx`)).default));
            for (const status of ['active', 'paused']) {
                setServerMe({ ...me, profile: status === 'active' ? me.profile : null, membership: { ...me.membership, role: 'member', status } });
                for (const [i, Page] of pages.entries()) {
                    const stream = await renderToReadableStream(await Page({ params: Promise.resolve({ id: 'resource' }) }));
                    const html = await new Response(stream).text();
                    const workspaceEntry = status === 'active' && [0,1,2,3,4,5].includes(i);
                    assert.equal(html.includes('data-bloom-workspace'),workspaceEntry,routes[i]);
                    assert.equal(html.includes('class="workspace-compose"'),false,routes[i]);
                    if (workspaceEntry) assert.match(html,/data-kapok-sensitive[^>]*hidden/,routes[i]);
                    if (status === 'active' && i > 5) {
                        assert.match(html, /此页面仅管理员可访问/);
                        assert.doesNotMatch(html, /data-kapok-sensitive|<form/);
                    }
                    if (status === 'paused') {
                        assert.match(html, /成员资格已暂停/);
                        assert.doesNotMatch(html, /data-kapok-sensitive|<form/);
                    }
                }
            }
        });
    } finally { setServerMe(me); }
});

test('legacy onboarding paths lead to safe original destinations and conceal old tokens', async () => {
    const principal = { provider: 'access', issuer: 'https://synthetic.cloudflareaccess.com', subject: 'A', verifiedEmail: 'synthetic@example.test' };
    await runWithAccessIdentity(principal, async () => {
        const pages = await Promise.all(['join', 'join/[token]', 'internal/bootstrap', 'admin/invites', 'login'].map(async route =>
            (await import('../../app/' + route + '/page.tsx')).default));
        const props = { params: Promise.resolve({ token: 'synthetic-secret-token' }), searchParams: Promise.resolve({ returnTo: '/videos/v?t=12#comment-c' }) };
        setServerMe(me);
        const resolvePage = async (Page, args) => {
            const tree = await Page(args);
            return tree.type(tree.props);
        };
        for (const Page of [pages[0], pages[2], pages[3]]) await assert.rejects(resolvePage(Page, props), /redirect \/videos\/v\?t=12#comment-c/);
        await assert.rejects(pages[4](props), /redirect \/auth\/continue\?intent=login&returnTo=%2Fvideos%2Fv%3Ft%3D12%23comment-c/);
        await assert.rejects(pages[1](props), /redirect \/register\?returnTo=%2Fvideos%2Fv%3Ft%3D12%23comment-c/);
        await assert.rejects(pages[1]({ ...props, searchParams: Promise.resolve({ returnTo: '//external.test' }) }), /redirect \/register\?returnTo=%2F$/);
        setServerMe({ ...me, membership: { ...me.membership, role: 'member' } });
        await assert.rejects(resolvePage(pages[2], { ...props, searchParams: Promise.resolve({ returnTo: '/admin/members' }) }), /redirect \/$/);
        setServerMe({ user: null, profile: null, membership: null, team: null });
        for (const Page of [pages[0], pages[2], pages[3]]) {
            await assert.rejects(resolvePage(Page, props), /redirect \/register\?returnTo=%2Fvideos%2Fv%3Ft%3D12%23comment-c/);
        }
    });
    setServerMe(me);
});


sitesTest('training management SSR denies direct member access and fixes the admin preview return', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    const ssr = async element => new Response(await renderToReadableStream(element)).text();
    const member = { ...me, membership: { ...me.membership, role: 'member' } };
    const params = Promise.resolve({ id: 't' });
    try {
        for (const path of ['page', 'new/page', '[id]/page', '[id]/edit/page']) {
            const { default: Page } = await import('../../app/admin/trainings/' + path + '.tsx');
            setServerMe(member);
            const denied = await ssr(await Page({ params }));
            assert.match(denied, /此页面仅管理员可访问/);
            assert.doesNotMatch(denied, /data-kapok-sensitive|<form/);
            setServerMe(me);
            const allowed = await ssr(await Page({ params }));
            assert.match(allowed, /data-kapok-sensitive="true" hidden/);
            assert.doesNotMatch(allowed, /private training|<form/);
        }
        const { default: TrainingPage } = await import('../../app/trainings/[id]/page.tsx');
        setServerMe(member);
        const denied = await ssr(await TrainingPage({ params, searchParams: Promise.resolve({ view: 'member' }) }));
        assert.match(denied, /此页面仅管理员可访问/);
        assert.doesNotMatch(denied, /data-kapok-sensitive/);
        const ordinary = await ssr(await TrainingPage({ params, searchParams: Promise.resolve({ view: ['member', 'member'] }) }));
        assert.match(ordinary, /data-bloom-workspace/);
        assert.match(ordinary, /data-kapok-sensitive/);
        assert.doesNotMatch(ordinary, /返回训练管理/);
        setServerMe(me);
        const preview = await ssr(await TrainingPage({ params, searchParams: Promise.resolve({ view: 'member' }) }));
        assert.match(preview, /class="app-shell with-nav video-workspace" data-surface="video"/);
        assert.match(preview, /href="\/admin\/trainings\/t" class="back-link video-back"/);
    } finally { setServerMe(undefined); }
});
