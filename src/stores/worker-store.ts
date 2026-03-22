import { create } from 'zustand';
import { generateId } from '../lib/utils';

export interface WorkerJob {
  id: string;
  tool: string;
  percent: number;
  label: string;
  cancel?: () => void;
}

interface WorkerStore {
  activeJobs: WorkerJob[];
  addJob: (job: Omit<WorkerJob, 'id'>) => string;
  updateJob: (id: string, updates: Partial<Omit<WorkerJob, 'id'>>) => void;
  removeJob: (id: string) => void;
  cancelJob: (id: string) => void;
}

export const useWorkerStore = create<WorkerStore>((set, get) => ({
  activeJobs: [],

  addJob: (job) => {
    const id = generateId();
    set(state => ({ activeJobs: [...state.activeJobs, { ...job, id }] }));
    return id;
  },

  updateJob: (id, updates) => {
    set(state => ({
      activeJobs: state.activeJobs.map(j => j.id === id ? { ...j, ...updates } : j),
    }));
  },

  removeJob: (id) => {
    set(state => ({ activeJobs: state.activeJobs.filter(j => j.id !== id) }));
  },

  cancelJob: (id) => {
    const job = get().activeJobs.find(j => j.id === id);
    job?.cancel?.();
    set(state => ({ activeJobs: state.activeJobs.filter(j => j.id !== id) }));
  },
}));
