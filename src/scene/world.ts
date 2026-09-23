import type { DirectionalLight, Group, Mesh, Scene, Vector3, WebGLRenderer } from 'three';
import type { WakeMap } from '../fx/wake';
import type { WaterView } from '../render/water';
import type { CourseDef } from '../track/courses';
import type { Track } from '../track/track';
import type { Theme } from '../tuning/palette';
import type { SimEnv } from '../vehicles/vehicle';
import type { WaveField } from '../world/water';
import { buildBoatWorld } from './boatWorld';
import { buildCarWorld } from './carWorld';

export interface Pad {
  s: number;
  d: number;
  len: number;
  halfW: number;
  mesh: Mesh;
}

export interface World {
  def: CourseDef;
  theme: Theme;
  track: Track;
  env: SimEnv;
  scene: Scene;
  sky: Mesh;
  water: WaterView | null;
  field: WaveField | null;
  wake: WakeMap | null;
  pads: Pad[];
  gate: Group;
  /** focus = player, cam = camera position */
  update(dt: number, time: number, focus: Vector3, cam: Vector3): void;
  dispose(): void;
}

export function buildWorld(def: CourseDef, renderer: WebGLRenderer): World {
  return def.vehicle === 'car' ? buildCarWorld(def, renderer) : buildBoatWorld(def, renderer);
}

export function disposeScene(scene: Scene) {
  scene.traverse((o) => {
    // shadow maps are render targets owned by the light, not reachable through materials
    (o as DirectionalLight).shadow?.dispose();
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as { dispose?: () => void } | { dispose?: () => void }[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose?.());
    else mat?.dispose?.();
  });
}
