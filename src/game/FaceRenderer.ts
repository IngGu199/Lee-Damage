import Phaser from "phaser";
import { PHOTO_SIZE } from "../photo/PhotoTransform";
import type { Part } from "./Ragdoll";

/** One GPU texture; precomputed frames stay in CPU memory until selected. */
export class FaceRenderer {
  private texture?: Phaser.Textures.CanvasTexture;
  private image?: Phaser.GameObjects.Image;
  private frames: HTMLCanvasElement[] = [];
  variantIndex = 0;

  constructor(private readonly scene: Phaser.Scene) {}
  get active() { return this.frames.length > 0; }
  get frameCount() { return this.frames.length; }

  apply(frames: HTMLCanvasElement[]) {
    if (!frames.length) return this.clear();
    if (!this.texture) {
      this.texture = this.scene.textures.createCanvas("user-face", PHOTO_SIZE, PHOTO_SIZE)!;
      this.image = this.scene.add.image(0, 0, "user-face").setOrigin(0.5).setDisplaySize(72, 72).setDepth(10);
    }
    this.frames = frames;
    this.variantIndex = -1;
    this.showVariant(0);
  }

  showVariant(index: number) {
    if (!this.texture || !this.frames.length) return;
    index = Math.max(0, Math.min(index, this.frames.length - 1));
    if (this.variantIndex === index) return;
    this.variantIndex = index;
    const ctx = this.texture.getContext();
    ctx.clearRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.drawImage(this.frames[index], 0, 0);
    this.texture.refresh();
  }

  update(head: Part) {
    this.image?.setPosition(head.body.position.x, head.body.position.y).setRotation(head.body.angle);
  }

  snapshot() {
    return { active: this.active, frames: this.frameCount, variant: this.variantIndex,
      x: this.image?.x ?? null, y: this.image?.y ?? null, rotation: this.image?.rotation ?? null };
  }

  clear() {
    this.frames = []; this.variantIndex = 0;
    this.image?.destroy(); this.image = undefined;
    if (this.texture) this.scene.textures.remove(this.texture.key);
    this.texture = undefined;
  }
}
