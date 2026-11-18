export const ROOM = {
  width: 1600,
  height: 800,
  left: 30,
  right: 1570,
  top: 42,
  bottom: 750,
};
export const FIXED_STEP = 1000 / 120;
export const REFERENCE_STEP = 1000 / 60;
export const MAX_TRAVEL_PER_SUBSTEP = 6;
export const MAX_SUBSTEPS = 64;
export const STANDING_OFFSET_Y = 124;
export const REST_SPEED = 12; // px/s, includes rotational motion at each part's edge
export const STANDING_SPEED = 50; // px/s, maximum linear speed among all body parts
export const REST_CONFIRM_MS = 300;
export const REST_OBSERVATION_MS = 200;
export const TORSO_ALIGNMENT_MS = 600;
export const ANGULAR_INERTIA_SCALE = 0.65;
export const JOINT_DAMPING = 0.025;
export const MAX_ANGULAR_SPEED = 0.7; // radians per 60Hz reference step
export type PostureState =
  | "standing"
  | "active"
  | "untangling"
  | "waiting"
  | "recovering";
export interface LabSettings {
  gravity: number;
  bounce: number;
  debug: boolean;
  idleSeconds: number;
  repairSeconds: number;
  throwScale: number;
}
export interface LabStats {
  aliveCount: number;
  debrisCount: number;
  maxRagdolls: number;
  selectedId: number;
  actors: { id: number; hp: number; maxHp: number; state: import("./RagdollLifecycle").LifeState }[];
  lifeId: number;
  lifeState: import("./RagdollLifecycle").LifeState;
  hp: number;
  maxHp: number;
  lostHp: number;
  simulationTime: number;
  spawnProtected: boolean;
  alignmentRemaining: number | null;
  fps: number;
  speed: number;
  bodies: number;
  joints: number;
  grabbed: string | null;
  paused: boolean;
  recoveries: number;
  maxJointGap: number;
  maxOverlap: number;
  posture: PostureState;
  idleRemaining: number;
  selfCollision: boolean;
}
export const FIXED_SETTINGS = Object.freeze({
  bounce: 0.95,
  gravity: 2.5,
  idleSeconds: 2,
  repairSeconds: 2,
  throwScale: 0.5,
});
export const DEFAULT_SETTINGS: LabSettings = {
  ...FIXED_SETTINGS,
  debug: false,
};
