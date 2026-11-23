async function resizePhoto(file, square) {
  if (!file.size || file.size > 8 * 1024 * 1024)
    throw new Error('请选择非空且不超过 8 MB 的图片。');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = String.fromCharCode(...bytes);
  const allowed =
    text.startsWith('\x89PNG\r\n\x1a\n') ||
    text.startsWith('\xff\xd8\xff') ||
    (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP');
  if (!allowed) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 960 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = square ? Math.min(256,side) : Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = square ? canvas.width : Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      img,
      square ? (img.naturalWidth - side) / 2 : 0,
      square ? (img.naturalHeight - side) / 2 : 0,
      square ? side : img.naturalWidth,
      square ? side : img.naturalHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const encode = quality => new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    let blob = await encode(square ? 0.88 : 0.82);
    if (!square && blob?.size > 300 * 1024) blob = await encode(0.55);
    if (!blob) throw new Error();
    return blob;
  } catch {
    throw new Error('这张图片无法读取，请换一张。');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const prepareAvatar = file => resizePhoto(file, true);

export async function prepareCollectionCover(file) {
  const photo = await resizePhoto(file,false);
  if (photo.size > 300 * 1024) throw new Error('压缩后的封面仍然过大，请换一张较小的图片。');
  return imageDataUrl(photo);
}

export function imageDataUrl(blob) {
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}
