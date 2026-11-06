import { createCaptureId, photoSha256 } from './captureCrypto';
import type { LocalPhoto } from './types';

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export async function preparePhoto(file: File, maxBytes: number, order: number): Promise<LocalPhoto> {
  // Validate browser randomness before decoding a potentially large image.
  const id = createCaptureId();
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name} 太大，请选择小于 50 MiB 的照片。`);
  if (!/\.(jpe?g|png|webp|hei[cf])$/i.test(file.name) && !['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.type)) {
    throw new Error('请选择 JPEG、PNG 或 WebP 照片。HEIC 需要浏览器支持转换。');
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`无法读取 ${file.name}。请在 iPhone 设置 → 相机 → 格式中选择“兼容性最佳”，或先导出为 JPEG。`));
      image.src = url;
    });
    // Modern Safari/desktop image decoding applies EXIF orientation before canvas draw.
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('此浏览器无法处理照片，请换用 Safari 或 Chrome。');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('照片转换失败。')), 'image/jpeg', 0.85));
    canvas.width = 0; canvas.height = 0;
    if (blob.size > maxBytes) throw new Error(`${file.name} 转换后仍过大，请选择较小的照片。`);
    const sha256 = await photoSha256(await blob.arrayBuffer());
    return { id, name: file.name, sha256, size: blob.size, order, blob };
  } finally { URL.revokeObjectURL(url); }
}
