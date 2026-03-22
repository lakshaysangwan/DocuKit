import { create } from 'zustand';
import type { ProcessingFile, ProcessingStatus } from '../types/tools';
import { generateId } from '../lib/utils';

export interface ToolState {
  files: ProcessingFile[];
  status: ProcessingStatus;
  progress: number;
  progressLabel: string;
  result: ArrayBuffer | null;
  results: ArrayBuffer[];    // for multi-output operations (split each page, etc.)
  error: string | null;
  // Actions
  addFiles: (files: File[]) => void;
  updateFile: (id: string, updates: Partial<ProcessingFile>) => void;
  removeFile: (id: string) => void;
  reorderFiles: (from: number, to: number) => void;
  setStatus: (status: ProcessingStatus) => void;
  setProgress: (percent: number, label?: string) => void;
  setResult: (buffer: ArrayBuffer) => void;
  setResults: (buffers: ArrayBuffer[]) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

const initialState = {
  files: [] as ProcessingFile[],
  status: 'idle' as ProcessingStatus,
  progress: 0,
  progressLabel: '',
  result: null as ArrayBuffer | null,
  results: [] as ArrayBuffer[],
  error: null as string | null,
};

/** Factory — call this inside each tool island to get an isolated store */
export function createToolStore() {
  return create<ToolState>((set, get) => ({
    ...initialState,

    addFiles: (newFiles) => {
      const processingFiles: ProcessingFile[] = newFiles.map(f => ({
        id: generateId(),
        file: f,
        name: f.name,
        size: f.size,
      }));
      set(state => ({ files: [...state.files, ...processingFiles] }));
    },

    updateFile: (id, updates) => {
      set(state => ({
        files: state.files.map(f => f.id === id ? { ...f, ...updates } : f),
      }));
    },

    removeFile: (id) => {
      set(state => ({ files: state.files.filter(f => f.id !== id) }));
    },

    reorderFiles: (from, to) => {
      set(state => {
        const files = [...state.files];
        const [removed] = files.splice(from, 1);
        files.splice(to, 0, removed);
        return { files };
      });
    },

    setStatus: (status) => set({ status }),

    setProgress: (progress, progressLabel = '') => set({ progress, progressLabel }),

    setResult: (result) => set({ result, status: 'done', progress: 100 }),

    setResults: (results) => set({ results, status: 'done', progress: 100 }),

    setError: (error) => set({ error, status: 'error' }),

    reset: () => set(initialState),
  }));
}
