import Phaser from "phaser";
import type { Ragdoll, Part } from "./Ragdoll";
import type { Injury } from "./ImpactAppearance";

export class InjuryRenderer {
  private readonly entries: { injury: Injury; image: Phaser.GameObjects.Image }[] = [];
  constructor(private readonly scene: Phaser.Scene) {}

  add(injury: Injury, part: Part) {
    // Keep the small test asset within the limb/head instead of changing physics.
    const size = part.radius ? 17 : Math.min(22, part.width * 0.58);
    if (part.radius) {
      const distance = Math.hypot(injury.local.x, injury.local.y);
      const limit = part.radius - size / 2 - 2;
      if (distance > limit) {
        injury.local.x *= limit / distance; injury.local.y *= limit / distance;
      }
    } else {
      injury.local.x = Phaser.Math.Clamp(injury.local.x, -part.width / 2 + size / 2 + 1, part.width / 2 - size / 2 - 1);
      injury.local.y = Phaser.Math.Clamp(injury.local.y, -part.height / 2 + size / 2 + 1, part.height / 2 - size / 2 - 1);
    }
    const image = this.scene.add.image(0, 0, `injury-${injury.kind}`).setDisplaySize(size, size).setDepth(20);
    this.entries.push({ injury, image });
  }

  update(doll: Ragdoll, injuries: readonly Injury[]) {
    while (this.entries.length && !injuries.includes(this.entries[0].injury)) this.entries.shift()!.image.destroy();
    for (const { injury, image } of this.entries) {
      const body = doll.parts[injury.part].body;
      const c = Math.cos(body.angle), s = Math.sin(body.angle);
      image.setPosition(body.position.x + injury.local.x * c - injury.local.y * s,
        body.position.y + injury.local.x * s + injury.local.y * c).setRotation(body.angle + injury.angle);
    }
  }

  clear() { for (const entry of this.entries) entry.image.destroy(); this.entries.length = 0; }
}
