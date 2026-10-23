import { decodeHeic } from '@/lib/image-codec';
import { canvasToBlob, createCanvas2D } from '@/lib/canvas-2d';

export interface LoadedImage {
  /** Something an `<img>` can show: the file itself, or a PNG of it when the browser cannot show the file. */
  url: string;
  width: number;
  height: number;
}

/**
 * Read an image for display: its pixel size, and a URL to show it by. Most
 * files are shown as they are. A HEIC the browser cannot decode goes through
 * libheif (as compression does) and is shown as a PNG of its pixels.
 *
 * The caller revokes `url`.
 */
export async function loadImage(file: File): Promise<LoadedImage> {
  try {
    const bitmap = await createImageBitmap(file);
    const out = { url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return out;
  } catch {
    const bitmap = await decodeHeic(file);
    const { canvas, ctx } = createCanvas2D(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const out = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const png = await canvasToBlob(canvas, 'image/png');
    return { ...out, url: URL.createObjectURL(png) };
  }
}
