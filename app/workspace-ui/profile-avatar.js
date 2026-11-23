export async function prepareAvatar(file) {
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
    canvas.width = canvas.height = Math.min(256, side);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.88));
    if (!blob) throw new Error();
    return blob;
  } catch {
    throw new Error('这张图片无法读取，请换一张。');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageDataUrl(blob) {
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取头像，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}
