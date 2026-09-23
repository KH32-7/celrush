import { clamp, moveToward } from './math';

/** What a driver (human or AI) feeds into a vehicle. Steer +1 = right. */
export interface Controls {
  steer: number;
  throttle: number;
  brake: number;
  drift: boolean;
  /** air/pitch control, +1 = nose up */
  pitch: number;
}

export const emptyControls = (): Controls => ({ steer: 0, throttle: 0, brake: 0, drift: false, pitch: 0 });

type Edge = 'pause' | 'respawn' | 'camera' | 'confirm' | 'back' | 'up' | 'down' | 'left' | 'right' | 'tuning';

export class Input {
  private keys = new Set<string>();
  private edges = new Set<Edge>();
  private steerKb = 0;
  autoThrottle = false;
  private padPrev: boolean[] = [];
  private stickPrev: Edge | null = null;
  private stickEdges = new Set<Edge>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      const map: Record<string, Edge> = {
        Escape: 'pause', KeyP: 'pause', KeyR: 'respawn', KeyC: 'camera', Enter: 'confirm',
        Backspace: 'back', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', F2: 'tuning',
        // WASD + Space drive the menus too (e.code is the physical key, so Korean IME mode does not matter)
        KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', Space: 'confirm',
      };
      const ed = map[e.code];
      if (ed) this.edges.add(ed);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F2'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  consume(edge: Edge): boolean {
    const had = this.edges.has(edge);
    this.edges.delete(edge);
    return had;
  }

  clearEdges() {
    this.edges.clear();
  }

  private down(...codes: string[]) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Turns gamepad button presses into edges. Called every frame (menus too), not only while driving. */
  pollPad() {
    const p = this.pad();
    if (!p) return;
    const edgesMap: [number, Edge][] = [[9, 'pause'], [3, 'respawn'], [8, 'camera'], [0, 'confirm'], [1, 'back'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
    for (const [i, ed] of edgesMap) {
      const pressed = !!p.buttons[i]?.pressed;
      if (pressed && !this.padPrev[i]) this.edges.add(ed);
      this.padPrev[i] = pressed;
    }
    // left stick drives the menus as well, with hysteresis so one push = one step
    const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
    const dir: Edge | null = ay < -0.6 ? 'up' : ay > 0.6 ? 'down' : ax < -0.6 ? 'left' : ax > 0.6 ? 'right' : null;
    if (dir && dir !== this.stickPrev) this.stickEdges.add(dir);
    if (Math.abs(ax) < 0.35 && Math.abs(ay) < 0.35) this.stickPrev = null;
    else if (dir) this.stickPrev = dir;
  }

  /** Stick edges only mean something in menus (in a race the stick steers). */
  consumeStick(edge: Edge): boolean {
    const had = this.stickEdges.has(edge);
    this.stickEdges.delete(edge);
    return had;
  }

  /** Polls keyboard + first gamepad into a Controls value. Keyboard steer is ramped so taps feel analog. */
  read(dt: number, out: Controls): Controls {
    const left = this.down('ArrowLeft', 'KeyA');
    const right = this.down('ArrowRight', 'KeyD');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    // faster return to center than build-up: counter-steer must be quick
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerKb) ? 9 : 4.5;
    this.steerKb = moveToward(this.steerKb, target, rate * dt);

    let steer = this.steerKb;
    let throttle = this.down('ArrowUp', 'KeyW') || this.autoThrottle ? 1 : 0;
    let brake = this.down('ArrowDown', 'KeyS') ? 1 : 0;
    let drift = this.down('Space', 'ShiftLeft', 'ShiftRight');
    // air pitch: S/Down lifts the nose. W is held for throttle anyway, so it only gives a mild nose-down bias
    let pitch = (this.down('ArrowDown', 'KeyS') ? 1 : 0) - (this.down('ArrowUp', 'KeyW') ? 0.35 : 0);

    const p = this.pad();
    if (p) {
      const ax = p.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = clamp(Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) ** 1.3, -1, 1);
      const rt = p.buttons[7]?.value ?? 0;
      const lt = p.buttons[6]?.value ?? 0;
      throttle = Math.max(throttle, rt, p.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, lt, p.buttons[2]?.pressed ? 1 : 0);
      drift = drift || !!p.buttons[5]?.pressed || !!p.buttons[1]?.pressed || !!p.buttons[4]?.pressed;
      const ay = p.axes[1] ?? 0;
      if (Math.abs(ay) > 0.2) pitch = -ay;
    }
    this.pollPad();
    out.steer = steer;
    out.throttle = throttle;
    out.brake = brake;
    out.drift = drift;
    out.pitch = pitch;
    return out;
  }
}
