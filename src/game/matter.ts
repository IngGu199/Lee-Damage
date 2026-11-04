import Phaser from "phaser";

// Phaser 3.90 exposes CustomMain at runtime but omits this property from phaser.d.ts.
// Reuse its bundled Matter declarations rather than installing a second engine.
export const Matter = (
  Phaser.Physics.Matter as typeof Phaser.Physics.Matter & {
    Matter: typeof MatterJS;
  }
).Matter;
