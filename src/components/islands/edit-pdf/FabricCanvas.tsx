import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { AnnotationTool, StampType } from './AnnotationToolbar';

// Dynamic Fabric.js types — imported at runtime to avoid SSR/bundle issues
type FabricCanvas = import('fabric').Canvas;
type FabricObject = import('fabric').FabricObject;

export interface FabricCanvasRef {
  addText: (text: string, options: { fontSize: number; color: string; opacity: number }) => void;
  addImage: (dataUrl: string, opacity: number) => void;
  addStamp: (text: string, color: string, opacity: number) => void;
  startDrawMode: (width: number, color: string, opacity: number) => void;
  stopDrawMode: () => void;
  getCanvasJSON: () => string;
  loadCanvasJSON: (json: string) => void;
  deleteSelected: () => void;
  toDataURL: () => string;
  getAnnotationObjects: () => FabricObject[];
}

interface FabricCanvasProps {
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

const STAMP_COLORS: Record<StampType, string> = {
  APPROVED: '#16A34A',
  DRAFT: '#EAB308',
  CONFIDENTIAL: '#DC2626',
  COPY: '#64748B',
  VOID: '#DC2626',
};

const FabricCanvas = forwardRef<FabricCanvasRef, FabricCanvasProps>(({
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
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<FabricCanvas | null>(null);
  const isDrawingShapeRef = useRef(false);
  const shapeStartRef = useRef({ x: 0, y: 0 });
  const activeShapeRef = useRef<FabricObject | null>(null);

  // Expose imperative API
  useImperativeHandle(ref, () => ({
    addText(text, opts) {
      const canvas = fabricRef.current;
      if (!canvas) return;
      import('fabric').then(({ IText }) => {
        const obj = new IText(text, {
          left: width / 2 - 50,
          top: height / 2 - 15,
          fontSize: opts.fontSize,
          fill: opts.color,
          opacity: opts.opacity,
          fontFamily: 'sans-serif',
        });
        canvas.add(obj);
        canvas.setActiveObject(obj);
        canvas.renderAll();
        onHistoryChange();
      });
    },

    addImage(dataUrl, op) {
      const canvas = fabricRef.current;
      if (!canvas) return;
      import('fabric').then(({ FabricImage }) => {
        FabricImage.fromURL(dataUrl).then((img) => {
          const scale = Math.min((width * 0.5) / (img.width ?? 1), (height * 0.5) / (img.height ?? 1));
          img.set({ left: width / 4, top: height / 4, scaleX: scale, scaleY: scale, opacity: op });
          canvas.add(img);
          canvas.setActiveObject(img);
          canvas.renderAll();
          onHistoryChange();
        });
      });
    },

    addStamp(text, _color, op) {
      const canvas = fabricRef.current;
      if (!canvas) return;
      const stampColor = STAMP_COLORS[text as StampType] ?? _color;
      import('fabric').then(({ FabricText, Rect, Group }) => {
        const label = new FabricText(text, {
          fontSize: 24,
          fill: stampColor,
          fontWeight: 'bold',
          fontFamily: 'sans-serif',
          textAlign: 'center',
        });
        const border = new Rect({
          width: (label.width ?? 80) + 16,
          height: (label.height ?? 30) + 8,
          fill: 'transparent',
          stroke: stampColor,
          strokeWidth: 3,
          rx: 4,
          ry: 4,
          left: -((label.width ?? 80) / 2 + 8),
          top: -((label.height ?? 30) / 2 + 4),
        });
        const group = new Group([border, label], {
          left: width / 2 - 60,
          top: height / 2 - 25,
          opacity: op,
        });
        canvas.add(group);
        canvas.setActiveObject(group);
        canvas.renderAll();
        onHistoryChange();
      });
    },

    startDrawMode(w, c, op) {
      const canvas = fabricRef.current;
      if (!canvas) return;
      canvas.isDrawingMode = true;
      if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.width = w;
        canvas.freeDrawingBrush.color = c;
        (canvas.freeDrawingBrush as { opacity?: number }).opacity = op;
      }
    },

    stopDrawMode() {
      if (fabricRef.current) fabricRef.current.isDrawingMode = false;
    },

    getCanvasJSON() {
      return fabricRef.current?.toJSON() ? JSON.stringify(fabricRef.current.toJSON()) : '{}';
    },

    loadCanvasJSON(json) {
      if (!fabricRef.current) return;
      fabricRef.current.loadFromJSON(JSON.parse(json)).then(() => {
        fabricRef.current?.renderAll();
      });
    },

    deleteSelected() {
      const canvas = fabricRef.current;
      if (!canvas) return;
      const active = canvas.getActiveObjects();
      active.forEach((obj) => canvas.remove(obj));
      canvas.discardActiveObject();
      canvas.renderAll();
      onHistoryChange();
    },

    toDataURL() {
      return fabricRef.current?.toDataURL({ format: 'png', multiplier: 1 }) ?? '';
    },

    getAnnotationObjects() {
      return fabricRef.current?.getObjects() ?? [];
    },
  }));

  // Initialize Fabric canvas
  useEffect(() => {
    if (!canvasElRef.current || fabricRef.current) return;
    let mounted = true;

    import('fabric').then(({ Canvas, FabricImage }) => {
      if (!mounted || !canvasElRef.current) return;

      const canvas = new Canvas(canvasElRef.current, {
        width,
        height,
        selection: true,
        renderOnAddRemove: true,
        enableRetinaScaling: false,
      });
      fabricRef.current = canvas;

      // Load background image
      FabricImage.fromURL(backgroundUrl).then((img) => {
        if (!mounted) return;
        img.set({
          left: 0,
          top: 0,
          scaleX: width / (img.width ?? width),
          scaleY: height / (img.height ?? height),
          selectable: false,
          evented: false,
        });
        canvas.add(img);
        canvas.sendObjectToBack(img);
        canvas.renderAll();
      });

      // History tracking — Fabric v7 uses typed event registry
      (canvas as unknown as { on: (events: Record<string, () => void>) => void }).on({
        'object:modified': onHistoryChange,
        'object:added': onHistoryChange,
        'path:created': onHistoryChange,
      });
    });

    return () => {
      mounted = false;
      if (fabricRef.current) {
        fabricRef.current.dispose();
        fabricRef.current = null;
      }
    };
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update background if URL changes
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    import('fabric').then(({ FabricImage }) => {
      FabricImage.fromURL(backgroundUrl).then((img) => {
        // Remove old background
        const objects = canvas.getObjects();
        const bg = objects.find((o) => !(o as { selectable?: boolean }).selectable);
        if (bg) canvas.remove(bg);

        img.set({
          left: 0, top: 0,
          scaleX: width / (img.width ?? width),
          scaleY: height / (img.height ?? height),
          selectable: false, evented: false,
        });
        canvas.add(img);
        canvas.sendObjectToBack(img);
        canvas.renderAll();
      });
    });
  }, [backgroundUrl, width, height]);

  // Handle tool mode changes
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    canvas.isDrawingMode = activeTool === 'draw';

    if (activeTool === 'draw' && canvas.freeDrawingBrush) {
      canvas.freeDrawingBrush.width = strokeWidth;
      canvas.freeDrawingBrush.color = color;
    }

    // Enable selection for select tool
    canvas.selection = activeTool === 'select';
    const objects = canvas.getObjects();
    objects.forEach((obj) => {
      if (!obj || !(obj as { selectable?: boolean }).selectable === false) {
        (obj as { evented?: boolean }).evented = activeTool === 'select';
        (obj as { selectable?: boolean }).selectable = activeTool === 'select';
      }
    });
    canvas.renderAll();
  }, [activeTool, color, strokeWidth]);

  // Mouse handlers for shape drawing (Fabric v7 event API)
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    const shapeTools = ['rectangle', 'ellipse', 'line', 'arrow', 'highlight', 'whiteout'];
    if (!shapeTools.includes(activeTool)) return;

    // Use canvas element pointer events to get coordinates, avoiding Fabric's typed event API
    const el = canvas.getElement();
    if (!el) return;

    const getCanvasPoint = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const scaleX = (canvas.width ?? 1) / rect.width;
      const scaleY = (canvas.height ?? 1) / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      const point = getCanvasPoint(e);
      isDrawingShapeRef.current = true;
      shapeStartRef.current = { x: point.x, y: point.y };
      activeShapeRef.current = null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDrawingShapeRef.current) return;
      const point = getCanvasPoint(e);
      const { x: sx, y: sy } = shapeStartRef.current;
      const w = point.x - sx;
      const h = point.y - sy;

      if (activeShapeRef.current) canvas.remove(activeShapeRef.current);

      import('fabric').then(({ Rect, Ellipse, Line }) => {
        let shape: FabricObject | null = null;
        const commonProps = {
          left: w < 0 ? point.x : sx,
          top: h < 0 ? point.y : sy,
          opacity,
        };

        if (activeTool === 'rectangle') {
          shape = new Rect({ ...commonProps, width: Math.abs(w), height: Math.abs(h), fill: 'transparent', stroke: color, strokeWidth });
        } else if (activeTool === 'ellipse') {
          shape = new Ellipse({ ...commonProps, rx: Math.abs(w) / 2, ry: Math.abs(h) / 2, fill: 'transparent', stroke: color, strokeWidth });
        } else if (activeTool === 'line' || activeTool === 'arrow') {
          shape = new Line([sx, sy, point.x, point.y], { stroke: color, strokeWidth, opacity });
        } else if (activeTool === 'highlight') {
          shape = new Rect({ ...commonProps, width: Math.abs(w), height: Math.abs(h), fill: color, opacity: 0.3, stroke: 'transparent' });
        } else if (activeTool === 'whiteout') {
          shape = new Rect({ ...commonProps, width: Math.abs(w), height: Math.abs(h), fill: '#FFFFFF', opacity: 1, stroke: 'transparent' });
        }

        if (shape) {
          canvas.add(shape);
          activeShapeRef.current = shape;
          canvas.renderAll();
        }
      });
    };

    const onPointerUp = () => {
      isDrawingShapeRef.current = false;
      if (activeShapeRef.current) {
        onHistoryChange();
        activeShapeRef.current = null;
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
    };
  }, [activeTool, color, strokeWidth, opacity, onHistoryChange]);

  return (
    <canvas
      ref={canvasElRef}
      style={{ display: 'block', touchAction: 'none' }}
    />
  );
});

FabricCanvas.displayName = 'FabricCanvas';
export default FabricCanvas;
