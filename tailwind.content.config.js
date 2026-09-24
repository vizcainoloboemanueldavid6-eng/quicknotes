import preset from './tailwind.preset.js';

/**
 * UI injected into web pages (inside a shadow root). Only scans the content
 * script so the CSS string embedded in it stays small.
 * @type {import('tailwindcss').Config}
 */
export default {
  presets: [preset],
  content: ['./src/content/**/*.{ts,tsx}'],
};
