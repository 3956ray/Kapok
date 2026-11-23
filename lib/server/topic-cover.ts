import { DomainError } from './domain.ts';
import { imageDataBytes, validatedLearningImage } from './learning-image-validation.ts';

export const maxTopicCoverJsonBytes = 450_000;
const maxBytes = 300 * 1024;
const maxEdge = 1280;

export async function validateTopicCover(input: unknown) {
    if (input === null || input === undefined) return input;
    if (typeof input !== 'string') throw new DomainError('INVALID_IMAGE', '请选择 JPG、PNG 或 WebP 封面。', 415);
    if (input.length > 410_000) throw new DomainError('IMAGE_TOO_LARGE', '请缩小封面后重试。', 413);
    const split = input.indexOf(',');
    const type = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(input.slice(0, split))?.[1];
    if (!type) throw new DomainError('INVALID_IMAGE', '请选择 JPG、PNG 或 WebP 封面。', 415);
    const bytes = imageDataBytes(input.slice(split + 1));
    const image = await validatedLearningImage(new Response(bytes).body, type, maxBytes, maxEdge);
    return { url: input, digest: image.digest };
}

// An explicit NULL revision clears the cover even when an earlier revision has an image.
export const topicCoverVersion = (snapshot: 'tc.version' | 'tcp.version' | 'sh.version') =>
    `(SELECT CASE WHEN cr.digest IS NOT NULL THEN cr.version END FROM workspace_topic_cover_revisions cr
        WHERE cr.collection_id=tc.id AND cr.version<=${snapshot} ORDER BY cr.version DESC LIMIT 1)`;
