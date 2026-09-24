/** Small inline SVG icons (stroke-based, 16px grid). Decorative: labels live on the buttons. */
import type { ComponentChildren } from 'preact';

function Icon({ children, size = 16 }: { children: ComponentChildren; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconNote = () => (
  <Icon>
    <path d="M3 2.5h10v7l-3.5 4H3z" />
    <path d="M13 9.5H9.5v4" />
  </Icon>
);

export const IconBold = () => (
  <Icon>
    <path d="M4.5 2.5h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z" stroke-width="1.8" />
  </Icon>
);

export const IconItalic = () => (
  <Icon>
    <path d="M10 2.5 6 13.5M7 2.5h5M4 13.5h5" />
  </Icon>
);

export const IconBulletList = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <circle cx="3" cy="4" r="0.6" fill="currentColor" />
    <circle cx="3" cy="8" r="0.6" fill="currentColor" />
    <circle cx="3" cy="12" r="0.6" fill="currentColor" />
  </Icon>
);

export const IconNumberedList = () => (
  <Icon>
    <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
    <path d="M2.5 3 3.5 2.5v3M2.3 7.3c.3-.6 1.7-.6 1.7.3 0 .7-1.7 1.3-1.7 2h1.8" stroke-width="1.1" />
  </Icon>
);

export const IconTrash = () => (
  <Icon>
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
  </Icon>
);

export const IconMinus = () => (
  <Icon>
    <path d="M3.5 8h9" />
  </Icon>
);

export const IconExpand = () => (
  <Icon>
    <path d="M3 6.5V3h3.5M13 9.5V13H9.5M3 3l4 4M13 13 9 9" />
  </Icon>
);

export const IconClose = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const IconGrip = () => (
  <Icon size={12}>
    <path d="M13 9 9 13M13 5l-8 8" stroke-width="1.4" />
  </Icon>
);
