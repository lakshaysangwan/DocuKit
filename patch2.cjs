const fs = require('fs');

const path = 'd:/Project/DocuKit/src/workers/pdf-worker.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  "const doc = await PDFDocument.load(buffer, { password });",
  "const doc = await PDFDocument.load(buffer, { password } as any);"
);

code = code.replace(
  "if (doc.context.trailer) {",
  "const trailerCtx = doc.context as any;\n  if (trailerCtx.trailer) {"
);

code = code.replace(
  "const trailerInfo = (doc.context.trailer as any).info;",
  "const trailerInfo = trailerCtx.trailer.info;"
);

// We had two spots where we replaced trailerCtx. Make sure to catch both if needed.
// Actually, earlier in patch.cjs we wrote:
// if (doc.context.trailer) {
//   const trailerInfo = (doc.context.trailer as any).info;

fs.writeFileSync(path, code);
console.log('Successfully patched pdf-worker.ts typings!');
