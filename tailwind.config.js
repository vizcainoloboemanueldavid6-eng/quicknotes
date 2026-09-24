import preset from './tailwind.preset.js';

/** Extension pages: popup, side panel, options. @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  content: [
    './src/popup/**/*.{html,ts,tsx}',
    './src/sidepanel/**/*.{html,ts,tsx}',
    './src/options/**/*.{html,ts,tsx}',
    './src/ui/**/*.{ts,tsx}',
  ],
};
