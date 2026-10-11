import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRenderScheduler,
  isRenderCancelled,
  IDLE_FALLBACK_DELAY_MS,
  IDLE_TIMEOUT_MS,
  PRIORITY_BACKGROUND,
  PRIORITY_NEAR,
  PRIORITY_VISIBLE,
  RenderCancelledError,
} from './render-scheduler';

/** A task whose completion the test controls. */
function job(log: string[], name: string) {
  let finish!: (value: string) => void;
  let fail!: (err: unknown) => void;
  let signal: AbortSignal | undefined;
  const run = vi.fn((s: AbortSignal) => {
    signal = s;
    log.push(`start ${name}`);
    return new Promise<string>((resolve, reject) => {
      finish = (v) => { log.push(`end ${name}`); resolve(v); };
      fail = reject;
    });
  });
  return { run, finish: (v = name) => finish(v), fail: (e: unknown) => fail(e), signal: () => signal };
}

/** Let promise callbacks run, then every timer that is due. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('render scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never starts a task in the tick that scheduled it', async () => {
    const log: string[] = [];
    const s = createRenderScheduler();
    const a = job(log, 'a');
    s.schedule(a.run, { priority: PRIORITY_VISIBLE });
    await Promise.resolve();
    expect(a.run).not.toHaveBeenCalled();
    expect(s.pending).toBe(1);
    await settle();
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(0);
    expect(s.busy).toBe(true);
  });

  it('runs one task at a time, the next only after the previous has finished', async () => {
    const log: string[] = [];
    const s = createRenderScheduler();
    const a = job(log, 'a'), b = job(log, 'b'), c = job(log, 'c');
    const ta = s.schedule(a.run, { priority: PRIORITY_VISIBLE });
    s.schedule(b.run, { priority: PRIORITY_VISIBLE });
    s.schedule(c.run, { priority: PRIORITY_VISIBLE });

    await settle(1000);
    expect(log).toEqual(['start a']);

    a.finish();
    await expect(ta.promise).resolves.toBe('a');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b']);

    b.finish();
    await settle();
    c.finish();
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(s.busy).toBe(false);
  });

  it('runs visible work before near before background, and equal priorities in order', async () => {
    const log: string[] = [];
    const s = createRenderScheduler();
    const jobs = {
      bg1: job(log, 'bg1'), bg2: job(log, 'bg2'), near: job(log, 'near'), vis1: job(log, 'vis1'), vis2: job(log, 'vis2'),
    };
    s.schedule(jobs.bg1.run, { priority: PRIORITY_BACKGROUND });
    s.schedule(jobs.bg2.run);
    s.schedule(jobs.near.run, { priority: PRIORITY_NEAR });
    s.schedule(jobs.vis1.run, { priority: PRIORITY_VISIBLE });
    s.schedule(jobs.vis2.run, { priority: PRIORITY_VISIBLE });

    for (const name of ['vis1', 'vis2', 'near', 'bg1', 'bg2'] as const) {
      await settle(IDLE_FALLBACK_DELAY_MS);
      jobs[name].finish();
    }
    await settle();
    expect(log.filter((l) => l.startsWith('start'))).toEqual([
      'start vis1', 'start vis2', 'start near', 'start bg1', 'start bg2',
    ]);
  });

  it('a visible task that arrives while a background one runs goes next, ahead of older background work', async () => {
    const log: string[] = [];
    const s = createRenderScheduler();
    const bg1 = job(log, 'bg1'), bg2 = job(log, 'bg2'), vis = job(log, 'vis');
    s.schedule(bg1.run);
    s.schedule(bg2.run);
    await settle(IDLE_FALLBACK_DELAY_MS);
    s.schedule(vis.run, { priority: PRIORITY_VISIBLE });
    bg1.finish();
    await settle();
    expect(log).toEqual(['start bg1', 'end bg1', 'start vis']);
  });

  describe('idle slicing', () => {
    it('without requestIdleCallback, background work waits for the fallback delay', async () => {
      const log: string[] = [];
      const s = createRenderScheduler();
      const bg = job(log, 'bg');
      s.schedule(bg.run);
      await settle(IDLE_FALLBACK_DELAY_MS - 1);
      expect(bg.run).not.toHaveBeenCalled();
      await settle(1);
      expect(bg.run).toHaveBeenCalledTimes(1);
    });

    it('with requestIdleCallback, background work waits for the browser to be idle', async () => {
      const idle: Array<() => void> = [];
      const requestIdleCallback = vi.fn((cb: () => void) => idle.push(cb));
      vi.stubGlobal('requestIdleCallback', requestIdleCallback);
      vi.stubGlobal('cancelIdleCallback', vi.fn());

      const log: string[] = [];
      const s = createRenderScheduler();
      const bg = job(log, 'bg');
      s.schedule(bg.run);
      await settle(10_000);
      expect(bg.run).not.toHaveBeenCalled();
      // The timeout is what stops a permanently busy page starving the queue.
      expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: IDLE_TIMEOUT_MS });

      idle[0]();
      expect(bg.run).toHaveBeenCalledTimes(1);
    });

    it('visible work does not wait for idle, even if an idle wake-up is already armed', async () => {
      const cancelIdleCallback = vi.fn();
      vi.stubGlobal('requestIdleCallback', vi.fn(() => 7));
      vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

      const log: string[] = [];
      const s = createRenderScheduler();
      s.schedule(job(log, 'bg').run);
      s.schedule(job(log, 'vis').run, { priority: PRIORITY_VISIBLE });
      await settle();
      expect(log).toEqual(['start vis']);
      expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    });

    it('raising a queued task to visible stops it waiting for idle', async () => {
      vi.stubGlobal('requestIdleCallback', vi.fn(() => 1));
      vi.stubGlobal('cancelIdleCallback', vi.fn());
      const log: string[] = [];
      const s = createRenderScheduler();
      const a = job(log, 'a'), b = job(log, 'b');
      s.schedule(a.run);
      const tb = s.schedule(b.run);
      await settle(1000);
      expect(log).toEqual([]);
      tb.setPriority(PRIORITY_VISIBLE);
      await settle();
      expect(log).toEqual(['start b']);
    });
  });

  describe('cancellation', () => {
    it('a queued task that is cancelled never runs and rejects as cancelled', async () => {
      const log: string[] = [];
      const s = createRenderScheduler();
      const a = job(log, 'a'), b = job(log, 'b');
      s.schedule(a.run, { priority: PRIORITY_VISIBLE });
      const tb = s.schedule(b.run, { priority: PRIORITY_VISIBLE });
      const rejected = expect(tb.promise).rejects.toBeInstanceOf(RenderCancelledError);
      tb.cancel();
      tb.cancel();
      await rejected;
      expect(s.pending).toBe(1);

      await settle();
      a.finish();
      await settle(1000);
      expect(b.run).not.toHaveBeenCalled();
      expect(log).toEqual(['start a', 'end a']);
    });

    it('a running task is told to stop, rejects at once, and holds the queue until it has really stopped', async () => {
      const log: string[] = [];
      const s = createRenderScheduler();
      const a = job(log, 'a'), b = job(log, 'b');
      const ta = s.schedule(a.run, { priority: PRIORITY_VISIBLE });
      s.schedule(b.run, { priority: PRIORITY_VISIBLE });
      await settle();

      const caught = ta.promise.catch((e) => e);
      ta.cancel();
      expect(a.signal()?.aborted).toBe(true);
      expect(isRenderCancelled(await caught)).toBe(true);

      // The cancelled render still owns the canvas until its promise settles.
      await settle(1000);
      expect(b.run).not.toHaveBeenCalled();
      a.fail(new Error('stopped'));
      await settle();
      expect(b.run).toHaveBeenCalledTimes(1);
    });

    it('scheduling with the same key drops the stale task', async () => {
      const log: string[] = [];
      const s = createRenderScheduler();
      const zoom1 = job(log, 'zoom1'), zoom2 = job(log, 'zoom2'), other = job(log, 'other');
      const stale = s.schedule(zoom1.run, { priority: PRIORITY_VISIBLE, key: 'page-3' });
      const staleResult = stale.promise.catch((e) => e);
      s.schedule(other.run, { priority: PRIORITY_VISIBLE, key: 'page-4' });
      s.schedule(zoom2.run, { priority: PRIORITY_VISIBLE, key: 'page-3' });

      expect(isRenderCancelled(await staleResult)).toBe(true);
      await settle();
      other.finish();
      await settle();
      expect(log).toEqual(['start other', 'end other', 'start zoom2']);
      expect(zoom1.run).not.toHaveBeenCalled();
    });

    it('an AbortSignal cancels the task, before or after it was scheduled', async () => {
      const log: string[] = [];
      const s = createRenderScheduler();

      const already = new AbortController();
      already.abort();
      const dead = job(log, 'dead');
      await expect(s.schedule(dead.run, { signal: already.signal }).promise).rejects.toBeInstanceOf(RenderCancelledError);
      expect(s.pending).toBe(0);

      const later = new AbortController();
      const queued = job(log, 'queued');
      const task = s.schedule(queued.run, { signal: later.signal });
      const result = task.promise.catch((e) => e);
      later.abort();
      expect(isRenderCancelled(await result)).toBe(true);
      await settle(1000);
      expect(log).toEqual([]);
    });
  });

  it('a task that throws or rejects does not stall the queue', async () => {
    const log: string[] = [];
    const s = createRenderScheduler();
    const thrower = s.schedule(() => { throw new Error('sync'); }, { priority: PRIORITY_VISIBLE });
    const rejecter = s.schedule(() => Promise.reject(new Error('async')), { priority: PRIORITY_VISIBLE });
    const ok = job(log, 'ok');
    const last = s.schedule(ok.run, { priority: PRIORITY_VISIBLE });
    const outcomes = Promise.allSettled([thrower.promise, rejecter.promise]);

    // One turn of the queue per failed task, then one for the survivor.
    for (let turn = 0; turn < 3; turn++) await settle(1);
    expect(ok.run).toHaveBeenCalledTimes(1);
    ok.finish();
    await expect(last.promise).resolves.toBe('ok');
    expect((await outcomes).map((o) => o.status)).toEqual(['rejected', 'rejected']);
  });
});
