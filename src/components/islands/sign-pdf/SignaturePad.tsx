import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

export interface SignaturePadHandle {
  toDataURL: (type?: string, quality?: number) => string;
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
}

const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  ({ width = 600, height = 200, penColor = '#000000', backgroundColor = 'rgba(0,0,0,0)', className }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const padRef = useRef<InstanceType<typeof import('signature_pad').default> | null>(null);

    useEffect(() => {
      let mounted = true;
      const canvas = canvasRef.current;
      if (!canvas) return;

      function initPad() {
        if (!mounted || !canvas) return;
        import('signature_pad').then(({ default: SignaturePadLib }) => {
          if (!mounted || !canvas) return;

          // Use actual rendered size, fallback to props
          const displayW = canvas.offsetWidth || width;
          const displayH = canvas.offsetHeight || height;

          // Skip if canvas has no dimensions yet (not laid out)
          if (displayW <= 0 || displayH <= 0) return;

          const ratio = Math.max(window.devicePixelRatio || 1, 1);
          canvas.width = displayW * ratio;
          canvas.height = displayH * ratio;
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.scale(ratio, ratio);

          // Dispose old instance if re-initializing
          padRef.current?.off();
          padRef.current = new SignaturePadLib(canvas, {
            penColor,
            backgroundColor,
            minWidth: 1,
            maxWidth: 3,
          });
        });
      }

      // Use ResizeObserver to init when canvas actually has dimensions
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            initPad();
          }
        }
      });
      observer.observe(canvas);

      // Also try immediately in case canvas is already laid out
      initPad();

      return () => {
        mounted = false;
        observer.disconnect();
        padRef.current?.off();
      };
    }, [penColor, backgroundColor, width, height]);

    useImperativeHandle(ref, () => ({
      toDataURL: (type = 'image/png', quality?: number) =>
        padRef.current?.toDataURL(type, quality) ?? '',
      isEmpty: () => padRef.current?.isEmpty() ?? true,
      clear: () => padRef.current?.clear(),
      undo: () => {
        const pad = padRef.current;
        if (!pad) return;
        const data = pad.toData();
        if (data.length > 0) {
          data.pop();
          pad.fromData(data);
        }
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
