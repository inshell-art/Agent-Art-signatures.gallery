// Public gallery ↔ personal collection: four canvases balance one 10px dot.
// 4 × 4.5² = 81px² of ink versus π × 5² ≈ 78.5px²; 2px gutters, 11px overall.
export const HOME_ICON = '<svg class="home-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 11" width="11" height="11" fill="currentColor" aria-hidden="true" focusable="false"><rect x="0" y="0" width="4.5" height="4.5"/><rect x="6.5" y="0" width="4.5" height="4.5"/><rect x="0" y="6.5" width="4.5" height="4.5"/><rect x="6.5" y="6.5" width="4.5" height="4.5"/></svg>';

export const HOME_LINK = `<a class="gallery-return home-return" href="/" aria-label="Gallery" title="Gallery">${HOME_ICON}</a>`;
