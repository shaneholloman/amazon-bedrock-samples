import { useThemeStore } from '../store/theme.js';
import { MoonIcon, SunIcon } from './icons.js';

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      className="bmkb-btn-ghost h-9 w-9 !px-0"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      {isDark ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
    </button>
  );
}
