import type { JoinInput, ProfileInput } from '../contracts/index';

export type PendingRegistration = { body: JoinInput; key: string };
type RegistrationDraft = { fields: ProfileInput; pending: PendingRegistration | null };
const storageKey = 'kapok:registration-draft';

function readRecord() {
    return JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as (RegistrationDraft & { actorId: string }) | null;
}

function matchingRecord(actorId: string) {
    const record = readRecord();
    if (!record || record.actorId === actorId) return record;
    window.sessionStorage.removeItem(storageKey);
    return null;
}

// Run only after verifying identity, regardless of membership or route.
export function reconcileRegistrationActor(actorId: string) {
    try { matchingRecord(actorId); }
    catch { /* Browser storage may be unavailable. */ }
}

// A tab can keep one draft, readable only in a freshly verified actor boundary.
export function registrationDraft(actorId: string) {
    return {
        read(): RegistrationDraft | null {
            try {
                const record = matchingRecord(actorId);
                if (typeof record?.fields?.discName === 'string' && typeof record.fields.jerseyNumber === 'string') {
                    return { fields: record.fields, pending: record.pending?.body.intent === 'register' && record.pending.body.confirmed === true ? record.pending : null };
                }
            } catch { /* Keep working in memory if storage is unavailable. */ }
            return null;
        },
        write(value: RegistrationDraft) {
            try { window.sessionStorage.setItem(storageKey, JSON.stringify({ actorId, ...value })); }
            catch { /* The mounted form still holds the current input and request. */ }
        },
        clear() {
            try {
                if (readRecord()?.actorId === actorId) window.sessionStorage.removeItem(storageKey);
                return true;
            } catch { return false; }
        },
    };
}
