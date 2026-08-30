// sprite.js — one icon sheet, injected once, referenced by <use href="#i-…">.
//
// It lives in JS rather than in each HTML file so the OS and the Studio cannot
// drift apart, and so a custom app that names an icon gets the same glyph the
// dock does. `icon()` in core.js resolves against these ids.

const ICONS = {
  files: '<path d="M2.5 5.5a2 2 0 012-2h3l1.6 2h6.4a2 2 0 012 2v7a2 2 0 01-2 2h-11a2 2 0 01-2-2z"/>',
  shell: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M6 8l2.5 2L6 12M11 12.5h3.5"/>',
  notes: '<path d="M5 3.5h7L15.5 7v9.5a1 1 0 01-1 1h-9a1 1 0 01-1-1v-12a1 1 0 011-1z"/><path d="M11.5 3.5V7H15M7 10.5h6M7 13.5h4"/>',
  assistant: '<path d="M10 2.6l1.8 4.4 4.4 1.8-4.4 1.8L10 15l-1.8-4.4L3.8 8.8l4.4-1.8z"/>',
  metrics: '<path d="M3 16.5V9M7.7 16.5V4.5M12.3 16.5v-5M17 16.5V7.5"/>',
  media: '<rect x="2.8" y="4" width="14.4" height="12" rx="2"/><path d="M2.8 13l3.5-3.5 3 3 3-3.5 4.9 4.5"/><circle cx="7" cy="8" r="1.2"/>',
  browser: '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c1.9 2 2.9 4.5 2.9 7.2s-1 5.2-2.9 7.2c-1.9-2-2.9-4.5-2.9-7.2s1-5.2 2.9-7.2z"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2L4.8 4.8"/>',
  jobs: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.8V10l2.8 1.8"/>',
  activity: '<path d="M2.5 10h3l2-5 3.5 10 2.5-5h4"/>',
  apps: '<rect x="3" y="3" width="6" height="6" rx="1.6"/><rect x="11" y="3" width="6" height="6" rx="1.6"/><rect x="3" y="11" width="6" height="6" rx="1.6"/><rect x="11" y="11" width="6" height="6" rx="1.6"/>',
  theme: '<path d="M16 11.4A6.6 6.6 0 018.6 4a6.7 6.7 0 100 13.4 6.6 6.6 0 007.4-6z"/>',
  search: '<circle cx="8.8" cy="8.8" r="5.3"/><path d="M12.8 12.8L17 17"/>',
  bell: '<path d="M6 8a4 4 0 118 0c0 4 1.5 5 1.5 5h-11S6 12 6 8z"/><path d="M8.5 16a1.6 1.6 0 003 0"/>',
  wifi: '<path d="M3.5 8.5a9 9 0 0113 0M6 11a5.3 5.3 0 018 0"/><circle cx="10" cy="14" r="1"/>',
  battery: '<rect x="2.5" y="6.5" width="13" height="7" rx="1.6"/><path d="M17.5 9v2"/><rect x="4" y="8" width="7" height="4" rx="1" fill="currentColor" stroke="none"/>',
  layers: '<path d="M10 2.8l7 3.8-7 3.8-7-3.8z"/><path d="M3 10l7 3.8 7-3.8M3 13.4l7 3.8 7-3.8"/>',
  library: '<rect x="3" y="3.5" width="4" height="13" rx="1"/><rect x="8.2" y="3.5" width="4" height="13" rx="1"/><path d="M13.6 5l3 12.2 1.2-.3-3-12.2z"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  x: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  minus: '<path d="M5 10h10"/>',
  window: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 7.5h14"/>',
  grid: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 3v14"/>',
  send: '<path d="M17 3L9 11M17 3l-5.4 14-2.6-6L3 8.4z"/>',
  play: '<path d="M6.5 4.5l9 5.5-9 5.5z"/>',
  trash: '<path d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 10a1.5 1.5 0 001.5 1.4h4.4a1.5 1.5 0 001.5-1.4l.8-10"/>',
  refresh: '<path d="M16.5 8.5a6.6 6.6 0 10-.6 4.6"/><path d="M16.8 4v4.6h-4.6"/>',
  code: '<path d="M7 6.5L3.5 10 7 13.5M13 6.5L16.5 10 13 13.5M11.5 4.5l-3 11"/>',
  save: '<path d="M4 4.5h9L16 7.5v8a1 1 0 01-1 1H5a1 1 0 01-1-1z"/><path d="M7 4.5v4h5v-4M7 16.5v-4h6v4"/>',
  ports: '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c1.9 2 2.9 4.5 2.9 7.2s-1 5.2-2.9 7.2c-1.9-2-2.9-4.5-2.9-7.2s1-5.2 2.9-7.2z"/>',
  sync: '<path d="M2.6 8.4c1.6-1.7 3.1-1.7 4.7 0s3.1 1.7 4.7 0 3.1-1.7 4.7 0"/><path d="M2.6 13.4c1.6-1.7 3.1-1.7 4.7 0s3.1 1.7 4.7 0 3.1-1.7 4.7 0"/>',
  back: '<path d="M12 5l-5 5 5 5"/>',
  eye: '<path d="M1.8 10S4.9 4.8 10 4.8 18.2 10 18.2 10 15.1 15.2 10 15.2 1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.4"/>',
};

let injected = false;

/** Inject the sheet once per document. Safe to call from every module. */
export function mountSprite(root = document.body) {
  if (injected) return;
  injected = true;
  const defs = Object.entries(ICONS).map(([name, body]) =>
    `<g id="i-${name}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
  ).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  svg.innerHTML = `<defs>${defs}</defs>`;
  root.prepend(svg);
}

/** Fall back to a generic glyph rather than an empty square for an unknown name. */
export const iconName = (name) => (Object.hasOwn(ICONS, name) ? name : "apps");

export const ICON_NAMES = Object.keys(ICONS);
