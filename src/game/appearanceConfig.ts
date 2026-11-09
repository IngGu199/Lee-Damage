export const PHOTO_BASE_SIZE = 72;
export const INJURY_KINDS = ["bruise", "scratch", "bandage"] as const;
export type InjuryKind = typeof INJURY_KINDS[number];

/** User-confirmed stage-two visuals; independent of the fixed physics values. */
export const FIXED_APPEARANCE = Object.freeze({
  photoScale: 2,
  deformationScale: 1.8,
  injuryScale: Object.freeze({ bruise: 1.5, scratch: 1.5, bandage: 1.5 }),
});
