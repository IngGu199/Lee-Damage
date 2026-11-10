import { DAMAGE_RULES } from "./damageConfig";

export type LifeState = "alive" | "spawning" | "dying" | "bursting" | "respawnWait";

/** All deadlines use the scene's fixed simulation clock, including pause and photo editing. */
export class RagdollLifecycle {
  state: LifeState = "alive";
  lifeId = 1;
  private since = 0;
  private protectedUntil = 0;
  get interactive() { return this.state === "alive" || this.state === "spawning"; }
  get visible() { return this.state !== "respawnWait"; }
  alpha(time: number) {
    return this.state === "respawnWait" ? 0 : this.state === "bursting"
      ? Math.max(0, 1 - (time - this.since) / DAMAGE_RULES.burstMs) : 1;
  }
  kill(lifeId: number) {
    if (lifeId !== this.lifeId || !this.interactive) return false;
    this.state = "dying"; return true;
  }
  burst(time: number) { this.state = "bursting"; this.since = time; }
  burstFinished(time: number) { return this.state === "bursting" && time - this.since >= DAMAGE_RULES.burstMs; }
  wait(time: number) { this.state = "respawnWait"; this.since = time; }
  readyToSpawn(time: number) { return this.state === "respawnWait" && time - this.since >= DAMAGE_RULES.respawnWaitMs; }
  spawn(time: number, airborne: boolean) {
    this.lifeId++;
    this.state = airborne ? "spawning" : "alive";
    this.since = time;
    this.protectedUntil = airborne ? time + DAMAGE_RULES.spawnProtectionMs : 0;
  }
  landed(time: number) {
    if (this.state === "spawning")
      this.protectedUntil = Math.min(this.protectedUntil, time + DAMAGE_RULES.landingProtectionMs);
  }
  interact() { if (this.state === "spawning") this.state = "alive"; }
  update(time: number) { if (this.state === "spawning" && time >= this.protectedUntil) this.state = "alive"; }
  protected(time: number) { return this.state === "spawning" && time < this.protectedUntil; }
}
