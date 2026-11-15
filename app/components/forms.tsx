'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import type { JoinInput, JoinResult, Me, WriteResult } from '../../lib/contracts';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { acknowledgeMutation, clearNavigationRoute, currentRoute, navigationBuffer, pendingMutationKey } from '../../lib/client/navigation-state';
import { consumeRegistrationPrefill } from '../../lib/client/registration-prefill';
import { registrationDraft } from '../../lib/client/registration-draft';
import type { PendingRegistration } from '../../lib/client/registration-draft';
import { accountRoleLabel } from './account-profile-card';
import { useAccountSession } from './secure-resource';
import { preserveTargetHash } from './navigation';

type Fields = { discName: string; jerseyNumber: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;
const message = (e: unknown) => e instanceof Error ? e.message : '暂时未能完成操作，请保留内容并重试。';
function validate(fields: Fields): FieldErrors {
    return {
        ...(!fields.discName.trim() || fields.discName.trim().length > 20 ? { discName: '盘名需为1–20字。' } : {}),
        ...(!fields.jerseyNumber.trim() || fields.jerseyNumber.trim().length > 4 ? { jerseyNumber: '背号需为1–4字。' } : {})
    };
}
function focusError(form: HTMLFormElement, errors: FieldErrors) {
    const field = Object.keys(errors)[0];
    if (field) form.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
}
function fieldErrorsFor(error: ApiError): FieldErrors {
    if (error.code === 'INVALID_INPUT') return { discName: error.message, jerseyNumber: error.message };
    return {};
}
function showFieldError(error: unknown, form: HTMLFormElement, setErrors: (errors: FieldErrors) => void) {
    if (!(error instanceof ApiError)) return;
    const fields = fieldErrorsFor(error);
    if (Object.keys(fields).length) {
        setErrors(fields);
        focusError(form, fields);
    }
}
function useSubmission() {
    const session = useAccountSession();
    const key = useRef(createRequestKey());
    const [busy, setBusyState] = useState(false);
    const submitting = useRef(false);
    const setBusy = (value: boolean) => { submitting.current = value; setBusyState(value); };
    const [error, setError] = useState('');
    const [errors, setErrors] = useState<FieldErrors>({});
    return { session, key, resetKey: () => { key.current = createRequestKey(); }, busy, submitting, setBusy, error, setError, errors, setErrors };
}
function useEnrollmentSubmission(actorId: string, fields: Fields, draft: ReturnType<typeof registrationDraft>, initial: PendingRegistration | null) {
    const path = 'join';
    const s = useSubmission();
    const [pending, setPending] = useState(initial);
    const rejectedField = useRef<{ form: HTMLFormElement; errors: FieldErrors; generation: number } | null>(null);
    useLayoutEffect(() => {
        if (s.busy || pending || !rejectedField.current) return;
        const { form, errors, generation } = rejectedField.current;
        rejectedField.current = null;
        // React has removed the submitting fieldset's disabled state in this commit.
        if (s.session.isCurrent(generation) && form.isConnected && !form.closest('[hidden], [inert]')) focusError(form, errors);
    }, [pending, s.busy, s.session]);
    async function submit(body: JoinInput, onResult: (result: JoinResult) => void, form: HTMLFormElement) {
        if (s.submitting.current) return;
        if (navigator.onLine === false) {
            s.setError(pending ? '网络已断开，暂时无法核对上次提交。' : '网络已断开，尚未提交。连接恢复后可以重试。');
            return;
        }
        s.setBusy(true);
        s.setError('');
        try {
            const generation = await s.session.authorize();
            if (pending) {
                const current = await api<Me>('me', undefined, actorId);
                if (!s.session.isCurrent(generation)) return;
                if (current.membership || current.user?.status === 'deleted') {
                    await s.session.verify('正在核对上次入队结果…');
                    return;
                }
            }
            const request = pending ?? { body, key: pendingMutationKey(actorId, 'POST', path, body, s.key.current(actorId, body)) };
            draft.write({ fields, pending: request });
            setPending(request);
            try {
                const value = await api<JoinResult>(path, { method: 'POST', actorId, ...request });
                if (!s.session.isCurrent(generation)) return;
                const confirmed = await api<Me>('me', undefined, actorId);
                if (!s.session.isCurrent(generation)) return;
                if (confirmed.user?.status !== 'active' || confirmed.user.id !== value.me.user?.id ||
                    confirmed.membership?.status !== 'active' ||
                    JSON.stringify(confirmed.membership) !== JSON.stringify(value.me.membership)) {
                    throw new ApiError({ error: { code: 'FORBIDDEN', message: '成员权限已发生变化，请重新确认。', retryable: false }, requestId: '' });
                }
                acknowledgeMutation(actorId, 'POST', path, request.body);
                draft.clear();
                setPending(null);
                onResult(value);
            } catch (error) {
                if (!s.session.isCurrent(generation)) return;
                if (error instanceof ApiError && !error.retryable) {
                    acknowledgeMutation(actorId, 'POST', path, request.body);
                    draft.write({ fields, pending: null });
                    setPending(null);
                    const errors = fieldErrorsFor(error);
                    if (Object.keys(errors).length) {
                        rejectedField.current = { form, errors, generation };
                        s.setErrors(errors);
                    }
                    s.setError(message(error));
                    if (error.code === 'FORBIDDEN') await s.session.verify();
                } else {
                    s.setError('暂时无法确认是否加入成功。你的填写仍在，可以核对上次提交。');
                    await s.session.verify('正在确认上次资料提交结果…');
                }
            }
        } catch (error) {
            s.setError(message(error));
            if (pending) await s.session.verify('正在核对上次入队结果…');
        } finally {
            s.setBusy(false);
        }
    }
    return { ...s, pending, submit };
}
function ProfileFields({ fields, setFields, errors }: {
    fields: Fields; setFields: Dispatch<SetStateAction<Fields>>; errors: FieldErrors;
}) {
    const id = useId();
    return <>{(['discName', 'jerseyNumber'] as const).map(name => <div key={name}>
        <label htmlFor={`${id}-${name}`}>{name === 'discName' ? '盘名' : '背号'}</label>
        <input id={`${id}-${name}`} name={name} value={fields[name]} onChange={e => { const value = e.target.value; setFields(previous => ({ ...previous, [name]: value })); }}
            maxLength={name === 'discName' ? 20 : 4} required autoComplete={name === 'discName' ? 'nickname' : 'off'}
            aria-invalid={!!errors[name]} aria-describedby={`${id}-${name}-hint${errors[name] ? ` ${id}-${name}-error` : ''}`} />
        <span id={`${id}-${name}-hint`} className="field-hint">{name === 'discName' ? '1–20字，可使用队内熟悉的称呼。' : '1–4字，07 会完整保留。'}</span>
        {errors[name] && <p id={`${id}-${name}-error`} className="form-error">{errors[name]}</p>}
    </div>)}</>;
}
export function EnrollmentDestination({ returnTo, role }: { returnTo: string; role: NonNullable<Me['membership']>['role'] }) {
    const router = useRouter();
    const destination = role !== 'admin' && returnTo.startsWith('/admin/') ? '/' : returnTo;
    useEffect(() => {
        const target = preserveTargetHash(destination);
        const current = window.location.pathname + window.location.search + window.location.hash;
        if (target === current) router.refresh();
        else router.replace(target);
    }, [destination, router]);
    return <p className="notice" role="status">已确认 Kapok 成员资格，正在继续…</p>;
}

export function JoinForm({ actorId, returnTo }: { actorId: string; returnTo: string }) {
    const [draft] = useState(() => registrationDraft(actorId));
    const [stored] = useState(() => {
        const own = draft.read();
        const prefill = consumeRegistrationPrefill(actorId);
        if (own || !prefill) return own;
        const restored = { fields: prefill, pending: null };
        draft.write(restored);
        return restored;
    });
    const [fields, setFields] = useState<Fields>(stored?.fields ?? { discName: '', jerseyNumber: '' });
    const latestFields = useRef(fields);
    const s = useEnrollmentSubmission(actorId, fields, draft, stored?.pending ?? null);
    const [done, setDone] = useState<JoinResult | null>(null);
    const form = useRef<HTMLFormElement>(null);
    const dialog = useRef<HTMLDialogElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const dialogTitle = useId();
    const session = s.session;
    useLayoutEffect(() => session.subscribe(ended => {
        if (dialog.current?.open) dialog.current.close();
        if (ended) draft.clear();
    }), [draft, session]);
    function closeConfirmation() {
        dialog.current?.close();
        trigger.current?.focus();
    }
    function submit() {
        if (!form.current) return;
        void s.submit({ ...fields, intent: 'register', confirmed: true, returnTo: preserveTargetHash(returnTo) }, setDone, form.current);
    }
    if (done?.me.membership) return <EnrollmentDestination returnTo={done.returnTo} role={done.me.membership.role} />;
    return <form ref={form} data-own-buffer noValidate onSubmit={event => {
        event.preventDefault();
        if (s.busy || s.submitting.current || dialog.current?.open) return;
        if (s.pending) { submit(); return; }
        const errors = validate(fields);
        s.setErrors(errors);
        if (Object.keys(errors).length) { focusError(event.currentTarget, errors); return; }
        dialog.current?.showModal();
        cancel.current?.focus();
    }}>
        <fieldset disabled={s.busy || !!s.pending}>
            <ProfileFields fields={fields} setFields={next => {
                const edited = typeof next === 'function' ? next(latestFields.current) : next;
                latestFields.current = edited;
                setFields(edited);
                draft.write({ fields: edited, pending: null });
            }} errors={s.errors} />
        </fieldset>
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        {s.pending && !s.busy && !s.error && <p role="status">上次提交的结果尚待确认。</p>}
        {s.busy && <p role="status">正在核对注册状态，请稍候…</p>}
        <button ref={trigger} type="submit" disabled={s.busy}>{s.pending ? '核对上次入队请求' : '保存资料并加入'}</button>
        <dialog ref={dialog} className="registration-confirm" aria-labelledby={dialogTitle} onCancel={event => { event.preventDefault(); closeConfirmation(); }}>
            <h2 id={dialogTitle}>确认加入 Kapok？</h2>
            <p>盘名 {fields.discName.trim()}</p>
            <p>背号 {fields.jerseyNumber.trim()}</p>
            <p>队伍 Kapok。新账号的成员角色由系统分配。</p>
            <div className="registration-confirm-actions">
                <button ref={cancel} type="button" className="secondary" onClick={closeConfirmation}>返回修改</button>
                <button type="button" onClick={() => { if (dialog.current?.open) { closeConfirmation(); submit(); } }}>确认提交</button>
            </div>
        </dialog>
    </form>;
}
export function ProfileForm({ me, actorId, onSaved, onCancel }: { me: Me; actorId: string; onSaved?: (me: Me) => void; onCancel?: () => void }) {
    const s = useSubmission();
    const [receipt, setReceipt] = useState<Me | null>(null);
    const current = receipt?.profile && (!me.profile || receipt.profile.version >= me.profile.version) ? receipt : me;
    const [pendingBuffer] = useState(() => navigationBuffer(actorId, currentRoute(), 'profile-pending'));
    const pending = useRef<{ body: Fields & { bio?: string; expectedVersion: number }; key: string } | null>(pendingBuffer.read());
    const [fields, setFields] = useState<Fields & { bio: string }>({ discName: me.profile?.discName ?? '', jerseyNumber: me.profile?.jerseyNumber ?? '', bio: me.profile?.bio ?? '' });
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'edited' | 'conflict'>('idle');
    const editVersion = useRef(0);
    if (!current.user || !current.profile) return null;
    const matchesCurrent = current.profile.discName === fields.discName.trim() && current.profile.jerseyNumber === fields.jerseyNumber.trim() && (current.profile.bio ?? '') === fields.bio.trim();
    const conflict = saveStatus === 'conflict' || (!matchesCurrent && saveStatus !== 'edited');
    return <form onSubmit={async event => {
        event.preventDefault();
        if (s.busy || s.submitting.current || !current.profile) return;
        const form = event.currentTarget;
        const errors = validate(fields);
        if (fields.bio.trim().length > 160) { s.setError('简介最多160字。'); return; }
        s.setErrors(errors);
        if (Object.keys(errors).length) { focusError(event.currentTarget, errors); return; }
        const previous = pending.current;
        const request = previous && previous.body.discName === fields.discName && previous.body.jerseyNumber === fields.jerseyNumber && previous.body.bio === fields.bio
            ? previous
            : { body: { ...fields, expectedVersion: current.profile.version }, key: '' };
        const body = request.body;
        if (!request.key) request.key = s.key.current(actorId, body);
        const submittedVersion = editVersion.current;
        s.setError(''); s.setBusy(true);
        try {
            const generation = await s.session.authorize();
            pending.current = request;
            pendingBuffer.write(request);
            const result = await api<WriteResult>('me', { method: 'PATCH', actorId, body, key: request.key });
            if (!s.session.isCurrent(generation)) return;
            acknowledgeMutation(actorId, 'PATCH', 'me', body);
            pending.current = null;
            pendingBuffer.clear();
            if (result.me.user?.status !== 'active' || !result.me.profile) { await s.session.verify(); return; }
            setReceipt(result.me);
            const matches = result.me.profile?.discName === fields.discName.trim() && result.me.profile?.jerseyNumber === fields.jerseyNumber.trim() && (result.me.profile?.bio ?? '') === fields.bio.trim();
            setSaveStatus(editVersion.current !== submittedVersion ? 'edited' : matches ? 'saved' : 'conflict');
            if (editVersion.current === submittedVersion && matches && onSaved) { clearNavigationRoute(actorId, currentRoute()); onSaved(result.me); }
        } catch (e) {
            if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
                pending.current = null; pendingBuffer.clear();
                s.setError('资料已在其他位置更新。已保留上方输入，请核对下方当前资料后明确保存。');
                setSaveStatus('conflict');
                await s.session.verify();
            } else { s.setError(message(e)); setSaveStatus('edited'); }
            showFieldError(e, form, s.setErrors);
        }
        finally { s.setBusy(false); }
    }}>
        <ProfileFields fields={fields} errors={s.errors} setFields={next => { editVersion.current += 1; setFields(previous => ({ ...previous, ...(typeof next === 'function' ? next(previous) : next) })); setSaveStatus('edited'); }} />
        <label>简介（选填）<textarea name="bio" maxLength={160} placeholder="最多 160 字" value={fields.bio} onChange={event => {
            const bio = event.target.value;
            editVersion.current += 1;
            setFields(previous => ({ ...previous, bio }));
            setSaveStatus('edited');
        }} /></label>
        <p className="account-editor-role"><span>队内角色</span><strong>{accountRoleLabel(me.membership?.status === 'active' ? me.membership.role : undefined)}</strong><span>（只读）</span></p>
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        {saveStatus === 'saved' && matchesCurrent && <p className="notice success" role="status">资料已保存到账号。</p>}
        {saveStatus === 'edited' && !s.busy && <p className="muted" role="status">有尚未保存的修改。</p>}
        {conflict && <p className="notice" role="status">上方输入与当前账号资料不同，仍未保存；当前账号资料为 {current.profile.discName} / {current.profile.jerseyNumber}；简介：{current.profile.bio || '（未填写）'}。请核对后再保存。</p>}
        {saveStatus === 'conflict' && <button type="button" className="secondary" disabled={s.busy} onClick={() => void s.session.verify()}>重新载入当前资料（保留输入）</button>}
        <div className="account-editor-actions">
            {onCancel && <button type="button" className="secondary" disabled={s.busy} onClick={() => { pendingBuffer.clear(); clearNavigationRoute(actorId, currentRoute()); onCancel(); }}>取消修改</button>}
            <button type="submit" disabled={s.busy}>{s.busy ? '正在保存…' : saveStatus === 'conflict' ? '基于当前资料版本保存输入' : '保存资料'}</button>
        </div>
    </form>;
}
