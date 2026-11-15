import { useId } from 'react';
import type { ReactNode } from 'react';
import type { PublicMember } from '../../lib/contracts/reflections';

export function accountRoleLabel(role?: string) {
    switch (role) {
        case 'admin': return '管理员';
        case 'coach': return '教练';
        case 'member': return '普通队员';
        default: return '当前不在有效队伍中';
    }
}

export function AccountProfileCard({ profile, children }: {
    profile: Pick<PublicMember, 'discName' | 'jerseyNumber' | 'bio'> & { role?: string };
    children?: ReactNode;
}) {
    const heading = useId();
    return <section className="account-profile-card" aria-labelledby={heading}>
        <div className="account-profile-identity">
            <span className="default-avatar" aria-hidden="true">{Array.from(profile.discName)[0] || '队'}</span>
            <div>
                <h2 id={heading}>{profile.discName}</h2>
                <p className="account-profile-meta">
                    <span>{accountRoleLabel(profile.role)}</span>
                    {profile.jerseyNumber && <><span aria-hidden="true">·</span><span>背号 <strong>{profile.jerseyNumber}</strong></span></>}
                </p>
            </div>
        </div>
        {profile.bio ? <p className="account-profile-bio">{profile.bio}</p> : children && <p className="account-profile-bio muted">尚未填写简介</p>}
        {children && <div className="account-profile-actions">{children}</div>}
    </section>;
}
