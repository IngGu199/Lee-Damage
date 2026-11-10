/** Stage-three starting values; physics and the approved appearance scales stay separate. */
export const DAMAGE_RULES = Object.freeze({
  maxHp: 1000,
  minSpeed: 220,
  referenceSpeed: 600,
  referenceDamage: 20,
  maxCollisionDamage: 180,
  impactBatchMs: 60,
  injuryInterval: 40,
  burstMs: 300,
  respawnWaitMs: 300,
  spawnOffsetY: -180,
  spawnProtectionMs: 1500,
  landingProtectionMs: 150,
});
