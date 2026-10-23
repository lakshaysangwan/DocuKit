import { decodeHeic } from '@/lib/image-codec';
import { canvasToBlob, createCanvas2D } from '@/lib/canvas-2d';

/**
 * A URL an `<img>` can show for compressed bytes. Normally the bytes
 * themselves; where the browser cannot display the format (AVIF in some
 * engines) a PNG of the same pixels, decoded by the AVIF codec, so the
 * comparison still shows what the file holds. The caller revokes it.
 */
export async function displayUrlFor(blob: Blob): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    return URL.createObjectURL(blob);
  } catch {
    if (blob.type === 'image/avif') {
      const { decode } = await import('@jsquash/avif');
      const data = await decode(await blob.arrayBuffer());
      if (data) {
        const { canvas, ctx } = createCanvas2D(data.width, data.height);
        ctx.putImageData(data, 0, 0);
        return URL.createObjectURL(await canvasToBlob(canvas, 'image/png'));
      }
    }
    return URL.createObjectURL(blob);
  }
}

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
