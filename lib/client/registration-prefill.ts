// Anonymous, same-tab handoff. Never contains an email, token, or server request.
export const prefillKey = 'kapok:registration-prefill';
export function clearRegistrationPrefill() {
    if (typeof window === 'undefined') return true;
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('prefill')) { url.searchParams.delete('prefill'); window.history.replaceState(window.history.state, '', url.href); }
    } catch { return false; }
    try { window.sessionStorage.removeItem(prefillKey); return window.sessionStorage.getItem(prefillKey) === null; } catch { return false; }
}
function matchingHandoff(value: { handoff?: unknown }) {
    const query = new URL(window.location.href).searchParams.getAll('prefill');
    return query.length === 1 && /^[a-f0-9]{32}$/.test(query[0]) && value.handoff === query[0];
}
export function bindRegistrationPrefill(actorId: string, eligible: boolean) {
    try {
        const raw = window.sessionStorage.getItem(prefillKey);
        if (!raw) return;
        const value = JSON.parse(raw);
        if (!eligible || window.opener || !matchingHandoff(value) ||
            !Number.isFinite(value.expires) || value.expires <= Date.now() || value.expires > Date.now() + 600000 ||
            (value.actorId && value.actorId !== actorId)) { clearRegistrationPrefill(); return; }
        window.sessionStorage.setItem(prefillKey, JSON.stringify({ ...value, actorId }));
    } catch { clearRegistrationPrefill(); }
}
export function consumeRegistrationPrefill(actorId: string) {
    try {
        const raw = window.sessionStorage.getItem(prefillKey);
        window.sessionStorage.removeItem(prefillKey);
        if (window.sessionStorage.getItem(prefillKey) !== null) return null;
        if (!raw || window.opener) return null;
        const value = JSON.parse(raw);
        if (value.actorId !== actorId || !matchingHandoff(value) ||
            !Number.isFinite(value.expires) || value.expires <= Date.now() || value.expires > Date.now() + 600000) return null;
        const { discName, jerseyNumber } = value;
        if (typeof discName !== 'string' || typeof jerseyNumber !== 'string' || !discName.trim() || discName.trim().length > 20 || !jerseyNumber.trim() || jerseyNumber.trim().length > 4) return null;
        return { discName: discName.trim(), jerseyNumber: jerseyNumber.trim() };
    } catch { clearRegistrationPrefill(); return null; }
}

// Literal script bytes are hashed by the public response; no framework/runtime asset exposure.
export const registrationPrefillScript = `(()=>{
const key='kapok:registration-prefill',form=document.getElementById('register-first'),message=document.getElementById('prefill-message'),fallback=document.getElementById('prefill-fallback');
let leaving=false;
function clear(){try{sessionStorage.removeItem(key);return sessionStorage.getItem(key)===null}catch{return false}}
clear();
form.addEventListener('submit',event=>{event.preventDefault();clear();
const discName=form.elements.discName.value.trim(),jerseyNumber=form.elements.jerseyNumber.value.trim();
if(!discName||discName.length>20){message.textContent='盘名需为1–20字。';form.elements.discName.focus();return}
if(!jerseyNumber||jerseyNumber.length>4){message.textContent='背号需为1–4字。';form.elements.jerseyNumber.focus();return}
try{if(window.opener)throw Error();const handoff=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');const raw=JSON.stringify({handoff,expires:Date.now()+600000,discName,jerseyNumber});sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error();leaving=true;location.assign(form.dataset.next+'&prefill='+handoff)}catch{clear();message.textContent='此浏览器无法暂存资料。可选择先验证邮箱，再重新填写。';fallback.hidden=false}
});
fallback.addEventListener('click',()=>{clear();leaving=true});
document.querySelectorAll('a').forEach(a=>a.addEventListener('click',event=>{if(a!==fallback&&!clear()){event.preventDefault();message.textContent='无法确认暂存资料已清除。请恢复浏览器存储后重试，或关闭本标签页。'}}));
window.addEventListener('pagehide',()=>{if(!leaving)clear()});
window.addEventListener('pageshow',event=>{if(event.persisted){leaving=false;clear()}});
})();`;
