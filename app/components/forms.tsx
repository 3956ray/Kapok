'use client';
import { useId, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { BootstrapResult, InviteResult, JoinResult, Me, WriteResult } from '../../lib/contracts';
import { api, ApiError, createRequestKey } from '../../lib/client/api';
import { acknowledgeMutation, clearNavigationRoute, currentRoute, navigationBuffer } from '../../lib/client/navigation-state';
import { useAccountSession } from './secure-resource';

type Fields = { discName: string; jerseyNumber: string };
type FieldErrors = Partial<Record<keyof Fields | 'token', string>>;
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
function showFieldError(error: unknown, form: HTMLFormElement, setErrors: (errors: FieldErrors) => void) {
    if (!(error instanceof ApiError)) return;
    const fields = /INVITE/.test(error.code) ? { token: error.message } : error.code === 'INVALID_INPUT' ? { discName: error.message, jerseyNumber: error.message } : {};
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
export function JoinForm({ actorId, token = '', returnTo }: { actorId: string; token?: string; returnTo: string }) {
    const s = useSubmission();
    const id = useId();
    const [invite, setInvite] = useState(token);
    const [fields, setFields] = useState<Fields>({ discName: '', jerseyNumber: '' });
    const [done, setDone] = useState<JoinResult | null>(null);
    if (done) {
        const active = done.me.user?.status === 'active' && done.me.membership?.status === 'active';
        return <section className={`notice ${active ? 'success' : ''}`} role="status">
            <h2>{active ? '已加入队伍' : '原加入请求已完成，当前成员资格未生效'}</h2>
            <p>{active ? `当前账号背号为 ${done.me.profile?.jerseyNumber}。` : '当前成员状态已变化；重试不会重新加入或恢复成员资格。请联系管理员确认。'}</p>
            <a className="button" href={active ? done.returnTo : '/me'}>{active ? '继续原来的内容' : '查看当前账号状态'}</a>
        </section>;
    }
    return <form onSubmit={async event => {
        event.preventDefault();
        if (s.busy || s.submitting.current) return;
        const form = event.currentTarget;
        const errors = { ...validate(fields), ...(invite.trim().length < 16 ? { token: '请填写有效邀请令牌。' } : {}) };
        s.setErrors(errors);
        if (Object.keys(errors).length) { focusError(event.currentTarget, errors); return; }
        const body = { token: invite, ...fields, returnTo };
        s.setError(''); s.setBusy(true);
        try {
            const generation = await s.session.authorize();
            const result = await api<JoinResult>('join', { method: 'POST', actorId, body, key: s.key.current(actorId, body) });
            if (s.session.isCurrent(generation)) { acknowledgeMutation(actorId, 'POST', 'join', body); setDone(result); }
        } catch (e) {
            s.setError(message(e));
            showFieldError(e, form, s.setErrors);
        } finally { s.setBusy(false); }
    }}>
        <label htmlFor={`${id}-token`}>邀请令牌</label>
        <input id={`${id}-token`} name="token" value={invite} onChange={e => setInvite(e.target.value)} required maxLength={200} autoComplete="off" autoCapitalize="none" spellCheck={false}
            aria-invalid={!!s.errors.token} aria-describedby={s.errors.token ? `${id}-token-error` : undefined} />
        {s.errors.token && <p id={`${id}-token-error`} className="form-error">{s.errors.token}</p>}
        <ProfileFields fields={fields} setFields={setFields} errors={s.errors} />
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        <button disabled={s.busy}>{s.busy ? '正在加入…' : '保存资料并加入'}</button>
        <p className="muted">仅提交成功后消耗邀请；失败时请保留输入重试。</p>
    </form>;
}
export function ProfileForm({ me, actorId, onSaved, onCancel }: { me: Me; actorId: string; onSaved?: (me: Me) => void; onCancel?: () => void }) {
    const s = useSubmission();
    const [receipt, setReceipt] = useState<Me | null>(null);
    const current = receipt?.profile && (!me.profile || receipt.profile.version >= me.profile.version) ? receipt : me;
    const [pendingBuffer] = useState(() => navigationBuffer(actorId, currentRoute(), 'profile-pending'));
    const pending = useRef<{ body: Fields & { expectedVersion: number }; key: string } | null>(pendingBuffer.read());
    const [fields, setFields] = useState<Fields>({ discName: me.profile?.discName ?? '', jerseyNumber: me.profile?.jerseyNumber ?? '' });
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'edited' | 'conflict'>('idle');
    const editVersion = useRef(0);
    if (!current.user || !current.profile) return null;
    const matchesCurrent = current.profile.discName === fields.discName.trim() && current.profile.jerseyNumber === fields.jerseyNumber.trim();
    const conflict = saveStatus === 'conflict' || (!matchesCurrent && saveStatus !== 'edited');
    return <form onSubmit={async event => {
        event.preventDefault();
        if (s.busy || s.submitting.current || !current.profile) return;
        const form = event.currentTarget;
        const errors = validate(fields);
        s.setErrors(errors);
        if (Object.keys(errors).length) { focusError(event.currentTarget, errors); return; }
        const previous = pending.current;
        const request = previous && previous.body.discName === fields.discName && previous.body.jerseyNumber === fields.jerseyNumber
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
            const matches = result.me.profile?.discName === fields.discName.trim() && result.me.profile?.jerseyNumber === fields.jerseyNumber.trim();
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
        <ProfileFields fields={fields} errors={s.errors} setFields={next => { editVersion.current += 1; setFields(next); setSaveStatus('edited'); }} />
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        <button disabled={s.busy}>{s.busy ? '正在保存…' : saveStatus === 'conflict' ? '基于当前资料版本保存输入' : '保存资料'}</button>
        {onCancel && <button type="button" className="secondary" disabled={s.busy} onClick={() => { pendingBuffer.clear(); clearNavigationRoute(actorId, currentRoute()); onCancel(); }}>取消修改</button>}
        {saveStatus === 'saved' && matchesCurrent && <p className="notice success" role="status">资料已保存到账号。</p>}
        {saveStatus === 'edited' && !s.busy && <p className="muted" role="status">有尚未保存的修改。</p>}
        {saveStatus === 'conflict' && <button type="button" className="secondary" disabled={s.busy} onClick={() => void s.session.verify()}>重新载入当前资料（保留输入）</button>}
        {conflict && <p className="notice" role="status">上方输入与当前账号资料不同，仍未保存；当前账号资料为 {current.profile.discName} / {current.profile.jerseyNumber}。请核对后再保存。</p>}
    </form>;
}
export function BootstrapForm({ actorId }: { actorId: string }) {
    const s = useSubmission();
    const [fields, setFields] = useState<Fields>({ discName: '合成领队', jerseyNumber: '01' });
    const [result, setResult] = useState<BootstrapResult | null>(null);
    const submitting = useRef(false);
    if (result) return <>
        <div className="notice success" role="status">
            <h2>合成队伍已初始化</h2>
            <p>当前账号已绑定首位管理员。</p>
        </div>
        <InviteOutput result={result} actorId={actorId} />
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Critical recovery uses document navigation if client routing is unavailable. */}
        <a href="/">前往首页</a>
    </>;
    return <form onSubmit={async event => {
        event.preventDefault();
        if (submitting.current || s.busy) return;
        const form = event.currentTarget;
        const errors = validate(fields);
        s.setErrors(errors);
        if (Object.keys(errors).length) { focusError(event.currentTarget, errors); return; }
        submitting.current = true;
        s.setBusy(true); s.setError('');
        try {
            const generation = await s.session.authorize();
            const value = await api<BootstrapResult>('internal/bootstrap', { method: 'POST', actorId, body: fields, key: s.key.current(actorId, fields) });
            if (s.session.isCurrent(generation)) { acknowledgeMutation(actorId, 'POST', 'internal/bootstrap', fields); setResult(value); }
        } catch (e) {
            s.setError(message(e));
            showFieldError(e, form, s.setErrors);
            // Transport failure does not prove that the initialization transaction failed.
            // Read current facts before allowing another explicit same-key submission.
            if (!(e instanceof ApiError) || e.retryable) await s.session.verify('正在确认上次初始化结果…');
        } finally { submitting.current = false; s.setBusy(false); }
    }}>
        <ProfileFields fields={fields} setFields={setFields} errors={s.errors} />
        <p>将创建唯一的合成队伍、当前账号的管理员档案，以及一个7天有效、仅可使用一次的合成邀请。</p>
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        <button disabled={s.busy}>{s.busy ? '正在初始化…' : '初始化合成队伍'}</button>
    </form>;
}
function InviteOutput({ result, actorId }: { result: InviteResult; actorId: string }) {
    const s = useSubmission();
    const [current, setCurrent] = useState(result);
    const [copied, setCopied] = useState(false);
    const link = current.inviteToken ? `/join/${current.inviteToken}` : null;
    return <section className="panel">
        <h2>合成邀请</h2>
        <p>仅可使用一次，有效至 {new Date(current.expiresAt).toLocaleDateString('zh-CN')}。本环境仅供合成测试，请勿发给真实队员。</p>
        {link ? <>
            <label>邀请路径<input readOnly value={link} onFocus={e => e.target.select()} />
            </label>
            <button className="secondary" type="button" onClick={async () => {
                try {
                    const generation = await s.session.authorize();
                    await navigator.clipboard.writeText(new URL(link, window.location.origin).href);
                    if (s.session.isCurrent(generation)) setCopied(true);
                } catch (e) { s.setError(message(e)); }
            }}>复制邀请链接</button>{copied && <p role="status">已复制邀请链接。</p>}<p>
                <a href={link}>查看邀请建档页</a>
            </p>
        </> : <>
            <p>此请求已提交过，原令牌不会再次显示。可先撤销原邀请，再生成新令牌。</p>
            <button className="secondary" type="button" disabled={s.busy} onClick={async () => {
                const body = { revokeInviteId: current.inviteId };
                s.setBusy(true); s.setError('');
                try {
                    const generation = await s.session.authorize();
                    const value = await api<InviteResult>('admin/invites', { method: 'POST', actorId, body, key: s.key.current(actorId, body) });
                    if (s.session.isCurrent(generation)) { acknowledgeMutation(actorId, 'POST', 'admin/invites', body); setCurrent(value); }
                } catch (e) { s.setError(message(e)); } finally { s.setBusy(false); }
            }}>{s.busy ? '正在撤销并重发…' : '撤销原邀请并生成新令牌'}</button>
        </>}{s.error && <p className="form-error" role="alert">{s.error}</p>}
    </section>;
}
export function InviteForm({ actorId }: { actorId: string }) {
    const s = useSubmission();
    const [result, setResult] = useState<InviteResult | null>(null);
    if (result) return <>
        <InviteOutput result={result} actorId={actorId} />
        <button className="secondary" onClick={() => { s.resetKey(); setResult(null); }}>再创建一个合成邀请</button>
    </>;
    return <form onSubmit={async event => {
        event.preventDefault();
        if (s.busy || s.submitting.current) return;
        s.setBusy(true); s.setError('');
        try {
            const generation = await s.session.authorize();
            const value = await api<InviteResult>('admin/invites', { method: 'POST', actorId, body: {}, key: s.key.current(actorId, {}) });
            if (s.session.isCurrent(generation)) { acknowledgeMutation(actorId, 'POST', 'admin/invites', {}); setResult(value); }
        } catch (e) { s.setError(message(e)); } finally { s.setBusy(false); }
    }}>
        <p>创建一个7天有效、仅可使用一次的合成队员邀请。邀请不赋予管理员身份。</p>{s.error && <p className="form-error" role="alert">{s.error}</p>}<button disabled={s.busy}>{s.busy ? '正在创建…' : '创建合成邀请'}</button>
    </form>;
}
