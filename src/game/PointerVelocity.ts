import { REFERENCE_STEP } from "./config";

/** Pointer timestamps, not JS handler duration, define the final throw vector. */
export class PointerVelocity {
  private previous: { x: number; y: number; time: number } | null = null;
  private latest: { x: number; y: number; time: number } | null = null;

  reset(point: MatterJS.Vector, time: number) {
    this.previous = null;
    this.latest = { ...point, time };
  }

  record(point: MatterJS.Vector, time: number) {
    if (!this.latest) {
      this.reset(point, time);
      return;
    }
    if (time <= this.latest.time) return;
    this.previous = this.latest;
    this.latest = { ...point, time };
  }

  at(time: number): MatterJS.Vector {
    if (!this.previous || !this.latest || time - this.latest.time > 80)
      return { x: 0, y: 0 };
    const elapsed = this.latest.time - this.previous.time;
    if (elapsed <= 0 || elapsed > 80) return { x: 0, y: 0 };
    return {
      x: ((this.latest.x - this.previous.x) * REFERENCE_STEP) / elapsed,
      y: ((this.latest.y - this.previous.y) * REFERENCE_STEP) / elapsed,
    };
  }

  clear() {
    this.previous = this.latest = null;
  }
}
