/**
 * Revendo — icônes de l'interface (SVG inline, trait 1,75, style « Lucide »).
 * Aucune police d'icônes ni emoji : tout est dessiné ici, donc compatible
 * avec la CSP (pas de ressource externe).
 */

const PATHS = {
  // Marque : étiquette de prix
  tag: '<path d="M3.5 5v6.1c0 .5.2 1 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8l-7.4-7.4a2 2 0 0 0-1.4-.6H5a1.5 1.5 0 0 0-1.5 1.5z"/><circle cx="8.25" cy="8.25" r="1.5"/>',
  settings: '<path d="M4 7h9"/><path d="M18 7h2"/><circle cx="15.5" cy="7" r="2.25"/><path d="M4 17h2"/><path d="M11 17h9"/><circle cx="8.5" cy="17" r="2.25"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2.25h5.6L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.75" r="3.25"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  x: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.25 2.5 2.5 4.75-5"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9.5 9.5 5 5"/><path d="m14.5 9.5-5 5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.75v5"/><path d="M12 16.25h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.75h.01"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.25c0-.4.3-.75.75-.75h3.5c.4 0 .75.3.75.75V7"/><path d="M6.5 7l.8 11.6a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.25 11v5"/><path d="M13.75 11v5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.25-4.25L7.5 19.5"/>',
  inbox: '<path d="M3.5 13.5 6.1 6a1.5 1.5 0 0 1 1.4-1h9a1.5 1.5 0 0 1 1.4 1l2.6 7.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M3.5 13.5h4.25l1.5 2.5h5.5l1.5-2.5h4.25"/>',
  sparkles: '<path d="M10.5 4.5 12 9l4.5 1.5L12 12l-1.5 4.5L9 12l-4.5-1.5L9 9z"/><path d="M17.5 14.5v5"/><path d="M15 17h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  send: '<path d="M20.5 3.5 10.25 13.75"/><path d="m20.5 3.5-6.25 17-4-6.75-6.75-4z"/>',
  upload: '<path d="M7 18.5h-.25a4.25 4.25 0 0 1-.5-8.47 6 6 0 0 1 11.5 1.47A3.5 3.5 0 0 1 17.5 18.5H17"/><path d="M12 12.5v7"/><path d="m9 15.25 3-3 3 3"/>',
  logout: '<path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10"/><path d="m14.5 7.5 4.5 4.5-4.5 4.5"/><path d="M19 12H9"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7"/><path d="M12 16v4"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14z"/><path d="M20 14v.01"/><path d="M17.5 17.5H20V20"/><path d="M14 20h.01"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.3 3.4 5.2 3.4 8.5s-1.2 6.2-3.4 8.5c-2.2-2.3-3.4-5.2-3.4-8.5s1.2-6.2 3.4-8.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 6 .5l2.5-2.5a4 4 0 0 0-5.7-5.7L11.5 7"/><path d="M14 10.5a4 4 0 0 0-6-.5l-2.5 2.5a4 4 0 0 0 5.7 5.7L12.5 17"/>',
  star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
  ruler: '<path d="M4.6 15.4 15.4 4.6a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L8.6 19.4a1.5 1.5 0 0 1-2.1 0l-1.9-1.9a1.5 1.5 0 0 1 0-2.1z"/><path d="m8 12 1.75 1.75"/><path d="m11 9 1.75 1.75"/><path d="m14 6 1.75 1.75"/>',
  layers: '<path d="m12 4 8.5 4.25L12 12.5 3.5 8.25z"/><path d="m3.5 12.25 8.5 4.25 8.5-4.25"/><path d="m3.5 16 8.5 4.25L20.5 16"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1 0 1.5-.6 1.5-1.4 0-.4-.15-.7-.4-1-.25-.3-.4-.65-.4-1.05 0-.85.7-1.55 1.55-1.55h1.85a4.4 4.4 0 0 0 4.4-4.4C20.5 7 16.7 3.5 12 3.5z"/><circle cx="7.75" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.75" r="1"/>',
  badge: '<path d="M12 3.5l2 1.5 2.5-.2.9 2.3 2.1 1.4-.6 2.5.6 2.5-2.1 1.4-.9 2.3-2.5-.2-2 1.5-2-1.5-2.5.2-.9-2.3-2.1-1.4.6-2.5-.6-2.5 2.1-1.4.9-2.3 2.5.2z"/><path d="m9.25 12 1.85 1.85 3.65-3.7"/>',
  type: '<path d="M5 7V5.5h14V7"/><path d="M12 5.5v13"/><path d="M9.5 18.5h5"/>',
  euro: '<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4.5 10.5h8"/><path d="M4.5 13.5h8"/>',
  note: '<path d="M6 3.5h8.5L18 7v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V7.5h4"/><path d="M8 12h7"/><path d="M8 15.5h5"/>',
};

/** Code SVG d'une icône (taille en px ; décorative par défaut). */
export function icon(name, { size = 20, cls = '', label = '' } = {}) {
  const body = PATHS[name] || PATHS.info;
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`;
}

/** Remplit les éléments <span data-icon="nom" data-size="20"> du HTML statique. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 20 });
}

export const ICON_NAMES = Object.keys(PATHS);
