// Inline SVG icons (stroke = currentColor).

const svg = (body, size = 20) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  clock: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', s),
  check: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>', s),
  cross: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>', s),
  bell: (s) => svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', s),
  qr: (s) => svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>', s),
  settings: (s) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', s),
  back: (s) => svg('<path d="m9 18 6-6-6-6"/>', s),
  undo: (s) => svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', s),
  bag: (s) => svg('<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>', s),
  trash: (s) => svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', s),
  print: (s) => svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>', s),
  download: (s) => svg('<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>', s),
  upload: (s) => svg('<path d="M12 20V9m0 0-4 4m4-4 4 4M5 4h14"/>', s),
  refresh: (s) => svg('<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>', s),
  logout: (s) => svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>', s),
  sound: (s) => svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>', s),
};
