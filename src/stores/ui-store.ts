import { create } from 'zustand';

type Theme = 'light' | 'dark' | 'system';

interface UiStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);
  if (theme === 'system') {
    localStorage.removeItem('docukit-theme');
  } else {
    localStorage.setItem('docukit-theme', theme);
  }
}

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const saved = localStorage.getItem('docukit-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'system';
}

export const useUiStore = create<UiStore>((set) => {
  const initial = getInitialTheme();
  // Apply saved theme on store creation
  if (typeof document !== 'undefined') applyTheme(initial);
  return {
    theme: initial,
    setTheme: (theme) => {
      applyTheme(theme);
      set({ theme });
    },
  };
});
