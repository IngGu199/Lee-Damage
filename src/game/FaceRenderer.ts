import Phaser from "phaser";
import { PHOTO_SIZE, type Point } from "../photo/PhotoTransform";
import type { Part } from "./Ragdoll";
import { PHOTO_BASE_SIZE, FIXED_APPEARANCE } from "./appearanceConfig";

/** One GPU texture; precomputed frames stay in CPU memory until selected. */
export class FaceRenderer {
  private texture?: Phaser.Textures.CanvasTexture;
  private image?: Phaser.GameObjects.Image;
  private frames: HTMLCanvasElement[] = [];
  private injuryPixels?: Uint32Array;
  variantIndex = 0;
  customOutline = false;

  constructor(private readonly scene: Phaser.Scene, private readonly textureKey = "user-face") {}
  get preparedFrames() { return this.frames; }
  get active() { return this.frames.length > 0; }
  get frameCount() { return this.frames.length; }
  get displaySize() { return PHOTO_BASE_SIZE * FIXED_APPEARANCE.photoScale; }

  photoToLocal(point: Point): Point {
    return { x: (point.x - 0.5) * this.displaySize, y: (point.y - 0.5) * this.displaySize };
  }

  apply(frames: HTMLCanvasElement[], customOutline = false) {
    if (!frames.length) return this.clear();
    if (!this.texture) {
      this.texture = this.scene.textures.createCanvas(this.textureKey, PHOTO_SIZE, PHOTO_SIZE)!;
      this.image = this.scene.add.image(0, 0, this.textureKey).setOrigin(0.5)
        .setDisplaySize(this.displaySize, this.displaySize).setDepth(10);
    }
    this.frames = frames;
    this.injuryPixels = undefined;
    this.customOutline = customOutline;
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

  setAlpha(alpha: number) { this.image?.setAlpha(alpha).setVisible(alpha > 0); }

  update(head: Part) {
    this.image?.setPosition(head.body.position.x, head.body.position.y).setRotation(head.body.angle);
  }

  /** Uniform visible-pixel sampling, including the edge; asset size never excludes locations. */
  randomInjuryPoint(): Point | null {
    if (!this.frames.length) return null;
    if (!this.injuryPixels) {
      const alpha = this.frames[0].getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
      const pixels: number[] = [];
      for (let index = 0; index < PHOTO_SIZE * PHOTO_SIZE; index++)
        if (alpha[index * 4 + 3] >= 128) pixels.push(index);
      this.injuryPixels = Uint32Array.from(pixels);
    }
    if (!this.injuryPixels.length) return null;
    const pixel = this.injuryPixels[Math.floor(Math.random() * this.injuryPixels.length)];
    return { x: (pixel % PHOTO_SIZE + 0.5) / PHOTO_SIZE, y: (Math.floor(pixel / PHOTO_SIZE) + 0.5) / PHOTO_SIZE };
  }

  snapshot() {
    return { active: this.active, frames: this.frameCount, variant: this.variantIndex, customOutline: this.customOutline,
      photoScale: FIXED_APPEARANCE.photoScale, width: this.image?.displayWidth ?? null, height: this.image?.displayHeight ?? null,
      x: this.image?.x ?? null, y: this.image?.y ?? null, rotation: this.image?.rotation ?? null };
  }

  clear() {
    this.frames = []; this.variantIndex = 0; this.customOutline = false;
    this.injuryPixels = undefined;
    this.image?.destroy(); this.image = undefined;
    if (this.texture) this.scene.textures.remove(this.texture.key);
    this.texture = undefined;
  }
}
