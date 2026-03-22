import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useUiStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';

export default function ThemeToggle() {
  const { theme, setTheme } = useUiStore();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render after mount
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="h-9 w-9" aria-hidden="true" />;
  }

  const isDark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const toggle = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-lg',
        'text-[var(--color-text-secondary)] transition-colors duration-150',
        'hover:bg-[var(--color-border)] hover:text-[var(--color-text-primary)]',
        'focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]',
      )}
    >
      {isDark
        ? <Sun className="h-4 w-4" />
        : <Moon className="h-4 w-4" />
      }
    </button>
  );
}
