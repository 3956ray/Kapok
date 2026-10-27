import { PersonalData } from '../../components/data-rights';
import { AccessState, EnvironmentNote, Shell, getPageContext } from '../../components/shell';
export const dynamic = 'force-dynamic';
export default async function PersonalDataPage() {
    const context = await getPageContext();
    return <Shell title="隐私与个人数据" back="/me">
        <EnvironmentNote />
        {!context.me?.profile || context.error ? <AccessState context={context} returnTo="/me/data" /> : <PersonalData actorId={context.user!.userId} />}
    </Shell>;
}
