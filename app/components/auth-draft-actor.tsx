'use client';

import { clearRegistrationPrefill } from '../../lib/client/registration-prefill';
import { useLayoutEffect } from 'react';
import type { BootstrapStatus } from '../../lib/contracts';
import { api } from '../../lib/client/api';
import { reconcileRegistrationActor } from '../../lib/client/registration-draft';

export function AuthDraftActor({ actorId }: { actorId: string }) {
    useLayoutEffect(() => {
        const controller = new AbortController();
        // The session may have changed since this document was rendered.
        void api<BootstrapStatus>('bootstrap', undefined, actorId, controller.signal).then(account => {
            if (!controller.signal.aborted && (account.actorId ?? account.siteUserId) === actorId) {
                clearRegistrationPrefill();
                reconcileRegistrationActor(actorId);
            }
        }).catch(() => { /* Keep the draft when current identity cannot be confirmed. */ });
        return () => controller.abort();
    }, [actorId]);
    return null;
}
