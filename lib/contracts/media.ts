// Shared effective limits. Transport parts stay below platform single-request limits.
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MEDIA_MAX_SECONDS = 600;
export const MEDIA_TEAM_BYTES = 1024 * 1024 * 1024;
export const MEDIA_PART_BYTES = 5 * 1024 * 1024;
export const MEDIA_MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const MEDIA_MAX_SAMPLES = 100000;
export const MEDIA_MAX_TOP_BOXES = 24;
export const MEDIA_UPLOAD_TIMEOUT_MS = 120000;

// The engineering ceiling is not hosted capacity authorization. Only trusted service
// construction can select a different policy; request bodies cannot change it.
export const MEDIA_ENGINEERING_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const MEDIA_LONG_MAX_SECONDS = 120 * 60;
export const MEDIA_WINDOW_BYTES = 64 * 1024;
export const MEDIA_STAGE_READS = 16;
export const MEDIA_STAGE_WORK = 4096;
export const MEDIA_MAX_VALIDATION_STEPS = 2048;
export const MEDIA_LONG_METADATA_BYTES = 32 * 1024 * 1024;
export const MEDIA_LONG_SAMPLES = 1000000;
export const MEDIA_LEASE_MS = 180000;
export type MediaPolicy = { maxBytes: number; teamBytes: number; maxSeconds: number };
export const HOSTED_MEDIA_POLICY: MediaPolicy = { maxBytes: MEDIA_MAX_BYTES, teamBytes: MEDIA_TEAM_BYTES, maxSeconds: MEDIA_MAX_SECONDS };
export type UploadManifest = { root: string; digests: string[] };
export type UploadProgress = {
    id: string; bytes: number; status: string; cleanupState: string; protocol: number;
    nextPart: number; receivedParts: number; assembledParts: number; manifest: Pick<UploadManifest, 'root'> | null;
    policy: MediaPolicy; leaseUntil: string | null; reservedBytes: number;
    rejection?: { code: string; message: string } | null;
};
export async function manifestRoot(bytes: number, digests: string[]) {
    const content = new TextEncoder().encode(JSON.stringify({ bytes, partBytes: MEDIA_PART_BYTES, digests }));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), b => b.toString(16).padStart(2, '0')).join('');
}

export type UploadReservation = { id: string; bytes: number; status: string; cleanupState: string; createdAt: string; protocol: number; receivedParts: number };
export type UploadPage = { items: UploadReservation[]; nextCursor: string | null };
