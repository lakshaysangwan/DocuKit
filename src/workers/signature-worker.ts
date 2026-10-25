/// <reference lib="webworker" />
/**
 * Picks the signature out of a photo, off the main thread, so moving the
 * Sensitivity slider never stalls the page. Holds the prepared photo between
 * messages: `prepare` once per photo, then `extract` for every slider move.
 *
 * Nothing leaves the browser: pixels in, pixels out.
 */
import {
  extractInk,
  prepareSignature,
  type ExtractOptions,
  type PreparedSignature,
} from '@/lib/sign/signature-extract';

export type SignatureWorkerRequest =
  | { id: number; type: 'prepare'; width: number; height: number; buffer: ArrayBuffer }
  | { id: number; type: 'extract'; options: ExtractOptions };

export type SignatureWorkerResponse =
  | { id: number; ok: true; ink: { width: number; height: number; buffer: ArrayBuffer; box: { x: number; y: number; width: number; height: number } } | null }
  | { id: number; ok: false; error: string };

let prepared: PreparedSignature | null = null;

self.onmessage = (e: MessageEvent<SignatureWorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'prepare') {
      prepared = prepareSignature({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height });
      self.postMessage({ id: msg.id, ok: true, ink: null } satisfies SignatureWorkerResponse);
      return;
    }
    if (!prepared) throw new Error('No picture has been prepared.');
    const out = extractInk(prepared, msg.options);
    const ink = out
      ? { width: out.image.width, height: out.image.height, buffer: out.image.data.buffer as ArrayBuffer, box: out.box }
      : null;
    self.postMessage({ id: msg.id, ok: true, ink } satisfies SignatureWorkerResponse, ink ? [ink.buffer] : []);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SignatureWorkerResponse);
  }
};
