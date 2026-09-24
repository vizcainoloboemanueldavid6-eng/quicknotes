import tailwindcss from 'tailwindcss';

/**
 * Converts `rem` to `px` (16px = 1rem) after Tailwind has run. `rem` is relative
 * to the *page's* <html> font size, which the injected UI does not control: on a
 * site that sets `html { font-size: 10px }` every rem-based size would shrink.
 * Pixel values make the shadow-DOM UI independent of the host page.
 */
const remToPx = () => ({
  postcssPlugin: 'quicknotes-rem-to-px',
  Declaration(decl) {
    if (!decl.value.includes('rem')) return;
    decl.value = decl.value.replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Number(n) * 16}px`);
  },
});
remToPx.postcss = true;

export default {
  plugins: [tailwindcss(), remToPx()],
};
