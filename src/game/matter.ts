import Phaser from "phaser";

// Phaser 3.90 exposes CustomMain at runtime but omits this property from phaser.d.ts.
// Reuse its bundled Matter declarations rather than installing a second engine.
export const Matter = (
  Phaser.Physics.Matter as typeof Phaser.Physics.Matter & {
    Matter: typeof MatterJS;
  }
).Matter;

// Bundled Collision.collides is static at runtime; Phaser's declaration lists it as an instance method.
export const Collision = Matter.Collision as unknown as {
  collides(
    a: MatterJS.BodyType,
    b: MatterJS.BodyType,
    pairs: null,
  ): {
    bodyA: MatterJS.BodyType;
    bodyB: MatterJS.BodyType;
    normal: MatterJS.Vector;
    depth: number;
  } | null;
};
