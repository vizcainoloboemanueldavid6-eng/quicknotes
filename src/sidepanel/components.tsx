/** Small building blocks shared by the side panel's two tabs. */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PALETTE } from '../lib/colors';
import { markMatches } from '../lib/search';
import type { Color } from '../lib/types';

export function ColorDot({ color, size = 'sm' }: { color: Color; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      class={`inline-block shrink-0 rounded-full border ${size === 'sm' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'}`}
      style={{ backgroundColor: PALETTE[color].dot, borderColor: PALETTE[color].edge }}
    />
  );
}

export function SectionTitle({ children, count }: { children: ComponentChildren; count?: number }) {
  return (
    <h3 class="flex items-baseline gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-soft dark:text-[#cfc8bb]">
      {children}
      {count !== undefined && <span class="font-normal tabular-nums text-ink-faint">({count})</span>}
    </h3>
  );
}

/** Text with the parts that match the search query wrapped in <mark>. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {markMatches(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} class="rounded-sm bg-primary/40 px-px text-inherit dark:bg-primary/35">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * A destructive button that asks for a second click (within 3 s) instead of a
 * modal dialog. `label` names the action for screen readers; `confirmLabel` is
 * shown while waiting for the second click.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  class: className = '',
  idle,
  testId,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  class?: string;
  /** Content shown before the first click (defaults to the label). */
  idle?: ComponentChildren;
  testId?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={armed ? confirmLabel : label}
      title={armed ? confirmLabel : label}
      class={`${className} ${
        armed
          ? 'bg-red-600 px-2 text-[12px] font-semibold text-white hover:bg-red-700'
          : 'text-ink-soft hover:bg-red-50 hover:text-red-700 dark:text-[#cfc8bb] dark:hover:bg-red-950 dark:hover:text-red-300'
      }`}
      onClick={(event) => {
        event.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : (idle ?? label)}
    </button>
  );
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5v7.5M4.5 7 8 10.5 11.5 7M3 13.5h10"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 11V3.5M4.5 7 8 3.5 11.5 7M3 13.5h10"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}
