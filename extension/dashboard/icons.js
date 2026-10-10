/**
 * Revendo — icônes du dashboard PC (SVG inline, grille 24, trait 1,75, sans
 * remplissage, style « Lucide »). Mêmes tracés que le dashboard téléphone
 * (web/icons.js) pour garder une seule identité. Aucune police d'icônes ni
 * emoji d'interface : tout est dessiné ici, compatible avec la CSP de l'extension.
 */

const PATHS = {
  // Marque : étiquette de prix
  tag: '<path d="M3.5 5v6.1c0 .5.2 1 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8l-7.4-7.4a2 2 0 0 0-1.4-.6H5a1.5 1.5 0 0 0-1.5 1.5z"/><circle cx="8.25" cy="8.25" r="1.5"/>',

  // Navigation
  plusSquare: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7"/><path d="M8.5 12h7"/>',
  inbox: '<path d="M3.5 13.5 6.1 6a1.5 1.5 0 0 1 1.4-1h9a1.5 1.5 0 0 1 1.4 1l2.6 7.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/><path d="M3.5 13.5h4.25l1.5 2.5h5.5l1.5-2.5h4.25"/>',
  users: '<circle cx="9" cy="8.5" r="3.25"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.4a3.25 3.25 0 0 1 0 6.2"/><path d="M17.5 14a5.5 5.5 0 0 1 3 5"/>',
  settings: '<path d="M4 7h9"/><path d="M18 7h2"/><circle cx="15.5" cy="7" r="2.25"/><path d="M4 17h2"/><path d="M11 17h9"/><circle cx="8.5" cy="17" r="2.25"/>',
  activity: '<path d="M3.5 12h3.5l2.5-6.5 5 13 2.5-6.5h3.5"/>',

  // Actions
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.25c0-.4.3-.75.75-.75h3.5c.4 0 .75.3.75.75V7"/><path d="M6.5 7l.8 11.6a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.25 11v5"/><path d="M13.75 11v5"/>',
  play: '<path d="M8 5.6v12.8a.9.9 0 0 0 1.4.75l10-6.4a.9.9 0 0 0 0-1.5l-10-6.4A.9.9 0 0 0 8 5.6z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8.5A1.5 1.5 0 0 1 6 7h4.5"/>',
  download: '<path d="M12 4.5v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 15.5v-11"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M4.5 19.5h15"/>',
  send: '<path d="M20.5 3.5 10.25 13.75"/><path d="m20.5 3.5-6.25 17-4-6.75-6.75-4z"/>',
  eraser: '<path d="M8 19.5h11.5"/><path d="m4.9 14.6 9.2-9.2a2 2 0 0 1 2.8 0l2.7 2.7a2 2 0 0 1 0 2.8L12 18.5H8.8z"/><path d="m9.5 10 5.5 5.5"/>',
  star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  scanText: '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 9.5h8"/><path d="M8 12h8"/><path d="M8 14.5h5"/>',
  imagePlus: '<path d="M19.5 12.5v5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h6"/><circle cx="9" cy="9.5" r="1.5"/><path d="m19.5 16-3.5-3.5-8.5 7"/><path d="M17.5 3v6"/><path d="M14.5 6h6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.25-4.25L7.5 19.5"/>',
  wand: '<path d="m4.5 19.5 10-10"/><path d="m13 8 3 3"/><path d="M17.5 3.5v3"/><path d="M16 5h3"/><path d="M19.5 10.5v2"/><path d="M18.5 11.5h2"/><path d="M9.5 3.5v2"/><path d="M8.5 4.5h2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.75"/>',

  // Domaines
  sparkles: '<path d="M10.5 4.5 12 9l4.5 1.5L12 12l-1.5 4.5L9 12l-4.5-1.5L9 9z"/><path d="M17.5 14.5v5"/><path d="M15 17h5"/>',
  trendingUp: '<path d="m3.5 17 6-6 4 4 7-7.5"/><path d="M15 7.5h5.5V13"/>',
  gitBranch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5c0 4-3.5 5-9.6 7.6"/>',
  bot: '<rect x="4" y="8" width="16" height="11.5" rx="3"/><path d="M12 8V4.5"/><path d="M10 4.5h4"/><path d="M9.25 12.75v1.5"/><path d="M14.75 12.75v1.5"/><path d="M2 13v2.5"/><path d="M22 13v2.5"/>',
  smartphone: '<rect x="6.5" y="3" width="11" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.25"/><path d="M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9"/><path d="M10 13h4"/>',
  key: '<circle cx="8" cy="15.5" r="3.5"/><path d="m10.5 13 8-8"/><path d="m16 7.5 2.5 2.5"/><path d="m13.75 9.75 2 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.3 3.4 5.2 3.4 8.5s-1.2 6.2-3.4 8.5c-2.2-2.3-3.4-5.2-3.4-8.5s1.2-6.2 3.4-8.5z"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14z"/><path d="M20 14v.01"/><path d="M17.5 17.5H20V20"/><path d="M14 20h.01"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M8.5 20h7"/><path d="M12 16v4"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5a7 7 0 0 1 14 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 6 .5l2.5-2.5a4 4 0 0 0-5.7-5.7L11.5 7"/><path d="M14 10.5a4 4 0 0 0-6-.5l-2.5 2.5a4 4 0 0 0 5.7 5.7L12.5 17"/>',
  euro: '<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4.5 10.5h8"/><path d="M4.5 13.5h8"/>',
  note: '<path d="M6 3.5h8.5L18 7v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V7.5h4"/><path d="M8 12h7"/><path d="M8 15.5h5"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1 0 1.6-.8 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6h2a5.5 5.5 0 0 0 5.5-5.5C21.9 6.6 17.5 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/><circle cx="17" cy="11" r="1"/>',
  layers: '<path d="m12 4 8.5 4.25L12 12.5 3.5 8.25z"/><path d="m3.5 12.25 8.5 4.25 8.5-4.25"/><path d="m3.5 16 8.5 4.25L20.5 16"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',

  // États
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.75h.01"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.25 2.5 2.5 4.75-5"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9.5 9.5 5 5"/><path d="m14.5 9.5-5 5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.75v5"/><path d="M12 16.25h.01"/>',
  alertTriangle: '<path d="M10.3 4.6 3.2 17a2 2 0 0 0 1.7 3h14.2a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  loader: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>',
};

/** Code SVG d'une icône (taille en px ; décorative sauf si `label` est fourni). */
export function icon(name, { size = 18, cls = '', label = '' } = {}) {
  const body = PATHS[name] || PATHS.info;
  const a11y = label ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`;
}

/** Remplit chaque <span data-icon="nom" data-size="18"> du HTML statique avec son SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 18 });
}
