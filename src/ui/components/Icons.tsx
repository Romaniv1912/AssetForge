import type { SVGProps } from 'react';

const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M5 6.5 8 9.5l3-3" /></svg>
);
export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>
);
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13.5h10" /></svg>
);
export const IconRetry = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" /></svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="m4 4 8 8M12 4l-8 8" /></svg>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="m3.5 8.5 3 3 6-7" /></svg>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M8 2 14.5 13.5h-13L8 2Z" /><path d="M8 6.5v3M8 11.6v.1" /></svg>
);
export const IconArrowLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M9.5 4 5.5 8l4 4" /></svg>
);
export const IconArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="m6.5 4 4 4-4 4" /></svg>
);
export const IconLogo = (p: SVGProps<SVGSVGElement>) => (
  // Same mark as assets/icon.svg, simplified for 18 px.
  <svg width="18" height="18" viewBox="0 0 128 128" fill="none" {...p}>
    <defs>
      <linearGradient id="af-logo-bg" x1="12" y1="8" x2="116" y2="124" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#5B5BF6" />
        <stop offset="1" stopColor="#A43BF0" />
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#af-logo-bg)" />
    <rect x="26" y="30" width="76" height="68" rx="10" fill="#FFFFFF" fillOpacity="0.35" />
    <path d="M36 30h66L26 98V40a10 10 0 0 1 10-10Z" fill="#FFFFFF" />
    <path d="M26 86 46 64l12 12 10-10 12 10L36 98H26Z" fill="#5B5BF6" />
    <rect x="26" y="30" width="76" height="68" rx="10" stroke="#FFFFFF" strokeWidth="6" />
    <path d="M100 72l5.5 14.5L120 92l-14.5 5.5L100 112l-5.5-14.5L80 92l14.5-5.5Z" fill="#FFFFFF" />
  </svg>
);
