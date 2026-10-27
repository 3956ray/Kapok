import '../helpers/react-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setServerMe } from '../helpers/server-stubs.mjs';
const { VideoDiscussion } = await import('../../app/components/video-discussion.tsx');
const { HomeScreen, TrainingsScreen, TrainingScreen, MyScreen, InviteScreen, JoinScreen, BootstrapScreen } = await import('../../app/components/legacy-screens.tsx');
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
    for (const component of [HomeScreen, TrainingsScreen, MyScreen, InviteScreen, BootstrapScreen]) {
        const output = renderToStaticMarkup(h(component, { actorId: 'A' }));
        assert.ok(!output.includes('private A name') && !output.includes('private team'));
        assert.match(output, /hidden/);
    }
    assert.ok(!renderToStaticMarkup(h(JoinScreen, { actorId: 'A', token: 'secret-invite-token', returnTo: '/' })).includes('secret-invite-token'));
    assert.match(renderToStaticMarkup(h(TrainingScreen, { actorId: 'A', id: 't' })), /hidden/);
});
test('final C1 actual server-page SSR omits personalized business headings, profile and invitation token', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe(me);
    const cases = [
        ['../../app/page.tsx', {}], ['../../app/me/page.tsx', {}], ['../../app/trainings/page.tsx', {}],
        ['../../app/trainings/[id]/page.tsx', { params: Promise.resolve({ id: 't' }) }],
        ['../../app/videos/[id]/page.tsx', { params: Promise.resolve({ id: 'v' }), searchParams: Promise.resolve({ t: '12' }) }],
        ['../../app/admin/invites/page.tsx', {}], ['../../app/internal/bootstrap/page.tsx', {}]
    ];
    for (const [path, props] of cases) {
        const Page = (await import(path)).default;
        const tree = await Page(props);
        const stream = await renderToReadableStream(tree);
        await stream.allReady;
        const html = await new Response(stream).text();
        for (const secret of ['private A name', 'private team', 'private training', 'private video', 'withdrawn body']) assert.ok(!html.includes(secret), path + ': ' + secret);
        assert.match(html, /data-kapok-sensitive[^>]*hidden/);
    }
    const { JoinPage } = await import('../../app/components/join-page.tsx');
    const stream = await renderToReadableStream(await JoinPage({ token: 'private-join-token', target: '/reflections/r' }));
    await stream.allReady;
    assert.ok(!(await new Response(stream).text()).includes('private-join-token'));
});

test('final C1 unjoined official subject retains Home/My onboarding entry without business SSR', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe({ user: null, profile: null, membership: null, team: null });
    for (const path of ['../../app/page.tsx', '../../app/me/page.tsx']) {
        const Page = (await import(path)).default;
        const stream = await renderToReadableStream(await Page());
        await stream.allReady;
        const html = await new Response(stream).text();
        assert.match(html, /确认邀请并建档/);
        assert.ok(!html.includes('private A name'));
    }
    setServerMe(me);
});

test('final I5 actual disabled My server page does not render profile/team/admin payload', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe({ ...me, user: { ...me.user, status: 'deleted' } });
    const Page = (await import('../../app/me/page.tsx')).default;
    const stream = await renderToReadableStream(await Page());
    await stream.allReady;
    const html = await new Response(stream).text();
    for (const secret of ['private A name', 'private team', '/admin/invites', '/admin/members']) assert.ok(!html.includes(secret));
    setServerMe(me);
});

test('B all 24 route shells retain main landmark and hide primary tabs on editing/access/admin flows', async () => {
    const { renderToReadableStream } = await import('react-dom/server');
    setServerMe(me);
    const params = { params: Promise.resolve({ id:'r', token:'synthetic-invite-token' }), searchParams: Promise.resolve({}) };
    const routes = [
        ['', true], ['trainings', true], ['trainings/[id]', true], ['videos/[id]', true], ['growth', true],
        ['reflections/new', false], ['reflections/[id]', true], ['reflections/[id]/edit', false], ['reflections/[id]/sharing', false],
        ['me', true], ['me/edit', false], ['me/data', true], ['me/recycle', true], ['members', true], ['members/[id]', true],
        ['activity', true], ['announcements/[id]', true], ['admin/invites', false], ['admin/announcements', false], ['admin/members', false],
        ['login', false], ['join', false], ['join/[token]', false], ['internal/bootstrap', false],
    ];
    assert.equal(routes.length, 24);
    for (const [route, nav] of routes) {
        const Page = (await import(`../../app/${route ? route + '/' : ''}page.tsx`)).default;
        const stream = await renderToReadableStream(await Page(params)); await stream.allReady;
        const html = await new Response(stream).text();
        assert.match(html, /<main id="main-content">/, route);
        assert.equal(html.includes('aria-label="主要导航"'), nav, route);
        for (const secret of ['private A name', 'private team', 'synthetic-invite-token']) assert.ok(!html.includes(secret), route + ': ' + secret);
    }
});
