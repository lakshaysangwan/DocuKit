import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';
import type { AnnotationTool, StampType } from './AnnotationToolbar';

/* ------------------------------------------------------------------ */
/*  Object model — plain data, JSON-serializable for undo/redo        */
/* ------------------------------------------------------------------ */

interface BaseObj {
  id: string;
  type: string;
  x: number;
  y: number;
  opacity: number;
}

interface TextObj extends BaseObj { type: 'text'; text: string; fontSize: number; color: string; fontFamily: string }
interface RectObj extends BaseObj { type: 'rect'; w: number; h: number; stroke: string; strokeWidth: number }
interface EllipseObj extends BaseObj { type: 'ellipse'; rx: number; ry: number; stroke: string; strokeWidth: number }
interface LineObj extends BaseObj { type: 'line'; x2: number; y2: number; stroke: string; strokeWidth: number }
interface ArrowObj extends BaseObj { type: 'arrow'; x2: number; y2: number; stroke: string; strokeWidth: number }
interface PathObj extends BaseObj { type: 'path'; points: { x: number; y: number }[]; stroke: string; strokeWidth: number }
interface HighlightObj extends BaseObj { type: 'highlight'; w: number; h: number; color: string }
interface WhiteoutObj extends BaseObj { type: 'whiteout'; w: number; h: number }
interface ImageObj extends BaseObj { type: 'image'; dataUrl: string; w: number; h: number }
interface StampObj extends BaseObj { type: 'stamp'; text: string; color: string; borderW: number; borderH: number }

export type AnnotationObject =
  | TextObj | RectObj | EllipseObj | LineObj | ArrowObj
  | PathObj | HighlightObj | WhiteoutObj | ImageObj | StampObj;

/* ------------------------------------------------------------------ */
/*  Bounding box                                                       */
/* ------------------------------------------------------------------ */

export function getBBox(o: AnnotationObject): { x: number; y: number; w: number; h: number } {
  switch (o.type) {
    case 'text': return { x: o.x, y: o.y - o.fontSize, w: (o as TextObj).text.length * o.fontSize * 0.6, h: o.fontSize * 1.2 };
    case 'rect': case 'highlight': case 'whiteout': return { x: o.x, y: o.y, w: (o as RectObj | HighlightObj | WhiteoutObj).w, h: (o as RectObj | HighlightObj | WhiteoutObj).h };
    case 'ellipse': { const e = o as EllipseObj; return { x: e.x - e.rx, y: e.y - e.ry, w: e.rx * 2, h: e.ry * 2 }; }
    case 'line': case 'arrow': { const l = o as LineObj | ArrowObj; const minX = Math.min(l.x, l.x2); const minY = Math.min(l.y, l.y2); return { x: minX, y: minY, w: Math.abs(l.x2 - l.x) || 4, h: Math.abs(l.y2 - l.y) || 4 }; }
    case 'path': { const p = o as PathObj; if (p.points.length === 0) return { x: p.x, y: p.y, w: 0, h: 0 }; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const pt of p.points) { if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y; if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y; } return { x: minX, y: minY, w: maxX - minX || 4, h: maxY - minY || 4 }; }
    case 'image': return { x: o.x, y: o.y, w: (o as ImageObj).w, h: (o as ImageObj).h };
    case 'stamp': return { x: o.x, y: o.y, w: (o as StampObj).borderW, h: (o as StampObj).borderH };
  }
}

/* ------------------------------------------------------------------ */
/*  Hit test                                                           */
/* ------------------------------------------------------------------ */

export function hitTest(px: number, py: number, objects: AnnotationObject[]): AnnotationObject | null {
  const TOL = 6;
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type === 'line' || o.type === 'arrow') {
      const l = o as LineObj | ArrowObj;
      const dx = l.x2 - l.x, dy = l.y2 - l.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dist = Math.abs(dy * px - dx * py + l.x2 * l.y - l.y2 * l.x) / len;
      const dot = ((px - l.x) * dx + (py - l.y) * dy) / (len * len);
      if (dist < TOL + l.strokeWidth && dot >= -0.05 && dot <= 1.05) return o;
    } else if (o.type === 'path') {
      const p = o as PathObj;
      for (let j = 1; j < p.points.length; j++) {
        const a = p.points[j - 1], b = p.points[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const dist = Math.abs(dy * px - dx * py + b.x * a.y - b.y * a.x) / len;
        const dot = ((px - a.x) * dx + (py - a.y) * dy) / (len * len);
        if (dist < TOL + p.strokeWidth && dot >= -0.05 && dot <= 1.05) return o;
      }
    } else {
      const bb = getBBox(o);
      if (px >= bb.x - TOL && px <= bb.x + bb.w + TOL && py >= bb.y - TOL && py <= bb.y + bb.h + TOL) return o;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Render all objects                                                 */
/* ------------------------------------------------------------------ */

export function renderObjects(
  ctx: CanvasRenderingContext2D,
  objects: AnnotationObject[],
  imageCache: Map<string, HTMLImageElement>,
  selectedId?: string | null,
) {
  for (const o of objects) {
    ctx.save();
    ctx.globalAlpha = o.opacity;

    switch (o.type) {
      case 'text': {
        const t = o as TextObj;
        ctx.font = `${t.fontSize}px ${t.fontFamily}`;
        ctx.fillStyle = t.color;
        ctx.textBaseline = 'top';
        const lines = t.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], t.x, t.y + i * t.fontSize * 1.2);
        }
        break;
      }
      case 'rect': {
        const r = o as RectObj;
        ctx.strokeStyle = r.stroke;
        ctx.lineWidth = r.strokeWidth;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'ellipse': {
        const e = o as EllipseObj;
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = e.strokeWidth;
        ctx.beginPath();
        ctx.ellipse(e.x, e.y, Math.abs(e.rx), Math.abs(e.ry), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'line': {
        const l = o as LineObj;
        ctx.strokeStyle = l.stroke;
        ctx.lineWidth = l.strokeWidth;
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
        break;
      }
      case 'arrow': {
        const a = o as ArrowObj;
        ctx.strokeStyle = a.stroke;
        ctx.lineWidth = a.strokeWidth;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        // Arrowhead
        const angle = Math.atan2(a.y2 - a.y, a.x2 - a.x);
        const headLen = Math.max(10, a.strokeWidth * 4);
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - headLen * Math.cos(angle - Math.PI / 6), a.y2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - headLen * Math.cos(angle + Math.PI / 6), a.y2 - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
        break;
      }
      case 'path': {
        const p = o as PathObj;
        if (p.points.length < 2) break;
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) ctx.lineTo(p.points[i].x, p.points[i].y);
        ctx.stroke();
        break;
      }
      case 'highlight': {
        const hl = o as HighlightObj;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = hl.color;
        ctx.fillRect(hl.x, hl.y, hl.w, hl.h);
        break;
      }
      case 'whiteout': {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(o.x, o.y, (o as WhiteoutObj).w, (o as WhiteoutObj).h);
        break;
      }
      case 'image': {
        const im = o as ImageObj;
        const img = imageCache.get(im.dataUrl);
        if (img && img.complete) ctx.drawImage(img, im.x, im.y, im.w, im.h);
        break;
      }
      case 'stamp': {
        const s = o as StampObj;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
        ctx.strokeRect(s.x, s.y, s.borderW, s.borderH);
        ctx.fillStyle = s.color;
        ctx.font = 'bold 24px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(s.text, s.x + s.borderW / 2, s.y + s.borderH / 2);
        ctx.textAlign = 'start';
        break;
      }
    }
    ctx.restore();
  }

  // Selection indicator
  if (selectedId) {
    const sel = objects.find(o => o.id === selectedId);
    if (sel) {
      const bb = getBBox(sel);
      ctx.save();
      ctx.strokeStyle = '#3B82F6';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8);
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Image preloading helper                                            */
/* ------------------------------------------------------------------ */

export function preloadImages(
  objects: AnnotationObject[],
  cache: Map<string, HTMLImageElement>,
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const o of objects) {
    if (o.type === 'image') {
      const im = o as ImageObj;
      if (!cache.has(im.dataUrl)) {
        const img = new Image();
        cache.set(im.dataUrl, img);
        promises.push(new Promise<void>(resolve => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = im.dataUrl;
        }));
      }
    }
  }
  return Promise.all(promises).then(() => {});
}

/* ------------------------------------------------------------------ */
/*  Imperative ref interface                                           */
/* ------------------------------------------------------------------ */

export interface AnnotationCanvasRef {
  addText: (text: string, options: { fontSize: number; color: string; opacity: number }) => void;
  addImage: (dataUrl: string, opacity: number) => void;
  addStamp: (text: string, color: string, opacity: number) => void;
  startDrawMode: (width: number, color: string, opacity: number) => void;
  stopDrawMode: () => void;
  getCanvasJSON: () => string;
  loadCanvasJSON: (json: string) => void;
  deleteSelected: () => void;
  toDataURL: () => string;
  getAnnotationObjects: () => AnnotationObject[];
}

interface AnnotationCanvasProps {
  backgroundUrl: string;
  width: number;
  height: number;
  activeTool: AnnotationTool;
  color: string;
  fontSize: number;
  strokeWidth: number;
  opacity: number;
  stampType: StampType;
  onHistoryChange: () => void;
}

const STAMP_COLORS: Record<string, string> = {
  APPROVED: '#16A34A',
  DRAFT: '#EAB308',
  CONFIDENTIAL: '#DC2626',
  COPY: '#64748B',
  VOID: '#DC2626',
};

let _idCounter = 0;
function uid(): string { return `obj_${Date.now()}_${++_idCounter}`; }

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const AnnotationCanvas = forwardRef<AnnotationCanvasRef, AnnotationCanvasProps>(({
  backgroundUrl,
  width,
  height,
  activeTool,
  color,
  fontSize,
  strokeWidth,
  opacity,
  stampType,
  onHistoryChange,
}, ref) => {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const objectsRef = useRef<AnnotationObject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<{ id: string; x: number; y: number; fontSize: number; color: string } | null>(null);
  const imageCacheRef = useRef(new Map<string, HTMLImageElement>());
  const drawStateRef = useRef<{ drawing: boolean; startX: number; startY: number; previewId: string | null }>({ drawing: false, startX: 0, startY: 0, previewId: null });
  const pathRef = useRef<{ x: number; y: number }[]>([]);
  const dragRef = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({ dragging: false, offsetX: 0, offsetY: 0 });

  // Props as refs for stable event handlers
  const propsRef = useRef({ activeTool, color, fontSize, strokeWidth, opacity, stampType, onHistoryChange });
  propsRef.current = { activeTool, color, fontSize, strokeWidth, opacity, stampType, onHistoryChange };

  const redraw = useCallback(() => {
    const ctx = overlayRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    renderObjects(ctx, objectsRef.current, imageCacheRef.current, selectedId);
  }, [width, height, selectedId]);

  // Draw background
  useEffect(() => {
    const bgCtx = bgRef.current?.getContext('2d');
    if (!bgCtx) return;
    const img = new Image();
    img.onload = () => bgCtx.drawImage(img, 0, 0, width, height);
    img.src = backgroundUrl;
  }, [backgroundUrl, width, height]);

  // Redraw overlay when objects or selection change
  useEffect(() => { redraw(); }, [redraw]);

  // Imperative handle
  useImperativeHandle(ref, () => ({
    addText(text, opts) {
      const obj: TextObj = { id: uid(), type: 'text', x: width / 2 - 50, y: height / 2, text, fontSize: opts.fontSize, color: opts.color, opacity: opts.opacity, fontFamily: 'sans-serif' };
      objectsRef.current = [...objectsRef.current, obj];
      setSelectedId(obj.id);
      propsRef.current.onHistoryChange();
    },
    addImage(dataUrl, op) {
      const img = new Image();
      imageCacheRef.current.set(dataUrl, img);
      img.onload = () => {
        const scale = Math.min((width * 0.5) / img.naturalWidth, (height * 0.5) / img.naturalHeight);
        const obj: ImageObj = { id: uid(), type: 'image', x: width / 4, y: height / 4, w: img.naturalWidth * scale, h: img.naturalHeight * scale, dataUrl, opacity: op };
        objectsRef.current = [...objectsRef.current, obj];
        setSelectedId(obj.id);
        propsRef.current.onHistoryChange();
      };
      img.src = dataUrl;
    },
    addStamp(text, _color, op) {
      const stampColor = STAMP_COLORS[text] ?? _color;
      const textW = text.length * 14.4 + 16; // approximate 24px bold
      const textH = 24 * 1.2 + 8;
      const obj: StampObj = { id: uid(), type: 'stamp', x: width / 2 - textW / 2, y: height / 2 - textH / 2, text, color: stampColor, borderW: textW, borderH: textH, opacity: op };
      objectsRef.current = [...objectsRef.current, obj];
      setSelectedId(obj.id);
      propsRef.current.onHistoryChange();
    },
    startDrawMode() { /* draw mode driven by activeTool prop */ },
    stopDrawMode() { /* no-op */ },
    getCanvasJSON() { return JSON.stringify(objectsRef.current); },
    loadCanvasJSON(json: string) {
      try {
        const parsed = JSON.parse(json);
        objectsRef.current = Array.isArray(parsed) ? parsed : [];
      } catch { objectsRef.current = []; }
      setSelectedId(null);
      // Preload images then redraw
      preloadImages(objectsRef.current, imageCacheRef.current).then(() => {
        const ctx = overlayRef.current?.getContext('2d');
        if (ctx) { ctx.clearRect(0, 0, width, height); renderObjects(ctx, objectsRef.current, imageCacheRef.current, null); }
      });
    },
    deleteSelected() {
      if (!selectedId) return;
      objectsRef.current = objectsRef.current.filter(o => o.id !== selectedId);
      setSelectedId(null);
      propsRef.current.onHistoryChange();
    },
    toDataURL() { return overlayRef.current?.toDataURL('image/png') ?? ''; },
    getAnnotationObjects() { return objectsRef.current; },
  }));

  // Pointer-to-canvas coordinate mapping
  const getPoint = useCallback((e: React.PointerEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (width / rect.width),
      y: (e.clientY - rect.top) * (height / rect.height),
    };
  }, [width, height]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const { activeTool: tool } = propsRef.current;
    const pt = getPoint(e);

    if (tool === 'select') {
      const hit = hitTest(pt.x, pt.y, objectsRef.current);
      if (hit) {
        setSelectedId(hit.id);
        dragRef.current = { dragging: true, offsetX: pt.x - hit.x, offsetY: pt.y - hit.y };
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === 'draw') {
      pathRef.current = [{ x: pt.x, y: pt.y }];
      drawStateRef.current = { drawing: true, startX: pt.x, startY: pt.y, previewId: null };
      return;
    }

    // Shape tools
    const shapeTools = ['rectangle', 'ellipse', 'line', 'arrow', 'highlight', 'whiteout'];
    if (shapeTools.includes(tool)) {
      drawStateRef.current = { drawing: true, startX: pt.x, startY: pt.y, previewId: null };
    }
  }, [getPoint]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const { activeTool: tool, color: c, strokeWidth: sw, opacity: op } = propsRef.current;
    const pt = getPoint(e);

    // Drag selected object
    if (tool === 'select' && dragRef.current.dragging && selectedId) {
      const obj = objectsRef.current.find(o => o.id === selectedId);
      if (obj) {
        const dx = pt.x - dragRef.current.offsetX - obj.x;
        const dy = pt.y - dragRef.current.offsetY - obj.y;
        obj.x += dx;
        obj.y += dy;
        if ('x2' in obj) { (obj as LineObj | ArrowObj).x2 += dx; (obj as LineObj | ArrowObj).y2 += dy; }
        if (obj.type === 'path') { for (const p of (obj as PathObj).points) { p.x += dx; p.y += dy; } }
        redraw();
      }
      return;
    }

    if (!drawStateRef.current.drawing) return;
    const { startX: sx, startY: sy } = drawStateRef.current;

    if (tool === 'draw') {
      pathRef.current.push({ x: pt.x, y: pt.y });
      // Live preview: draw incrementally
      const ctx = overlayRef.current?.getContext('2d');
      if (ctx && pathRef.current.length >= 2) {
        ctx.save();
        ctx.strokeStyle = c;
        ctx.lineWidth = sw;
        ctx.globalAlpha = op;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const prev = pathRef.current[pathRef.current.length - 2];
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.restore();
      }
      return;
    }

    // Shape preview: remove old preview, add new
    if (drawStateRef.current.previewId) {
      objectsRef.current = objectsRef.current.filter(o => o.id !== drawStateRef.current.previewId);
    }

    const w = pt.x - sx, h = pt.y - sy;
    const previewId = '_preview';
    let shape: AnnotationObject | null = null;

    if (tool === 'rectangle') {
      shape = { id: previewId, type: 'rect', x: w < 0 ? pt.x : sx, y: h < 0 ? pt.y : sy, w: Math.abs(w), h: Math.abs(h), stroke: c, strokeWidth: sw, opacity: op };
    } else if (tool === 'ellipse') {
      shape = { id: previewId, type: 'ellipse', x: sx + w / 2, y: sy + h / 2, rx: Math.abs(w) / 2, ry: Math.abs(h) / 2, stroke: c, strokeWidth: sw, opacity: op };
    } else if (tool === 'line') {
      shape = { id: previewId, type: 'line', x: sx, y: sy, x2: pt.x, y2: pt.y, stroke: c, strokeWidth: sw, opacity: op };
    } else if (tool === 'arrow') {
      shape = { id: previewId, type: 'arrow', x: sx, y: sy, x2: pt.x, y2: pt.y, stroke: c, strokeWidth: sw, opacity: op };
    } else if (tool === 'highlight') {
      shape = { id: previewId, type: 'highlight', x: w < 0 ? pt.x : sx, y: h < 0 ? pt.y : sy, w: Math.abs(w), h: Math.abs(h), color: c, opacity: op };
    } else if (tool === 'whiteout') {
      shape = { id: previewId, type: 'whiteout', x: w < 0 ? pt.x : sx, y: h < 0 ? pt.y : sy, w: Math.abs(w), h: Math.abs(h), opacity: 1 };
    }

    if (shape) {
      objectsRef.current = [...objectsRef.current, shape];
      drawStateRef.current.previewId = previewId;
      redraw();
    }
  }, [getPoint, selectedId, redraw]);

  const onPointerUp = useCallback(() => {
    const { activeTool: tool } = propsRef.current;

    // Finalize drag
    if (tool === 'select' && dragRef.current.dragging) {
      dragRef.current.dragging = false;
      propsRef.current.onHistoryChange();
      return;
    }

    if (!drawStateRef.current.drawing) return;
    drawStateRef.current.drawing = false;

    if (tool === 'draw' && pathRef.current.length >= 2) {
      const { color: c, strokeWidth: sw, opacity: op } = propsRef.current;
      const obj: PathObj = { id: uid(), type: 'path', x: pathRef.current[0].x, y: pathRef.current[0].y, points: [...pathRef.current], stroke: c, strokeWidth: sw, opacity: op };
      objectsRef.current = [...objectsRef.current, obj];
      pathRef.current = [];
      redraw();
      propsRef.current.onHistoryChange();
      return;
    }

    // Finalize shape: replace preview with permanent object
    if (drawStateRef.current.previewId) {
      objectsRef.current = objectsRef.current.map(o =>
        o.id === drawStateRef.current.previewId ? { ...o, id: uid() } : o
      );
      drawStateRef.current.previewId = null;
      redraw();
      propsRef.current.onHistoryChange();
    }
  }, [redraw]);

  // Double-click to edit text
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (width / rect.width);
    const py = (e.clientY - rect.top) * (height / rect.height);
    const hit = hitTest(px, py, objectsRef.current);
    if (hit && hit.type === 'text') {
      const t = hit as TextObj;
      setEditingText({ id: t.id, x: t.x, y: t.y, fontSize: t.fontSize, color: t.color });
    }
  }, [width, height]);

  const commitText = useCallback((value: string) => {
    if (!editingText) return;
    objectsRef.current = objectsRef.current.map(o =>
      o.id === editingText.id ? { ...o, text: value } as TextObj : o
    );
    setEditingText(null);
    redraw();
    propsRef.current.onHistoryChange();
  }, [editingText, redraw]);

  return (
    <div style={{ position: 'relative', width, height }}>
      <canvas ref={bgRef} width={width} height={height} style={{ position: 'absolute', top: 0, left: 0, display: 'block' }} />
      <canvas
        ref={overlayRef}
        width={width}
        height={height}
        style={{ position: 'absolute', top: 0, left: 0, display: 'block', touchAction: 'none', cursor: activeTool === 'select' ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      {editingText && (
        <textarea
          autoFocus
          defaultValue={(objectsRef.current.find(o => o.id === editingText.id) as TextObj)?.text ?? ''}
          style={{
            position: 'absolute',
            left: editingText.x,
            top: editingText.y,
            fontSize: editingText.fontSize,
            fontFamily: 'sans-serif',
            color: editingText.color,
            background: 'rgba(255,255,255,0.9)',
            border: '1px solid #3B82F6',
            borderRadius: 4,
            padding: '2px 4px',
            outline: 'none',
            resize: 'both',
            minWidth: 60,
            minHeight: editingText.fontSize * 1.5,
            zIndex: 10,
          }}
          onBlur={(e) => commitText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setEditingText(null); }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(e.currentTarget.value); }
          }}
        />
      )}
    </div>
  );
});

AnnotationCanvas.displayName = 'AnnotationCanvas';
export default AnnotationCanvas;
