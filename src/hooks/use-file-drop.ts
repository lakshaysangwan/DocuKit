import { useCallback, useRef, useState } from 'react';
import { MAX_FILE_SIZE } from '../lib/file-utils';
import { formatBytes } from '../lib/utils';
import { toast } from 'sonner';

export type DropZoneState = 'idle' | 'drag-over' | 'accepted' | 'rejected';

interface UseFileDropOptions {
  accept: string[];           // MIME types
  maxFiles?: number;
  maxSize?: number;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}

export function useFileDrop(options: UseFileDropOptions) {
  const {
    accept,
    maxFiles,
    maxSize = MAX_FILE_SIZE,
    multiple = true,
    onFiles,
  } = options;

  const [dropState, setDropState] = useState<DropZoneState>('idle');
  const dragCounter = useRef(0);

  const validateFiles = useCallback((files: File[]): File[] => {
    const valid: File[] = [];
    const errors: string[] = [];

    for (const file of files) {
      // MIME check
      const mimeOk = accept.some(a => {
        if (a.endsWith('/*')) return file.type.startsWith(a.slice(0, -1));
        return file.type === a || file.name.toLowerCase().endsWith(a.replace('image/', '.').replace('application/', '.'));
      });
      if (!mimeOk) {
        errors.push(`"${file.name}" is not a supported file type.`);
        continue;
      }
      // Size check
      if (file.size > maxSize) {
        if (file.size > MAX_FILE_SIZE) {
          toast.warning(`"${file.name}" is ${formatBytes(file.size)} — files over 200MB may cause memory issues.`);
        } else {
          errors.push(`"${file.name}" exceeds the ${formatBytes(maxSize)} limit.`);
          continue;
        }
      }
      valid.push(file);
    }

    if (errors.length > 0) {
      errors.forEach(e => toast.error(e));
    }

    if (!multiple && valid.length > 1) {
      toast.warning('Only the first file will be used.');
      return [valid[0]];
    }

    if (maxFiles && valid.length > maxFiles) {
      toast.warning(`Maximum ${maxFiles} files allowed. Taking the first ${maxFiles}.`);
      return valid.slice(0, maxFiles);
    }

    return valid;
  }, [accept, maxFiles, maxSize, multiple]);

  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const valid = validateFiles(files);
    if (valid.length > 0) {
      setDropState('accepted');
      onFiles(valid);
      setTimeout(() => setDropState('idle'), 1500);
    } else {
      setDropState('rejected');
      setTimeout(() => setDropState('idle'), 1500);
    }
  }, [validateFiles, onFiles]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setDropState('drag-over');
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDropState('idle');
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  }, [handleFiles]);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    handleFiles(files);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, [handleFiles]);

  return {
    dropState,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    onInputChange,
  };
}
