import type { ReactNode, SVGProps } from 'react';

const paths = {
  home: <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />,
  wheel: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="1.8" />
      <path d="M12 3.5v6.7M12 13.8v6.7M3.5 12h6.7M13.8 12h6.7M6 6l4.7 4.7M13.3 13.3 18 18M18 6l-4.7 4.7M10.7 13.3 6 18" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="2" />
      <path d="M3 9h18M12 9v11M12 9c-2.5 0-4.5-1-4.5-3S10 3.5 12 9zm0 0c2.5 0 4.5-1 4.5-3S14 3.5 12 9z" />
    </>
  ),
  orders: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2.5" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.7" />
      <path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  chat: <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1-4.2A8 8 0 1 1 20 12z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v5M12 16.2v.100" />
    </>
  ),
  inbox: <path d="M4 13 6.5 5h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm0 0h4.5l1 2.5h5l1-2.5H20" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3 19.5c.600-3 2.9-4.7 6-4.7s5.4 1.7 6 4.7M16 5.6a3.2 3.2 0 0 1 0 5.8M18 14.9c1.7.600 2.7 2 3 4.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  shield: <path d="M12 3.5 5 6v5.5c0 4.3 2.8 7.7 7 9 4.2-1.3 7-4.7 7-9V6z" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.100M4 12h.100M4 18h.100" />,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l.800 12.5h8.4L17 7" />,
  logout: <path d="M10 5H5.5v14H10M14 8l4 4-4 4M18 12H9" />,
  link: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 22,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
