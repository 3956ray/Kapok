export type Principal = { subject: string };
export type ProfileInput = { discName: string; jerseyNumber: string };
export type JoinInput = ProfileInput & { token: string; returnTo?: string };
export type ProfileUpdate = ProfileInput & { expectedVersion: number };
export type Me = {
  user: { id: string; status: 'active' | 'deleted' } | null;
  profile: (ProfileInput & { version: number }) | null;
  membership: { id: string; teamId: string; role: 'admin' | 'coach' | 'member'; status: 'active' | 'paused' | 'left'; epoch: number; version: number } | null;
  team: { id: string; name: string; description: string } | null;
};
export type WriteResult = { operationId: string; me: Me };
export type JoinResult = WriteResult & { returnTo: string };
export type InviteResult = { operationId: string; inviteId: string; inviteToken?: string; expiresAt: string };
export type BootstrapResult = InviteResult & { me: Me };
export type BootstrapStatus = { siteUserId: string; initialized: boolean; canBootstrap: boolean; me: Me };
export type ApiErrorBody = { error: { code: string; message: string; retryable: boolean }; requestId: string };
export type ApiSuccess<T> = { data: T; requestId: string };
