/**
 * Fixed-step simulation + variable render.
 * Physics always advances in exact STEP increments; render gets alpha in [0,1)
 * to interpolate between the last two physics states.
 */
export const STEP = 1 / 120;

export class FixedLoop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  running = false;
  timeScale = 1;

  constructor(
    private update: (dt: number) => void,
    private render: (alpha: number, frameDt: number) => void,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      let frameDt = (now - this.last) / 1000;
      this.last = now;
      if (frameDt > 0.1) frameDt = 0.1; // tab switch / hitch: never spiral
      this.acc += frameDt * this.timeScale;
      let steps = 0;
      while (this.acc >= STEP && steps < 12) {
        this.update(STEP);
        this.acc -= STEP;
        steps++;
      }
      if (steps === 12) this.acc = 0;
      this.render(this.acc / STEP, frameDt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
