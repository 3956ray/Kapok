import { learningJsonBytes } from '../contracts/learning.ts';
import type { Principal } from '../contracts/index';
import { DomainError } from './domain.ts';
import type { Service } from './domain';
import { actorKey } from './identity.ts';

export const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie, oai-authenticated-user-id, Cf-Access-Jwt-Assertion', 'X-Content-Type-Options': 'nosniff' };
export async function dispatchApi(request: Request, path: string[], principal: Principal | null, service: Service): Promise<Response> {
  const requestId = crypto.randomUUID();
  let actor: string | undefined;
  try {
    if (!principal) throw new DomainError('UNAUTHENTICATED', '请先登录。', 401);
    actor = await actorKey(principal);
    const route = path.join('/');
    const method = request.method;
    const putBytes = method === 'PUT' && /^(?:uploads\/[^/]+|learning\/posts\/[^/]+\/images\/[^/]+)\/content$/.test(route);
    const maxBody = method === 'POST' && route === 'uploads' ? 80000 : /^learning\/posts(?:\/[^/]+)?$/.test(route) ? learningJsonBytes : 40000;
    if (!['GET', 'HEAD'].includes(method)) {
      if (request.headers.get('Origin') !== new URL(request.url).origin) throw new DomainError('FORBIDDEN', '请从本站提交操作。', 403);
      if (request.headers.get('X-Kapok-Actor') !== actor) throw new DomainError('ACCOUNT_CHANGED', '登录账号已变化，请重新加载页面后再提交。', 409);
      if (!putBytes && !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new DomainError('INVALID_INPUT', '请提交JSON格式内容。', 415);
      if (!putBytes && Number(request.headers.get('Content-Length') ?? 0) > maxBody) throw new DomainError('INVALID_INPUT', '提交内容过长。', 413);
    }
    if (route === 'admin/invites' || route === 'internal/bootstrap') throw new DomainError('NOT_FOUND', '此功能暂不可用。', 404);
    if (method === 'POST' && route === 'join' && principal.provider !== 'access') throw new DomainError('FORBIDDEN', '请使用已验证的邮箱账号完善资料。', 403);
    const allowedBeforeJoining = (method === 'GET' && (route === 'bootstrap' || route === 'me')) || (method === 'POST' && route === 'join');
    if (principal.provider === 'access' && !allowedBeforeJoining) await service.activeMember(principal);
    const key = request.headers.get('Idempotency-Key') ?? '';
    let importPrecondition: unknown;
    const importHeader = request.headers.get('X-Kapok-Import');
    if (importHeader !== null) {
      if (importHeader.length > 2000) throw new DomainError('INVALID_INPUT', '导入审批条件无效。');
      try { importPrecondition = JSON.parse(importHeader); } catch { throw new DomainError('INVALID_INPUT', '导入审批条件无效。'); }
      if (!importPrecondition || method !== 'POST' || !(route === 'trainings/publish' || /^trainings\/[^/]+\/videos$/.test(route))) throw new DomainError('INVALID_INPUT', '导入审批条件无效。');
    }
    const body = async () => {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = []; let count = 0;
      try { if (reader) while (true) { const item = await reader.read(); if (item.done) break; count += item.value.length; if (count > maxBody) throw new DomainError('INVALID_INPUT', '提交内容过长。', 413); chunks.push(item.value); } }
      finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder().decode(bytes);
      try { return JSON.parse(text); } catch { throw new DomainError('INVALID_INPUT', '提交内容无法读取。'); }
    };
    const emptyBody = async () => { const value=await body(); if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length) throw new DomainError('INVALID_INPUT','此操作不接受额外内容。'); };
    let data: unknown;
    if (method === 'GET' && route === 'bootstrap') data = await service.getBootstrap(principal);
    else if (method === 'GET' && route === 'me/export') data = await service.exportOwnData(principal);
    else if (method === 'GET' && route === 'me/recycle') data = await service.listDeletedReflections(principal);
    else if (method === 'POST' && route === 'me/leave') data = await service.leaveTeam(principal, await body(), key);
    else if (method === 'GET' && route === 'admin/members') data = await service.listManagedMembers(principal);
    else if (method === 'PATCH' && path[0] === 'admin' && path[1] === 'members' && path.length === 3) data = await service.updateMembership(principal, path[2], await body(), key);
    else if (method === 'GET' && route === 'me') data = await service.getAccount(principal);
    else if (method === 'POST' && route === 'join') data = await service.join(principal, await body(), key);
    else if (method === 'PATCH' && route === 'me') data = await service.updateProfile(principal, await body(), key);
    else if (method === 'GET' && route === 'reflections') data = await service.listMyReflections(principal);
    else if (method === 'POST' && route === 'reflections') data = await service.saveReflection(principal, null, await body(), key);
    else if (method === 'POST' && path[0] === 'reflections' && path[2] === 'restore' && path.length === 3) data = await service.restoreReflection(principal, path[1], await body(), key);
    else if (method === 'GET' && path[0] === 'reflections' && path.length === 2) data = await service.getReflection(principal, path[1]);
    else if (method === 'GET' && path[0] === 'reflections' && path[2] === 'edit' && path.length === 3) data = await service.getOwnReflection(principal, path[1]);
    else if (method === 'PATCH' && path[0] === 'reflections' && path.length === 2) data = await service.saveReflection(principal, path[1], await body(), key);
    else if (method === 'DELETE' && path[0] === 'reflections' && path.length === 2) data = await service.deleteReflection(principal, path[1], await body(), key);
    else if (method === 'PUT' && path[0] === 'reflections' && path[2] === 'grants' && path.length === 3) data = await service.shareReflection(principal, path[1], await body(), key);
    else if (method === 'PUT' && path[0] === 'reflections' && path[2] === 'publication' && path.length === 3) data = await service.publishReflection(principal, path[1], await body(), key);
    else if (method === 'GET' && route === 'members') data = await service.listMembers(principal);
    else if (method === 'GET' && path[0] === 'members' && path.length === 2) data = await service.getMemberProfile(principal, path[1]);
    else if (method === 'GET' && route === 'activity') {
      const url = new URL(request.url);
      data = await service.listActivity(principal, url.searchParams.get('cursor'), Number(url.searchParams.get('limit') ?? 20));
    }
    else if (method === 'GET' && route === 'activity/learning') {
      data = await service.listCurrentLearningActivity(principal, (new URL(request.url).searchParams.get('ids') ?? '').split(','));
    }
    else if (method === 'GET' && route === 'announcements') data = await service.listAnnouncements(principal);
    else if (method === 'POST' && route === 'announcements') data = await service.saveAnnouncement(principal, null, await body(), key);
    else if (method === 'GET' && path[0] === 'announcements' && path.length === 2) data = await service.getAnnouncement(principal, path[1]);
    else if (method === 'PATCH' && path[0] === 'announcements' && path.length === 2) data = await service.saveAnnouncement(principal, path[1], await body(), key);
    else if (route === 'learning/collections' && method === 'GET') data = await service.listTopicCollections(principal);
    else if (route === 'learning/collections' && method === 'POST') data = await service.saveTopicCollection(principal, null, await body(), key);
    else if (route === 'learning/collections/editable' && method === 'GET') data = await service.listEditableTopicCollections(principal);
    else if (route === 'learning/collections/sources' && method === 'GET') data = await service.listTopicSources(principal);
    else if (route === 'learning/featured' && method === 'GET') data = new URL(request.url).searchParams.get('view') === 'admin'
      ? await service.getFeaturedTopics(principal, true) : await service.getFeaturedTopics(principal);
    else if (route === 'learning/featured' && method === 'PATCH') data = await service.updateFeaturedTopics(principal, await body(), key);
    else if (path[0] === 'learning' && path[1] === 'collections' && path.length >= 3) {
      const id = path[2];
      const action = path[3];
      if (path.length === 3 && method === 'GET') data = new URL(request.url).searchParams.get('view') === 'draft'
        ? await service.getTopicCollection(principal, id, 'draft') : await service.getTopicCollection(principal, id);
      else if (path.length === 3 && method === 'PATCH') data = await service.saveTopicCollection(principal, id, await body(), key);
      else if (path.length === 4 && method === 'GET' && action === 'reflection-seed' && !new URL(request.url).searchParams.has('view')) data = await service.getLearningReflectionSeed(principal, 'topic_collection', id);
      else if (path.length === 4 && method === 'POST' && action === 'publish') data = await service.publishTopicCollection(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'withdraw') data = await service.withdrawTopicCollection(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'items') data = await service.addTopicItems(principal, id, await body(), key);
      else if (path.length === 4 && method === 'DELETE' && action === 'items') data = await service.removeTopicItem(principal, id, await body(), key);
      else if (path.length === 5 && method === 'PATCH' && action === 'items' && path[4] === 'order') data = await service.orderTopicItems(principal, id, await body(), key);
      else throw new DomainError('NOT_FOUND', '未找到此功能。', 404);
    }
    else if (route === 'learning/posts' && method === 'GET') data = await service.listLearningPosts(principal);
    else if (route === 'learning/posts' && method === 'POST') data = await service.saveLearningPost(principal, null, await body(), key);
    else if (route === 'learning/mine' && method === 'GET') data = await service.listMyLearningPosts(principal);
    else if (path[0] === 'learning' && path[1] === 'posts' && path.length >= 3) {
      const id = path[2];
      const action = path[3];
      const draft = new URL(request.url).searchParams.get('view') === 'draft';
      if (path.length === 3 && method === 'GET') data = draft
        ? await service.getLearningPost(principal, id, 'draft') : await service.getLearningPost(principal, id);
      else if (path.length === 3 && method === 'PATCH') data = await service.saveLearningPost(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'publish') data = await service.publishLearningPost(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'inclusion-retry') data = await service.retryLearningInclusion(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'withdraw') data = await service.withdrawLearningPost(principal, id, await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'hide') data = await service.hideLearningPost(principal, id, await body(), key);
      else if (path.length === 4 && method === 'GET' && action === 'reflection-seed' && !new URL(request.url).searchParams.has('view')) data = await service.getLearningReflectionSeed(principal, 'learning_post', id);
      else if (!draft && action === 'activity' && path.length === 4 && method === 'GET') data = await service.getLearningActivity(principal, id);
      else if (!draft && action === 'activity' && path.length === 4 && (method === 'POST' || method === 'DELETE'))
        data = await service.changeLearningActivity(principal, id, await body(), key, method === 'POST');
      else if (action === 'comments' && path.length === 4 && method === 'GET') data = await service.listLearningComments(principal, id);
      else if (action === 'comments' && path.length === 4 && method === 'POST') data = await service.saveLearningComment(principal, id, null, await body(), key);
      else if (action === 'comments' && path.length === 5 && method === 'PATCH') data = await service.saveLearningComment(principal, id, path[4], await body(), key);
      else if (action === 'comments' && path.length === 6 && path[5] === 'moderation' && method === 'POST') data = await service.moderateLearningComment(principal, id, path[4], await body(), key);
      else if (path.length === 4 && method === 'POST' && action === 'images') data = await service.reserveLearningImage(principal, id, await body(), key);
      else if (action === 'images' && path.length === 5 && method === 'GET') {
        return await service.getLearningImage(principal, id, path[4], draft ? 'draft' : 'published');
      } else if (action === 'images' && path.length === 5 && method === 'DELETE') {
        data = await service.removeLearningImage(principal, id, path[4], await body(), key);
      } else if (action === 'images' && path.length === 6 && path[5] === 'content' && method === 'PUT') {
        data = await service.uploadLearningImage(principal, id, path[4], request.body, request.headers.get('Content-Type'), key);
      } else if (action === 'images' && path.length === 6 && path[5] === 'complete' && method === 'POST') {
        data = await service.completeLearningImage(principal, id, path[4], await body(), key);
      } else throw new DomainError('NOT_FOUND', '未找到此功能。', 404);
    }
    else if (method === 'GET' && route === 'trainings/import-inventory') data = await service.importInventory(principal);
    else if (method === 'GET' && route === 'trainings') data = await service.listTrainings(principal);
    else if (method === 'POST' && route === 'trainings') data = await service.saveTraining(principal, null, await body(), key);
    else if (method === 'POST' && route === 'trainings/publish') data = await service.publishTraining(principal, await body(), key, importPrecondition);
    else if (method === 'GET' && path[0] === 'trainings' && path.length === 2) data = await service.getTraining(principal, path[1], new URL(request.url).searchParams.get('view') === 'member' ? 'member' : undefined);
    else if (method === 'PATCH' && path[0] === 'trainings' && path.length === 2) data = await service.saveTraining(principal, path[1], await body(), key);
    else if (method === 'POST' && path[0] === 'trainings' && path[2] === 'videos' && path.length === 3) data = await service.addVideo(principal, path[1], await body(), key, importPrecondition);
    else if (method === 'GET' && path[0] === 'videos' && path.length === 2) data = await service.getVideo(principal, path[1]);
    else if (method === 'PATCH' && path[0] === 'videos' && path.length === 2) data = await service.updateVideo(principal, path[1], await body(), key);
    else if (method === 'GET' && path[0] === 'videos' && path[2] === 'media' && path.length === 3) return await service.getMedia(principal, path[1], request.headers.get('Range'));
    else if (method === 'GET' && path[0] === 'videos' && path[2] === 'comments' && path.length === 3) data = await service.listComments(principal, path[1]);
    else if (method === 'POST' && path[0] === 'videos' && path[2] === 'comments' && path.length === 3) data = await service.saveComment(principal, path[1], null, await body(), key);
    else if (method === 'PATCH' && path[0] === 'videos' && path[2] === 'comments' && path.length === 4) data = await service.saveComment(principal, path[1], path[3], await body(), key);
    else if (method === 'POST' && path[0] === 'comments' && path[2] === 'moderation' && path.length === 3) data = await service.moderateComment(principal, path[1], await body(), key);
    else if (method === 'GET' && route === 'collections') data = await service.listCollections(principal);
    else if (method === 'GET' && path[0] === 'collections' && path.length === 3 && path[2] === 'reflection-seed') data = await service.getCollectionReflectionSeed(principal, path[1]);
    else if (method === 'POST' && route === 'collections') data = await service.saveCollection(principal, null, await body(), key);
    else if (method === 'PATCH' && path[0] === 'collections' && path.length === 2) data = await service.saveCollection(principal, path[1], await body(), key);
    else if (method === 'GET' && route === 'uploads/policy') data = await service.getUploadPolicy(principal);
    else if (method === 'GET' && path[0] === 'uploads' && path.length === 2) data = await service.getUpload(principal, path[1]);
    else if (method === 'GET' && route === 'uploads') data = await service.listUploads(principal, new URL(request.url).searchParams.get('cursor'));
    else if (method === 'POST' && route === 'uploads') data = await service.createUpload(principal, await body(), key);
    else if (method === 'PUT' && path[0] === 'uploads' && path[2] === 'content' && path.length === 3) data = request.headers.has('X-Kapok-Part') ? await service.putUploadPart(principal, path[1], request.body, key, Number(request.headers.get('X-Kapok-Part'))) : await service.putUpload(principal, path[1], request.body, key);
    else if (method === 'POST' && path[0] === 'uploads' && path[2] === 'complete' && path.length === 3) { await emptyBody(); data = await service.completeUpload(principal, path[1], key); }
    else if (method === 'POST' && path[0] === 'uploads' && path[2] === 'cancel' && path.length === 3) { await emptyBody(); data = await service.cancelUpload(principal, path[1], key); }
    else throw new DomainError('NOT_FOUND', '此功能暂不可用。', 404);
    return Response.json({ data, requestId }, { headers: { ...privateHeaders, 'X-Kapok-Actor': actor } });
  } catch (error) {
    const known = error instanceof DomainError ? error : new DomainError('SERVICE_UNAVAILABLE', '暂时未能完成请求，请稍后重试。', 503, true);
    return Response.json({ error: { code: known.code, message: known.message, retryable: known.retryable }, requestId }, { status: known.status, headers: { ...privateHeaders, ...(actor ? { 'X-Kapok-Actor': actor } : {}) } });
  }
}
