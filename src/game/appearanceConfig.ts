export const PHOTO_BASE_SIZE = 72;
export const INJURY_KINDS = ["bruise", "scratch", "bandage"] as const;
export type InjuryKind = typeof INJURY_KINDS[number];
export interface AppearanceSettings {
  photoScale: number;
  injuryScale: Record<InjuryKind, number>;
}
export interface AppearanceChanges {
  photoScale?: number;
  injuryScale?: Partial<Record<InjuryKind, number>>;
}
export const APPEARANCE_LIMITS = {
  photoScale: { min: 0.5, max: 4, step: 0.1 },
  injuryScale: { min: 0.25, max: 4, step: 0.05 },
} as const;

export function defaultAppearanceSettings(): AppearanceSettings {
  return { photoScale: 2, injuryScale: { bruise: 1, scratch: 1, bandage: 1 } };
}

/** Visual tuning is independent of stage one's fixed physics configuration. */
export function updateAppearanceSettings(current: AppearanceSettings, changes: AppearanceChanges): AppearanceSettings {
  const clamp = (value: number | undefined, fallback: number, limits: { min: number; max: number }) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.max(limits.min, Math.min(limits.max, value));
  const injuryScale = { ...current.injuryScale };
  for (const kind of INJURY_KINDS)
    injuryScale[kind] = clamp(changes.injuryScale?.[kind], current.injuryScale[kind], APPEARANCE_LIMITS.injuryScale);
  return { photoScale: clamp(changes.photoScale, current.photoScale, APPEARANCE_LIMITS.photoScale), injuryScale };
}
