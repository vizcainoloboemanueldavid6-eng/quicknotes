/**
 * Shared Tailwind theme ("paper" style). Used by both the extension pages
 * (tailwind.config.js) and the UI injected into web pages
 * (tailwind.content.config.js). Pastel note colors themselves live in
 * src/lib/colors.ts because they are also applied as inline styles.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: [],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#F2B705',
          dark: '#C99400',
          soft: '#FFF4CC',
        },
        paper: {
          DEFAULT: '#FFFDF7',
          line: '#EDE6D6',
        },
        ink: {
          DEFAULT: '#1C1917',
          soft: '#57534E',
          faint: '#8A847C',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
        ],
      },
      // Named "soft", not "paper": `shadow-paper` would also be generated as a
      // shadow-*color* utility from colors.paper and override the shadow itself
      // with a near-white one.
      boxShadow: {
        soft: '0 1px 2px rgba(28, 25, 23, 0.08), 0 10px 24px -8px rgba(28, 25, 23, 0.22)',
        'soft-lg': '0 2px 4px rgba(28, 25, 23, 0.10), 0 18px 40px -12px rgba(28, 25, 23, 0.30)',
      },
      zIndex: {
        top: '2147483647',
      },
    },
  },
  plugins: [],
};
