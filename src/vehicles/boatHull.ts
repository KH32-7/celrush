import { BOAT } from '../tuning/params';

/**
 * Single source of the hull's shape. The physics samples it for buoyancy/pressure points and the
 * model lofts its visual mesh from it, so the painted waterline is where the boat actually floats.
 * Local frame: bow toward -Z, origin = center of mass.
 */
export interface HullStation {
  z: number;
  /** 0 at transom, 1 at bow */
  u: number;
  halfBeam: number;
  keelY: number;
  chineY: number;
  deckY: number;
}

/**
 * Outboard + driver sit aft: the center of mass lies well behind mid-length, like a real runabout.
 * The tapered, rockered bow puts the buoyancy centroid aft too; 0.75 balances the two (rest trim ~0).
 */
export const COM_AFT = 0.75;
export const HULL_BOW_Z = -BOAT.hullLength / 2 - COM_AFT;
export const HULL_STERN_Z = BOAT.hullLength / 2 - COM_AFT;

export function hullStation(u: number): HullStation {
  const z = HULL_STERN_Z + (HULL_BOW_Z - HULL_STERN_Z) * u;
  const hbMax = BOAT.beam / 2;
  const taper = u < 0.5 ? 0 : Math.pow((u - 0.5) / 0.5, 1.7);
  const halfBeam = hbMax * (1 - 0.9 * taper) * (u < 0.06 ? 0.94 + u : 1);
  const rise = u < 0.55 ? 0 : Math.pow((u - 0.55) / 0.45, 2);
  const keelY = -BOAT.keelDepth + 0.62 * rise;
  const chineY = -BOAT.chineDepth + 0.5 * Math.pow(Math.max(0, (u - 0.5) / 0.5), 1.5);
  const deckY = 0.34 + 0.16 * Math.pow(Math.max(0, (u - 0.6) / 0.4), 1.5);
  return { z, u, halfBeam, keelY: Math.min(keelY, chineY - 0.02), chineY, deckY };
}
