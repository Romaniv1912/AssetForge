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
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" {...p}>
    <rect x="1" y="1" width="16" height="16" rx="4" fill="var(--accent)" />
    <path d="M5 12.5 8 5.5l3 7M6.2 10h3.6M11.5 8.5h2M12.5 7.5v2" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
