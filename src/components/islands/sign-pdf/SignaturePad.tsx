import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

export interface SignaturePadHandle {
  toDataURL: (type?: string, quality?: number) => string;
  /** The canvas itself, for trimming the drawing to its ink. */
  getCanvas: () => HTMLCanvasElement | null;
  isEmpty: () => boolean;
  clear: () => void;
  undo: () => void;
}

interface SignaturePadProps {
  width?: number;
  height?: number;
  penColor?: string;
  backgroundColor?: string;
  className?: string;
  /** Called after every stroke, undo and clear with whether the pad is now empty. */
  onChange?: (isEmpty: boolean) => void;
}

type Pad = InstanceType<typeof import('signature_pad').default>;

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  ({ width = 600, height = 200, penColor = '#000000', backgroundColor = 'rgba(0,0,0,0)', className, onChange }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const padRef = useRef<Pad | null>(null);
    const sizeRef = useRef({ width: 0, height: 0 });
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
      let mounted = true;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const notify = () => onChangeRef.current?.(padRef.current?.isEmpty() ?? true);

      /** Size the bitmap to the element. Strokes already drawn are kept. */
      function fit() {
        if (!canvas) return;
        const displayW = canvas.offsetWidth;
        const displayH = canvas.offsetHeight;
        // Not laid out (the panel it is in is closed): keep what is there.
        if (displayW <= 0 || displayH <= 0) return;
        if (displayW === sizeRef.current.width && displayH === sizeRef.current.height) return;
        sizeRef.current = { width: displayW, height: displayH };

        const pad = padRef.current;
        const strokes = pad ? pad.toData() : [];
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = displayW * ratio;
        canvas.height = displayH * ratio;
        canvas.getContext('2d')?.scale(ratio, ratio);
        if (pad) {
          // Resizing a canvas wipes it; redraw the strokes instead of losing them.
          pad.clear();
          if (strokes.length > 0) pad.fromData(strokes);
        }
      }

      const observer = new ResizeObserver(fit);

      import('signature_pad').then(({ default: SignaturePadLib }) => {
        if (!mounted || !canvas) return;
        padRef.current = new SignaturePadLib(canvas, { penColor, backgroundColor, minWidth: 1, maxWidth: 3 });
        padRef.current.addEventListener('endStroke', notify);
        sizeRef.current = { width: 0, height: 0 };
        fit();
        observer.observe(canvas);
      });

      return () => {
        mounted = false;
        observer.disconnect();
        padRef.current?.removeEventListener('endStroke', notify);
        padRef.current?.off();
        padRef.current = null;
      };
    }, [penColor, backgroundColor]);

    useImperativeHandle(ref, () => ({
      toDataURL: (type = 'image/png', quality?: number) => padRef.current?.toDataURL(type, quality) ?? '',
      getCanvas: () => canvasRef.current,
      isEmpty: () => padRef.current?.isEmpty() ?? true,
      clear: () => {
        padRef.current?.clear();
        onChangeRef.current?.(true);
      },
      undo: () => {
        const pad = padRef.current;
        if (!pad) return;
        const data = pad.toData();
        if (data.length > 0) {
          data.pop();
          pad.fromData(data);
        }
        onChangeRef.current?.(pad.isEmpty());
      },
    }));

    return (
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={className}
        style={{ touchAction: 'none', cursor: 'crosshair' }}
        aria-label="Signature drawing area"
      />
    );
  }
);

SignaturePad.displayName = 'SignaturePad';
export default SignaturePad;
