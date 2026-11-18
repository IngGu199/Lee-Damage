import Phaser from "phaser";

// This supported bundled Matter option is missing from Phaser's declaration.
declare global {
  namespace MatterJS {
    interface IConstraintDefinition { angularStiffness?: number }
  }
}

// Phaser 3.90 exposes CustomMain at runtime but omits this property from phaser.d.ts.
// Reuse its bundled Matter declarations rather than installing a second engine.
export const Matter = (
  Phaser.Physics.Matter as typeof Phaser.Physics.Matter & {
    Matter: typeof MatterJS;
  }
).Matter;

/** Remove stale contacts for deleted bodies, including compound weapon children. */
export function forgetBodyContacts(world: Phaser.Physics.Matter.World, bodies: ReadonlySet<MatterJS.BodyType>) {
  const pairs = world.engine.pairs;
  const keep = (pair: { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }) =>
    ![pair.bodyA, pair.bodyB].some(body => bodies.has(body) || bodies.has(body.parent));
  for (const key of ["list", "collisionStart", "collisionActive", "collisionEnd"])
    pairs[key] = pairs[key].filter(keep);
  for (const [key, pair] of Object.entries(pairs.table))
    if (!keep(pair as { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType })) delete pairs.table[key];
}

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
