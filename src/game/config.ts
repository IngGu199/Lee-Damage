export const ROOM = {
  width: 1200,
  height: 700,
  left: 30,
  right: 1170,
  top: 42,
  bottom: 650,
};
export const FIXED_STEP = 1000 / 120;
export const MAX_SPEED = 24;
export const STANDING_OFFSET_Y = 124;
export type PostureState = "standing" | "active" | "waiting" | "recovering";
export type Tool = "grab" | "push";
export interface LabSettings {
  gravity: number;
  bounce: number;
  strength: number;
  debug: boolean;
  idleSeconds: number;
  lag: number;
}
export interface LabStats {
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
}
export const DEFAULT_SETTINGS: LabSettings = {
  gravity: 1,
  bounce: 0.55,
  strength: 1,
  debug: false,
  idleSeconds: 3,
  lag: 0.65,
};
