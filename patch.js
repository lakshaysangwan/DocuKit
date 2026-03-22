const fs = require('fs');

const path = 'd:/Project/DocuKit/src/workers/pdf-worker.ts';
let code = fs.readFileSync(path, 'utf8');

const startIdx = code.indexOf('async function decrypt(');
const nextFuncIdx = code.indexOf('async function watermark(');

if (startIdx !== -1 && nextFuncIdx !== -1) {
  const replacement = `async function decrypt(
  buffer: ArrayBuffer,
  password: string,
  sendProgress: (pct: number, label?: string) => void
): Promise<ArrayBuffer> {
  const { PDFDocument } = await import('pdf-lib');
  sendProgress(30, 'Decrypting PDF natively…');
  const doc = await PDFDocument.load(buffer, { password });
  sendProgress(80, 'Saving unlocked PDF…');
  
  if (doc.context.trailer) {
    const trailerInfo = (doc.context.trailer as any).info;
    if (trailerInfo && trailerInfo.Encrypt) {
      delete trailerInfo.Encrypt;
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return bytes.buffer as ArrayBuffer;
}

`;

  code = code.substring(0, startIdx) + replacement + code.substring(nextFuncIdx);
  fs.writeFileSync(path, code);
  console.log('Successfully patched decrypt!');
} else {
  console.log('Could not find decrypt bounds', startIdx, nextFuncIdx);
}
