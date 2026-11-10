import Phaser from "phaser";
import type { Ragdoll, Part } from "./Ragdoll";
import type { Injury } from "./ImpactAppearance";
import type { FaceRenderer } from "./FaceRenderer";
import type { Point } from "../photo/PhotoTransform";
import { FIXED_APPEARANCE } from "./appearanceConfig";

export class InjuryRenderer {
  private readonly entries: { injury: Injury; image: Phaser.GameObjects.Image }[] = [];
  constructor(private readonly scene: Phaser.Scene, private readonly face: FaceRenderer) {}

  add(injury: Injury, part: Part, randomize = true) {
    // Collision speed decides whether to show an injury; its contact point does not place it.
    const size = part.radius ? 17 : Math.min(22, part.width * 0.58);
    if (!randomize) {
      // Existing marks keep their local coordinates during a physics-only recovery.
    } else if (part.radius && this.face.active) {
      const point = this.face.randomInjuryPoint();
      if (!point) return;
      injury.photoPoint = point; injury.local = this.face.photoToLocal(point);
    } else if (part.radius) {
      const angle = Math.random() * Math.PI * 2, distance = Math.sqrt(Math.random()) * part.radius;
      injury.local = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
    } else {
      injury.local = this.randomLimbPoint(part);
    }
    const image = this.scene.add.image(0, 0, `injury-${injury.kind}`)
      .setDisplaySize(size * FIXED_APPEARANCE.injuryScale[injury.kind], size * FIXED_APPEARANCE.injuryScale[injury.kind]).setDepth(20);
    this.entries.push({ injury, image });
  }

  private randomLimbPoint(part: Part): Point {
    const c = Math.cos(part.body.angle), s = Math.sin(part.body.angle);
    const inset = 1 - 3 / Math.min(part.width, part.height);
    const outline = part.body.vertices!.map((v) => {
      const dx = v.x - part.body.position.x, dy = v.y - part.body.position.y;
      return { x: (dx * c + dy * s) * inset, y: (-dx * s + dy * c) * inset };
    });
    const first = outline[0];
    const areas = outline.slice(1, -1).map((a, index) => {
      const b = outline[index + 2];
      return Math.abs((a.x - first.x) * (b.y - first.y) - (a.y - first.y) * (b.x - first.x)) / 2;
    });
    const total = areas.reduce((sum, area) => sum + area, 0);
    if (!total) return { x: 0, y: 0 };
    let target = Math.random() * total;
    for (let index = 0; index < areas.length; index++) {
      if (target <= areas[index] || index === areas.length - 1) {
        const a = outline[index + 1], b = outline[index + 2];
        const r = Math.sqrt(Math.random()), t = Math.random();
        return { x: (1 - r) * first.x + r * (1 - t) * a.x + r * t * b.x,
          y: (1 - r) * first.y + r * (1 - t) * a.y + r * t * b.y };
      }
      target -= areas[index];
    }
    return { x: 0, y: 0 };
  }

  update(doll: Ragdoll, injuries: readonly Injury[], alpha = 1) {
    while (this.entries.length && !injuries.includes(this.entries[0].injury)) this.entries.shift()!.image.destroy();
    for (const { injury, image } of this.entries) {
      image.setAlpha(alpha).setVisible(alpha > 0);
      if (injury.photoPoint && this.face.active) injury.local = this.face.photoToLocal(injury.photoPoint);
      const body = doll.parts[injury.part].body;
      const c = Math.cos(body.angle), s = Math.sin(body.angle);
      image.setPosition(body.position.x + injury.local.x * c - injury.local.y * s,
        body.position.y + injury.local.x * s + injury.local.y * c).setRotation(body.angle + injury.angle);
    }
  }

  clear() { for (const entry of this.entries) entry.image.destroy(); this.entries.length = 0; }
}
