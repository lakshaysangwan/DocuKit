interface TelemetryEvent {
  tool: string;
  action: 'start' | 'complete' | 'error';
  durationMs?: number;
  fileSizeBucket?: string;  // '0-1MB', '1-10MB', '10-50MB', '50-200MB', '>200MB'
  fileCount?: number;
  errorCode?: string;
}

// Buffer events and send once at session end
const eventBuffer: TelemetryEvent[] = [];

function fileSizeBucket(bytes: number): string {
  if (bytes < 1_000_000) return '0-1MB';
  if (bytes < 10_000_000) return '1-10MB';
  if (bytes < 50_000_000) return '10-50MB';
  if (bytes < 200_000_000) return '50-200MB';
  return '>200MB';
}

export function trackEvent(event: TelemetryEvent): void {
  // Silently skip if telemetry is not available
  if (typeof navigator === 'undefined') return;
  eventBuffer.push(event);
}

export function trackToolStart(tool: string, fileSizeBytes?: number, fileCount?: number): void {
  trackEvent({
    tool,
    action: 'start',
    fileSizeBucket: fileSizeBytes !== undefined ? fileSizeBucket(fileSizeBytes) : undefined,
    fileCount,
  });
}

export function trackToolComplete(tool: string, durationMs: number, fileSizeBytes?: number): void {
  trackEvent({
    tool,
    action: 'complete',
    durationMs,
    fileSizeBucket: fileSizeBytes !== undefined ? fileSizeBucket(fileSizeBytes) : undefined,
  });
}

export function trackToolError(tool: string, errorCode: string): void {
  trackEvent({ tool, action: 'error', errorCode });
}

/** Flush buffered events via sendBeacon — call on visibilitychange or pagehide */
export function flushTelemetry(): void {
  if (eventBuffer.length === 0) return;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;

  const payload = JSON.stringify({ events: eventBuffer.splice(0) });
  navigator.sendBeacon('/api/telemetry', payload);
}

/** Set up automatic flush on page hide */
export function initTelemetry(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', flushTelemetry);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTelemetry();
  });
}
