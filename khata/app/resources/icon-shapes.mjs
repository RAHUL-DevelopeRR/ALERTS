// Single source of truth for the launcher icon artwork, in the 108x108 adaptive-icon grid
// (the launcher mask keeps roughly the central 66-72 units). Used by render-icons.mjs to emit
// resources/icon.svg, the Android vector drawables and the legacy PNG mipmaps.
export const GREEN = '#0f5132';
export const WHITE = '#ffffff';
export const AMBER = '#f5b301';
export const RULE = '#b9d7c4';

/** Foreground layers: { d, fill?, stroke?, width? } drawn in order. */
export const FOREGROUND = [
  // Book body (white page block, rounded corners).
  { d: 'M38,29 H70 A4,4 0 0 1 74,33 V75 A4,4 0 0 1 70,79 H38 A4,4 0 0 1 34,75 V33 A4,4 0 0 1 38,29 Z', fill: WHITE },
  // Amber spine.
  { d: 'M38,29 H42 V79 H38 A4,4 0 0 1 34,75 V33 A4,4 0 0 1 38,29 Z', fill: AMBER },
  // Ledger rules at the foot of the page.
  { d: 'M47,71 H69', stroke: RULE, width: 1.8 },
  { d: 'M47,75 H63', stroke: RULE, width: 1.8 },
  // Rupee sign: two bars, the bowl, and the diagonal leg.
  { d: 'M49,39 H66', stroke: GREEN, width: 3.6 },
  { d: 'M49,45.5 H66', stroke: GREEN, width: 3.6 },
  { d: 'M49,39 H55.5 C60,39 62.5,42 62.5,45.5 C62.5,49 60,52 55.5,52 H50.5 L62,64.5', stroke: GREEN, width: 3.6 },
  // Amber bookmark ribbon.
  { d: 'M68.25,29 V37.5 L70.5,35.5 L72.75,37.5 V29 Z', fill: AMBER },
];

/** Monochrome (Android 13 themed icon): outlines only, the system tints every opaque pixel. */
export const MONOCHROME = [
  { d: 'M38,30.5 H70 A2.5,2.5 0 0 1 72.5,33 V75 A2.5,2.5 0 0 1 70,77.5 H38 A2.5,2.5 0 0 1 35.5,75 V33 A2.5,2.5 0 0 1 38,30.5 Z', stroke: WHITE, width: 3 },
  { d: 'M42,30.5 V77.5', stroke: WHITE, width: 3 },
  { d: 'M49,39 H66', stroke: WHITE, width: 3.6 },
  { d: 'M49,45.5 H66', stroke: WHITE, width: 3.6 },
  { d: 'M49,39 H55.5 C60,39 62.5,42 62.5,45.5 C62.5,49 60,52 55.5,52 H50.5 L62,64.5', stroke: WHITE, width: 3.6 },
];
