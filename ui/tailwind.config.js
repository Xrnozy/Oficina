/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', '"Segoe UI Variable"', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
      colors: {
        // DESIGN-figma.md: monochrome ink/canvas + pastel color blocks.
        canvas: v('canvas'),
        surface: v('surface'),
        raised: v('raised'),
        sunken: v('sunken'),
        line: v('line'),
        'line-strong': v('line-strong'),
        fg: v('fg'),
        'fg-2': v('fg-2'),
        'fg-3': v('fg-3'),
        'fg-4': v('fg-4'),
        accent: v('accent'),
        'accent-ink': v('accent-ink'),
        ok: v('ok'),
        info: v('info'),
        warn: v('warn'),
        bad: v('bad'),
        magenta: v('magenta'),
        lime: v('lime'),
        lilac: v('lilac'),
        cream: v('cream'),
        pink: v('pink'),
        mint: v('mint'),
        coral: v('coral'),
        navy: v('navy'),
      },
      fontSize: {
        '2xs': ['10.5px', '14px'],
        xs: ['11.5px', '16px'],
        sm: ['13px', '19px'],
      },
      boxShadow: {
        pop: '0 1px 0 0 rgb(0 0 0 / 0.03) inset, 0 4px 16px 0 rgb(0 0 0 / 0.06), 0 12px 32px -8px rgb(0 0 0 / 0.12)',
      },
      keyframes: {
        rise: { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        slide: { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'none' } },
        pulse2: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: {
        rise: 'rise 220ms cubic-bezier(.2,.8,.2,1) both',
        slide: 'slide 240ms cubic-bezier(.2,.8,.2,1) both',
        pulse2: 'pulse2 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
