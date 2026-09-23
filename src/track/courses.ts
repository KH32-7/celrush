import type { ThemeId } from '../tuning/palette';
import type { P3 } from './spline';

export type VehicleKind = 'car' | 'boat';

/**
 * A course is data only: a centerline spline plus profiles. All geometry is generated from this.
 * Positions along the lap (pads, ramps, surfaces) are fractions 0..1 of lap length.
 */
export interface CourseDef {
  id: string;
  name: string;
  tagline: string;
  vehicle: VehicleKind;
  theme: ThemeId;
  scale: number;
  /** control points [x, elevation, z] in scaled units (elevation is NOT scaled) */
  pts: P3[];
  halfWidth: number;
  curb: number;
  runoff: number;
  bankScale: number;
  maxBank: number;
  laps: number;
  seed: number;
  pads: [number, number][];
  ramps?: [number, number][];
  dirt?: [number, number][];
  waves?: string;
  current?: number;
  rocks?: number;
}

export const COURSES: CourseDef[] = [
  // ---------------- car ----------------
  {
    id: 'harbor', name: '하버 시티', tagline: '운하 다리를 넘는 항구 시가지 서킷', vehicle: 'car', theme: 'city',
    scale: 7.6,
    pts: [
      [0, 0, 40], [0, 0, 24], [0, 0, 15], [0, 3.6, 10], [0, 0, 5], [0, 0, -8], [0, 0, -20], [7, 0, -37], [26, 0, -45],
      [48, 0, -38], [57, 0, -18], [48, 0, -2], [36, 0, 10], [38, 0, 24], [52, 0, 36], [46, 0, 52], [26, 0, 58], [8, 0, 52],
    ],
    halfWidth: 7.5, curb: 1.1, runoff: 3.2, bankScale: 5, maxBank: 0.09, laps: 3, seed: 11,
    pads: [[0.3, -3], [0.55, 3], [0.8, 0]],
  },
  {
    id: 'alpine', name: '알파인 패스', tagline: '석양 속 고갯길, 급커브와 내리막', vehicle: 'car', theme: 'mountain',
    scale: 6.3,
    pts: [
      [0, 2, 0], [0, 6, -26], [10, 12, -48], [30, 18, -55], [44, 22, -43], [40, 25, -25], [24, 28, -17], [16, 30, -1],
      [26, 32, 13], [44, 30, 17], [58, 24, 7], [66, 16, -11], [78, 12, -22], [88, 14, -6], [85, 18, 16], [70, 20, 34],
      [48, 16, 44], [26, 10, 42], [10, 5, 27],
    ],
    halfWidth: 7, curb: 1.0, runoff: 5, bankScale: 7, maxBank: 0.14, laps: 3, seed: 23,
    pads: [[0.12, 0], [0.47, -2], [0.72, 2]],
    dirt: [[0, 1]],
  },
  {
    id: 'neon', name: '네온 하이웨이', tagline: '야간 고가도로, 길게 뻗은 고속 스위퍼', vehicle: 'car', theme: 'night',
    scale: 7.6,
    pts: [
      [0, 0, 0], [0, 0, -20], [0, 0, -40], [6, 0, -62], [24, 3, -70], [46, 7, -64], [60, 8, -46], [62, 6, -30], [60, 7.5, -22],
      [58, 3, -12], [54, 0, -4], [58, 0, 12], [72, 3, 22], [76, 0, 42], [62, 0, 58], [38, 0, 60], [20, 0, 48], [12, 0, 26], [4, 0, 12],
    ],
    halfWidth: 8, curb: 1.0, runoff: 3.5, bankScale: 6, maxBank: 0.12, laps: 3, seed: 37,
    pads: [[0.18, 0], [0.42, 3], [0.62, -3], [0.9, 0]],
  },
  // ---------------- boat ----------------
  {
    id: 'emerald', name: '에메랄드 베이', tagline: '섬 사이를 누비는 맑은 만, 점프대 둘', vehicle: 'boat', theme: 'bay',
    scale: 6,
    pts: [
      [0, 0, 0], [0, 0, -30], [12, 0, -50], [36, 0, -56], [56, 0, -42], [54, 0, -18], [38, 0, -6], [36, 0, 12],
      [52, 0, 26], [48, 0, 48], [24, 0, 56], [6, 0, 42], [0, 0, 20],
    ],
    halfWidth: 19, curb: 0, runoff: 7, bankScale: 0, maxBank: 0, laps: 3, seed: 51,
    pads: [[0.16, 0], [0.5, -6], [0.86, 5]],
    ramps: [[0.3, 4], [0.66, -5]],
    waves: 'bay',
  },
  {
    id: 'redcanyon', name: '레드 캐니언', tagline: '붉은 협곡을 따라 흐르는 급류', vehicle: 'boat', theme: 'canyon',
    scale: 5.8,
    pts: [
      [0, 0, 0], [0, 0, -24], [-8, 0, -44], [2, 0, -62], [22, 0, -69], [36, 0, -56], [31, 0, -38], [40, 0, -22],
      [58, 0, -24], [71, 0, -10], [65, 0, 10], [47, 0, 18], [41, 0, 36], [22, 0, 45], [8, 0, 35], [4, 0, 16],
    ],
    halfWidth: 15, curb: 0, runoff: 2.5, bankScale: 0, maxBank: 0, laps: 3, seed: 67,
    pads: [[0.1, 0], [0.38, 4], [0.7, -4]],
    ramps: [[0.55, 0]],
    waves: 'canyon', current: 3.2, rocks: 10,
  },
  {
    id: 'stormstrait', name: '스톰 해협', tagline: '집채만 한 너울 위의 폭풍우 레이스', vehicle: 'boat', theme: 'storm',
    scale: 7.2,
    pts: [
      [0, 0, 0], [0, 0, -30], [16, 0, -52], [42, 0, -57], [60, 0, -38], [56, 0, -12], [63, 0, 12], [48, 0, 34],
      [22, 0, 40], [6, 0, 26],
    ],
    halfWidth: 24, curb: 0, runoff: 8, bankScale: 0, maxBank: 0, laps: 3, seed: 83,
    pads: [[0.22, 0], [0.58, 6], [0.83, -6]],
    waves: 'storm',
  },
];

export function coursesFor(kind: VehicleKind) {
  return COURSES.filter((c) => c.vehicle === kind);
}

export function courseById(id: string) {
  const c = COURSES.find((c) => c.id === id);
  if (!c) throw new Error('unknown course ' + id);
  return c;
}
