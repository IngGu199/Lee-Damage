import Phaser from "phaser";
import { Matter } from "./matter";
import type { Ragdoll } from "./Ragdoll";
import type { PointerController } from "./PointerController";
import { ROOM } from "./config";

export function drawRoom(scene: Phaser.Scene, g = scene.add.graphics().setDepth(-10)) {
  const width = ROOM.right - ROOM.left, height = ROOM.bottom - ROOM.top;
  g.clear();
  g.fillStyle(0xeceee8).fillRoundedRect(ROOM.left - 16, ROOM.top - 16, width + 32, height + 38, 18);
  g.fillStyle(0xf8f9f4).fillRect(ROOM.left, ROOM.top, width, height);
  g.lineStyle(1, 0xe6e9df);
  for (let x = 60; x < ROOM.right; x += 40)
    g.lineBetween(x, ROOM.top, x, ROOM.bottom);
  for (let y = 50; y < ROOM.bottom; y += 40)
    g.lineBetween(ROOM.left, y, ROOM.right, y);
  g.lineStyle(2, 0xcfd5c6).strokeRect(ROOM.left, ROOM.top, width, height);
  g.fillStyle(0xd8ddce).fillRect(ROOM.left, ROOM.bottom, width, 8);
  for (let x = 40; x < ROOM.right; x += 18) {
    g.lineStyle(2, 0xc4cdb9).lineBetween(x, ROOM.bottom + 10, x - 8, ROOM.bottom + 20);
  }
  return g;
}

export function drawDoll(
  g: Phaser.GameObjects.Graphics,
  doll: Ragdoll,
  input: PointerController,
  debug: boolean,
  photoActive = false,
  overlay?: Phaser.GameObjects.Graphics,
  hideHead = false,
) {
  const { Vector } = Matter;
  g.clear();
  overlay?.clear();
  const debugGraphics = overlay ?? g;
  const torso = doll.parts[1].body.position;
  const shadowWidth = 80 + Math.max(0, ROOM.bottom - 50 - torso.y) * 0.12;
  g.fillStyle(0x4b583c, 0.09).fillEllipse(torso.x, ROOM.bottom - 7, shadowWidth, 12);
  for (const joint of doll.joints) {
    const a = Vector.add(joint.bodyA!.position, joint.pointA),
      b = Vector.add(joint.bodyB!.position, joint.pointB);
    g.lineStyle(13, 0x475248).lineBetween(a.x, a.y, b.x, b.y);
  }
  // Torso and head render over the limbs.
  for (const part of [...doll.parts.slice(2), doll.parts[1], doll.parts[0]]) {
    const { body } = part;
    g.fillStyle(part.color);
    g.lineStyle(2.5, 0x3c4943);
    if (part.radius) {
      if (!hideHead) {
        g.fillCircle(body.position.x, body.position.y, part.radius);
        g.strokeCircle(body.position.x, body.position.y, part.radius);
      }
      const local = (x: number, y: number) =>
        Vector.add(body.position, Vector.rotate({ x, y }, body.angle));
      if (!photoActive) {
        for (const x of [-12, 12]) {
          const eye = local(x, -4);
          g.fillStyle(0x3c4943).fillCircle(eye.x, eye.y, 3);
        }
        const a = local(-8, 12),
          b = local(0, 15),
          c = local(8, 12);
        g.lineStyle(2, 0x3c4943)
          .lineBetween(a.x, a.y, b.x, b.y)
          .lineBetween(b.x, b.y, c.x, c.y);
      }
    } else {
      // Inset the visual outline inside the collision polygon, so contact never overlays outlines.
      const insetScale = 1 - 3 / Math.min(part.width, part.height);
      const outline = body.vertices!.map((vertex) => ({
        x: body.position.x + (vertex.x - body.position.x) * insetScale,
        y: body.position.y + (vertex.y - body.position.y) * insetScale,
      }));
      g.fillPoints(outline, true).strokePoints(outline, true);
    }
    if (debug) {
      debugGraphics.lineStyle(1, 0xe98360).strokePoints(body.vertices!, true);
      debugGraphics.fillStyle(0xe98360).fillCircle(body.position.x, body.position.y, 3);
      const end = Vector.add(body.position, Vector.mult(body.velocity, 4));
      debugGraphics.lineBetween(body.position.x, body.position.y, end.x, end.y);
    }
  }
  if (debug)
    for (const joint of doll.joints) {
      const a = Vector.add(joint.bodyA!.position, joint.pointA),
        b = Vector.add(joint.bodyB!.position, joint.pointB);
      debugGraphics.lineStyle(2, 0xe98360).lineBetween(a.x, a.y, b.x, b.y);
      debugGraphics.fillStyle(0xe98360).fillCircle(a.x, a.y, 4).fillCircle(b.x, b.y, 4);
    }
  if (input.grip && input.owner === doll) {
    const grip = input.grip;
    const point = Vector.add(grip.bodyB!.position, grip.pointB);
    debugGraphics.lineStyle(2, 0x7d9650, 0.7).lineBetween(
      point.x,
      point.y,
      grip.pointA.x,
      grip.pointA.y,
    );
    debugGraphics.lineStyle(2, 0x4c6330).strokeCircle(point.x, point.y, 9);
    debugGraphics.fillStyle(0x4c6330).fillCircle(grip.pointA.x, grip.pointA.y, 4);
  }
}
