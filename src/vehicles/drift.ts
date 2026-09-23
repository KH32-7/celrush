import type { Controls } from '../core/input';
import { DRIFT_STAGES } from '../tuning/params';

export const enum DriftEvent {
  None = 0,
  Start = 1,
  StageUp = 2,
  Boost = 4,
  Cancel = 8,
}

export interface DriftMetrics {
  speed: number;
  /** signed slip angle: + = nose rotated right of the velocity */
  slip: number;
  grounded: boolean;
  minSpeed: number;
}

/**
 * Shared drift -> charge -> boost state machine. Car and boat differ only in how
 * they physically hold the slide; the reward rules live here so both feel the same.
 */
export class DriftState {
  active = false;
  dir = 0;
  charge = 0;
  stage = 0;
  boostTime = 0;
  boostMax = 1;
  /** time since drift entered, for FX ramp */
  time = 0;
  private slowT = 0;
  lastStage = 0;

  update(dt: number, c: Controls, m: DriftMetrics): number {
    let ev = DriftEvent.None;
    if (this.boostTime > 0) this.boostTime = Math.max(0, this.boostTime - dt);
    if (!this.active) {
      // button may be held before steering; the drift starts the moment both are true
      if (c.drift && m.grounded && m.speed > m.minSpeed && Math.abs(c.steer) > 0.25) {
        this.active = true;
        this.dir = Math.sign(c.steer);
        this.charge = 0;
        this.stage = 0;
        this.time = 0;
        this.slowT = 0;
        ev |= DriftEvent.Start;
      }
      return ev;
    }

    this.time += dt;
    if (m.grounded && Math.abs(m.slip) > DRIFT_STAGES.minSlip) {
      // steering into the drift charges faster than holding it wide
      const into = c.steer * this.dir;
      this.charge += dt * (1 + 0.25 * Math.max(0, into));
    }
    const t = DRIFT_STAGES.chargeTimes;
    const newStage = this.charge >= t[2] ? 3 : this.charge >= t[1] ? 2 : this.charge >= t[0] ? 1 : 0;
    if (newStage > this.stage) {
      this.stage = newStage;
      ev |= DriftEvent.StageUp;
    }
    if (m.speed < m.minSpeed * 0.55) this.slowT += dt;
    else this.slowT = 0;

    if (!c.drift) {
      ev |= this.release();
    } else if (this.slowT > 0.35) {
      this.cancel();
      ev |= DriftEvent.Cancel;
    }
    return ev;
  }

  release(): number {
    if (!this.active) return DriftEvent.None;
    this.active = false;
    this.lastStage = this.stage;
    const st = this.stage;
    this.stage = 0;
    this.charge = 0;
    if (st > 0) {
      this.giveBoost(DRIFT_STAGES.boostTimes[st - 1]);
      return DriftEvent.Boost;
    }
    return DriftEvent.None;
  }

  cancel() {
    this.active = false;
    this.stage = 0;
    this.charge = 0;
  }

  giveBoost(duration: number) {
    if (this.boostTime < duration) {
      this.boostTime = duration;
      this.boostMax = duration;
    }
  }

  get boosting() {
    return this.boostTime > 0;
  }

  /** 0..1 progress to next stage (HUD) */
  get chargeFrac() {
    const t = DRIFT_STAGES.chargeTimes;
    if (this.stage >= 3) return 1;
    const lo = this.stage === 0 ? 0 : t[this.stage - 1];
    return (this.charge - lo) / (t[this.stage] - lo);
  }
}
