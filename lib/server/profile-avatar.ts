import { DomainError } from './domain.ts';
import { imageDataBytes, validatedLearningImage } from './learning-image-validation.ts';

export const maxAvatarJsonBytes = 420_000;
const maxAvatarBytes = 300 * 1024;

export async function validateAvatar(input: unknown) {
    if (input === null || input === undefined) return input;
    if (typeof input !== 'string' || input.length > 410000) throw new DomainError('INVALID_IMAGE','请选择可用的头像图片。',415);
    const comma = input.indexOf(',');
    const type = /^data:(image\/(?:webp|png|jpeg));base64$/.exec(input.slice(0,comma))?.[1];
    if (!type) throw new DomainError('INVALID_IMAGE','请选择 JPG、PNG 或 WebP 图片。',415);
    const bytes = imageDataBytes(input.slice(comma+1));
    const image = await validatedLearningImage(new Response(bytes).body,type,maxAvatarBytes,256);
    if (image.width !== image.height)
        throw new DomainError('INVALID_IMAGE','请重新选择图片并裁切头像。',415);
    return {url:input,digest:image.digest};
}
