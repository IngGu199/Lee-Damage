export const ROOM = {
  width: 1200,
  height: 700,
  left: 30,
  right: 1170,
  top: 42,
  bottom: 650,
};
export const FIXED_STEP = 1000 / 120;
export const REFERENCE_STEP = 1000 / 60;
export const MAX_TRAVEL_PER_SUBSTEP = 6;
export const MAX_SUBSTEPS = 64;
export const STANDING_OFFSET_Y = 124;
export const REST_SPEED = 12; // px/s, includes rotational motion at each part's edge
export const REST_CONFIRM_MS = 300;
export const REST_OBSERVATION_MS = 200;
export const TORSO_ALIGNMENT_MS = 600;
export type PhysicsExperiment = 1 | 2;
export type PostureState =
  | "standing"
  | "active"
  | "untangling"
  | "waiting"
  | "recovering";
export type Tool = "grab" | "push";
export interface LabSettings {
  experiment: PhysicsExperiment;
  gravity: number;
  bounce: number;
  strength: number;
  debug: boolean;
  idleSeconds: number;
  repairSeconds: number;
  throwScale: number;
  lag: number;
}
export interface LabStats {
  experiment: PhysicsExperiment;
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
export const DEFAULT_SETTINGS: LabSettings = {
  experiment: 2,
  gravity: 1,
  bounce: 0.55,
  strength: 1,
  debug: false,
  idleSeconds: 3,
  repairSeconds: 1.5,
  throwScale: 0.35,
  lag: 0.65,
};
