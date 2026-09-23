/**
 * THE ONLY FILE THAT MAY CONTAIN COLOR LITERALS.
 * Every mesh, shader uniform, particle, HUD stroke and CSS variable reads from here.
 * Hex values are sRGB; consumers convert with col() so the working space stays linear.
 */
import { Color } from 'three';

export type ThemeId = 'city' | 'mountain' | 'night' | 'bay' | 'canyon' | 'storm';

export interface Theme {
  id: ThemeId;
  night: boolean;
  sky: { top: number; horizon: number; bottom: number; sun: number; cloud: number; cloudShade: number };
  /** direction TO the sun, world space (normalized at use) */
  sunDir: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  /** multiplied into the dark band; hue-shifted rather than just darker */
  shadeTint: number;
  rim: number;
  ink: number;
  fog: number;
  fogStart: number;
  fogEnd: number;
  grade: { saturation: number; contrast: number; vignette: number; lift: number };
  ground: { grass: number; grass2: number; dirt: number; rock: number; rock2: number; rock3: number; snow: number; sand: number; sidewalk: number };
  road: { asphalt: number; asphalt2: number; line: number; lineYellow: number; curbA: number; curbB: number; runoff: number; wall: number; wallStripe: number; rail: number };
  water: { deep: number; mid: number; light: number; foam: number; spec: number };
  props: {
    trunk: number; leaf: number[]; building: number[]; window: number; windowLit: number; roof: number;
    lamp: number; lampLight: number; neon: number[]; buoyA: number; buoyB: number; rampA: number; rampB: number;
    towerA: number; towerB: number; banner: number; bannerAlt: number;
  };
}

const THEMES: Record<ThemeId, Theme> = {
  city: {
    id: 'city', night: false,
    sky: { top: 0x3b8de0, horizon: 0xbfe6ff, bottom: 0xeaf7ff, sun: 0xfff6d8, cloud: 0xffffff, cloudShade: 0xb3c4ec },
    sunDir: [0.45, 0.72, 0.35], sunColor: 0xfff3dc, sunIntensity: 1.0,
    shadeTint: 0x6873bd, rim: 0xffffff, ink: 0x1a1633,
    fog: 0xcfe9ff, fogStart: 260, fogEnd: 1500,
    grade: { saturation: 1.12, contrast: 1.06, vignette: 0.28, lift: 0.0 },
    ground: { grass: 0x7cc850, grass2: 0x5fae3e, dirt: 0xc9a46a, rock: 0xa39a92, rock2: 0x857c78, rock3: 0xb8ada4, snow: 0xf4f7ff, sand: 0xf0d9a0, sidewalk: 0xd9d2c5 },
    road: { asphalt: 0x4a4f66, asphalt2: 0x41465b, line: 0xf6f6f0, lineYellow: 0xffd23f, curbA: 0xe8383d, curbB: 0xf6f6f0, runoff: 0x8fcf62, wall: 0xdcd8d0, wallStripe: 0xe8383d, rail: 0xc9ced8 },
    water: { deep: 0x1f6fb2, mid: 0x2f9bd6, light: 0x7fd6f0, foam: 0xffffff, spec: 0xffffff },
    props: {
      trunk: 0x8a5a3b, leaf: [0x4fae45, 0x6cc24a, 0x3d9a4a], building: [0xf2c2a0, 0xa8d0e6, 0xf5e6b8, 0xc9b8e8, 0xf0a8a0, 0xb8e0c8],
      window: 0x3d5f94, windowLit: 0xffe9a0, roof: 0x6c6f80, lamp: 0x3b3f52, lampLight: 0xfff1b0,
      neon: [0xff4fa8, 0x3ff0ff, 0xb56cff], buoyA: 0xff5a36, buoyB: 0xffffff, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0xffffff, towerB: 0xe8383d, banner: 0xff4538, bannerAlt: 0x2f8dff,
    },
  },
  mountain: {
    id: 'mountain', night: false,
    sky: { top: 0x5a4fb0, horizon: 0xffb27a, bottom: 0xffd9b0, sun: 0xfff0c0, cloud: 0xffd4c4, cloudShade: 0xb07aa8 },
    sunDir: [-0.62, 0.34, -0.55], sunColor: 0xffd9a8, sunIntensity: 1.05,
    shadeTint: 0x5a4f9c, rim: 0xffe0b0, ink: 0x231530,
    fog: 0xf5b48e, fogStart: 220, fogEnd: 1400,
    grade: { saturation: 1.1, contrast: 1.08, vignette: 0.32, lift: 0.01 },
    ground: { grass: 0x93b84a, grass2: 0x729a3e, dirt: 0xb98b5a, rock: 0x9a8290, rock2: 0x7a6478, rock3: 0xb09aa0, snow: 0xfff4f0, sand: 0xe0c090, sidewalk: 0xc8b8a8 },
    road: { asphalt: 0x4d4760, asphalt2: 0x443f57, line: 0xfff8ec, lineYellow: 0xffcf4a, curbA: 0x3a6fe0, curbB: 0xfff8ec, runoff: 0xb39a6a, wall: 0xd0c0b0, wallStripe: 0x3a6fe0, rail: 0xd8d0d8 },
    water: { deep: 0x2d5a9a, mid: 0x4f7fc0, light: 0xa8b8e8, foam: 0xfff0e8, spec: 0xffffff },
    props: {
      trunk: 0x6e4a3a, leaf: [0x3e7a4f, 0x4d8f58, 0x336b48], building: [0xe8d0b0, 0xc9a890, 0xf0e0c8],
      window: 0x4a3f6a, windowLit: 0xffe0a0, roof: 0x8a4f4f, lamp: 0x3b3f52, lampLight: 0xfff1b0,
      neon: [0xff6fa8, 0x6ff0ff], buoyA: 0xff5a36, buoyB: 0xffffff, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0xfff8ec, towerB: 0x3a6fe0, banner: 0x3a6fe0, bannerAlt: 0xffcf4a,
    },
  },
  night: {
    id: 'night', night: true,
    sky: { top: 0x070a24, horizon: 0x2c2672, bottom: 0x3d3084, sun: 0xe8f0ff, cloud: 0x3a3a78, cloudShade: 0x1d1d45 },
    sunDir: [-0.3, 0.6, 0.55], sunColor: 0xa4b4ff, sunIntensity: 0.85,
    shadeTint: 0x3a3f8a, rim: 0x7fe8ff, ink: 0x05040f,
    fog: 0x201c56, fogStart: 160, fogEnd: 1150,
    grade: { saturation: 1.18, contrast: 1.1, vignette: 0.4, lift: 0.015 },
    ground: { grass: 0x2e4a3c, grass2: 0x243d33, dirt: 0x4a4050, rock: 0x3f4058, rock2: 0x33344a, rock3: 0x4a4a66, snow: 0xc8d0ff, sand: 0x5a5470, sidewalk: 0x3a3d58 },
    road: { asphalt: 0x2a2c42, asphalt2: 0x24263a, line: 0xe8f4ff, lineYellow: 0xffc93f, curbA: 0xff3fa0, curbB: 0xe8f4ff, runoff: 0x2f3352, wall: 0x3a3e5e, wallStripe: 0x3ff0ff, rail: 0x8890b0 },
    water: { deep: 0x0f1c4a, mid: 0x1c2f6e, light: 0x3f5fb0, foam: 0xcfe0ff, spec: 0xe8f0ff },
    props: {
      trunk: 0x3a2f3a, leaf: [0x1f4a3f, 0x2a5a4a], building: [0x2d3257, 0x3a2f5c, 0x273a52, 0x3d3050, 0x2a2a48],
      window: 0x1a1f3a, windowLit: 0xffd873, roof: 0x1c1d30, lamp: 0x4a4e6a, lampLight: 0xffe7a0,
      neon: [0xff4fa8, 0x3ff0ff, 0xb56cff, 0xffe14f], buoyA: 0xff3fa0, buoyB: 0x3ff0ff, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0x3a3e5e, towerB: 0xff3fa0, banner: 0xff3fa0, bannerAlt: 0x3ff0ff,
    },
  },
  bay: {
    id: 'bay', night: false,
    sky: { top: 0x2f9df0, horizon: 0xc8f2ff, bottom: 0xeafaff, sun: 0xfffbe8, cloud: 0xffffff, cloudShade: 0xa8c4ee },
    sunDir: [0.5, 0.66, -0.4], sunColor: 0xfff6e2, sunIntensity: 1.0,
    shadeTint: 0x5f7fc4, rim: 0xffffff, ink: 0x0f2a3f,
    fog: 0xd4f3ff, fogStart: 320, fogEnd: 1700,
    grade: { saturation: 1.12, contrast: 1.05, vignette: 0.26, lift: 0.0 },
    ground: { grass: 0x6cc24a, grass2: 0x55a83e, dirt: 0xc9a46a, rock: 0x9aa0a8, rock2: 0x7d8590, rock3: 0xb0b6be, snow: 0xffffff, sand: 0xf5dfa5, sidewalk: 0xe8dcc0 },
    road: { asphalt: 0x4a4f63, asphalt2: 0x42465a, line: 0xf6f6f0, lineYellow: 0xffd23f, curbA: 0xe8383d, curbB: 0xf6f6f0, runoff: 0x8fcf62, wall: 0xd8d4cc, wallStripe: 0xe8383d, rail: 0xc9ced8 },
    water: { deep: 0x0b76a6, mid: 0x14aac6, light: 0x6fe3e0, foam: 0xffffff, spec: 0xffffff },
    props: {
      trunk: 0xa0703f, leaf: [0x3fae5a, 0x56c26a, 0x2f9a50], building: [0xffffff, 0xf5e6b8, 0xa8d0e6],
      window: 0x3d5f94, windowLit: 0xffe9a0, roof: 0xe8584a, lamp: 0x3b3f52, lampLight: 0xfff1b0,
      neon: [0xff4fa8, 0x3ff0ff], buoyA: 0xff5a36, buoyB: 0xffffff, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0xffffff, towerB: 0xe8383d, banner: 0xff4538, bannerAlt: 0xffd23f,
    },
  },
  canyon: {
    id: 'canyon', night: false,
    sky: { top: 0x3a7fd0, horizon: 0xffd9a8, bottom: 0xffe8c8, sun: 0xfff2d0, cloud: 0xfff2e8, cloudShade: 0xd8a898 },
    sunDir: [0.3, 0.78, 0.52], sunColor: 0xfff0d8, sunIntensity: 1.05,
    shadeTint: 0x7a4f8e, rim: 0xffe8c8, ink: 0x2a1010,
    fog: 0xf5c9a0, fogStart: 220, fogEnd: 1300,
    grade: { saturation: 1.1, contrast: 1.07, vignette: 0.3, lift: 0.0 },
    ground: { grass: 0x9aa84a, grass2: 0x7f8f3e, dirt: 0xc98a5a, rock: 0xd9744a, rock2: 0xb85a3a, rock3: 0xf0a060, snow: 0xfff4ea, sand: 0xe8c088, sidewalk: 0xd8b890 },
    road: { asphalt: 0x4a4f63, asphalt2: 0x42465a, line: 0xf6f6f0, lineYellow: 0xffd23f, curbA: 0xe8383d, curbB: 0xf6f6f0, runoff: 0x8fcf62, wall: 0xd8d4cc, wallStripe: 0xe8383d, rail: 0xc9ced8 },
    water: { deep: 0x1c6f68, mid: 0x2aa08a, light: 0x7fd8b8, foam: 0xfff8f0, spec: 0xffffff },
    props: {
      trunk: 0x7a5038, leaf: [0x6f8f3e, 0x8aa84a], building: [0xe8c8a0],
      window: 0x4a3f6a, windowLit: 0xffe0a0, roof: 0x8a4f4f, lamp: 0x3b3f52, lampLight: 0xfff1b0,
      neon: [0xff6fa8], buoyA: 0xffd23f, buoyB: 0x2a2a3a, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0xfff4ea, towerB: 0x2f8dff, banner: 0x2f8dff, bannerAlt: 0xffd23f,
    },
  },
  storm: {
    id: 'storm', night: false,
    sky: { top: 0x252d42, horizon: 0x66768a, bottom: 0x7d8da0, sun: 0xd8e0ff, cloud: 0x5a6478, cloudShade: 0x363f55 },
    sunDir: [-0.4, 0.55, -0.6], sunColor: 0xc8d4f0, sunIntensity: 0.9,
    shadeTint: 0x3f4a72, rim: 0xd8f0ff, ink: 0x080c14,
    fog: 0x52607a, fogStart: 130, fogEnd: 950,
    grade: { saturation: 1.05, contrast: 1.14, vignette: 0.42, lift: 0.01 },
    ground: { grass: 0x4f6a4a, grass2: 0x3f5a3f, dirt: 0x5a5048, rock: 0x5a5f6a, rock2: 0x464a55, rock3: 0x6a707c, snow: 0xe8f0ff, sand: 0x8a8270, sidewalk: 0x6a6a70 },
    road: { asphalt: 0x3a3d4f, asphalt2: 0x333646, line: 0xe8f0ff, lineYellow: 0xffd23f, curbA: 0xe8383d, curbB: 0xe8f0ff, runoff: 0x4f6a4a, wall: 0x6a6e7a, wallStripe: 0xffd23f, rail: 0x9aa0b0 },
    water: { deep: 0x0d2433, mid: 0x1b4556, light: 0x3f7f8c, foam: 0xeaf6ff, spec: 0xe8f4ff },
    props: {
      trunk: 0x4a3a30, leaf: [0x2f4a3a], building: [0x8a8e9a],
      window: 0x1a1f3a, windowLit: 0xffd873, roof: 0x3a3e4a, lamp: 0x3b3f52, lampLight: 0xffe7a0,
      neon: [0xffe14f], buoyA: 0xffd23f, buoyB: 0x1a1a24, rampA: 0xffcc33, rampB: 0x2b2b3a,
      towerA: 0xeaeef5, towerB: 0xd83a3a, banner: 0xffd23f, bannerAlt: 0xd83a3a,
    },
  },
};

export function theme(id: ThemeId): Theme {
  return THEMES[id];
}

export interface Livery { body: number; accent: number; dark: number; glass: number; stripe: number; hull: number; deck: number }

export const LIVERIES: Livery[] = [
  { body: 0xff4538, accent: 0xffd23f, dark: 0x24232f, glass: 0x1f2d52, stripe: 0xffffff, hull: 0xf8f8f4, deck: 0xe8dcc4 },
  { body: 0x2f8dff, accent: 0xffffff, dark: 0x1f2233, glass: 0x1a2440, stripe: 0xffd23f, hull: 0xf8f8f4, deck: 0xd8dce8 },
  { body: 0xffc72e, accent: 0x1f1f2a, dark: 0x26242c, glass: 0x22284a, stripe: 0xff4538, hull: 0xf8f8f4, deck: 0xe8dcc4 },
  { body: 0x9a5cff, accent: 0x5ff0c8, dark: 0x221f33, glass: 0x1c1f45, stripe: 0xffffff, hull: 0xf8f8f4, deck: 0xdcd4ec },
];

export const FX = {
  spark: [0x5fd4ff, 0xffa83f, 0xff4fd8],
  sparkWhite: 0xfff6d0,
  flame: 0xff7a2f,
  flameCore: 0xfff2a0,
  boostFlame: 0x5fd4ff,
  padBase: 0xff6a2a,
  padArrow: 0xffe14f,
  ring: 0xffe14f,
  smoke: 0xf2f2f6,
  dust: 0xd9b98a,
  spray: 0xffffff,
  skid: 0x1c1c26,
  ghost: 0x8fe8ff,
  burst: 0xfff6a0,
  tire: 0x23222b,
  rim: 0xd9dce6,
  metal: 0x9aa0b0,
  headlight: 0xfffbe0,
  taillight: 0xff2a3a,
  navGreen: 0x3fe07a,
  skin: 0xf2c4a0,
  suit: 0x2b2f45,
  checkerA: 0xffffff,
  checkerB: 0x1a1a24,
  lightning: 0xf0f6ff,
  rain: 0xc8dcff,
  /** two-tone manga impact frame (big hits, hard landings) */
  impactInk: 0x14121f,
  impactPaper: 0xfffaf0,
};

export const UI = {
  ink: 0x14121f,
  paper: 0xfffaf0,
  paperDim: 0xf1e9d8,
  accent: 0xff4538,
  accent2: 0xffd23f,
  blue: 0x2f8dff,
  dim: 0x6b6880,
  good: 0x3fcf6a,
  place: [0xffd23f, 0xd9dce6, 0xe0a060, 0x9aa0b0],
};

const cache = new Map<number, Color>();
/** sRGB hex -> linear Color (cached, do not mutate the returned object). */
export function col(hex: number): Color {
  let c = cache.get(hex);
  if (!c) {
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}
export function colNew(hex: number): Color {
  return new Color(hex);
}
export function css(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}
