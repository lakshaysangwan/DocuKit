import { describe, it, expect } from 'vitest';
import { formatBytes, isLargeFile, LARGE_FILE_BYTES } from './utils';

describe('formatBytes', () => {
  it('formats zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });
});

describe('isLargeFile', () => {
  it('is false below the threshold', () => {
    expect(isLargeFile(0)).toBe(false);
    expect(isLargeFile(LARGE_FILE_BYTES - 1)).toBe(false);
  });

  it('is true at or above the threshold', () => {
    expect(isLargeFile(LARGE_FILE_BYTES)).toBe(true);
    expect(isLargeFile(LARGE_FILE_BYTES + 1)).toBe(true);
  });
});
