import type { Color } from './types';

export const PRIMARY = '#F2B705';

export interface ColorSwatch {
  /** Background of highlighted text on the page. */
  highlight: string;
  /** Paper color of a sticky note. */
  note: string;
  /** Darker edge used for the note header and swatch borders. */
  edge: string;
  /** Solid dot used in pickers and lists. */
  dot: string;
}

/** Pastel "paper" palette. Text on every one of these stays at #1C1917 for contrast. */
export const PALETTE: Readonly<Record<Color, ColorSwatch>> = Object.freeze({
  yellow: { highlight: '#FDE68A', note: '#FFF3B0', edge: '#EBD27A', dot: '#F2B705' },
  green: { highlight: '#BBF7D0', note: '#DDF6E1', edge: '#A9DDB4', dot: '#3FAE62' },
  blue: { highlight: '#BFDBFE', note: '#DCEAFC', edge: '#A9C7EC', dot: '#3B82D6' },
  pink: { highlight: '#FBCFE8', note: '#FCE1EE', edge: '#EDB3CF', dot: '#DB5A9A' },
});

export const INK = '#1C1917';
