import Phaser from "phaser";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { photoPieces } from "../photo/PhotoGeometry";
import { PHOTO_SIZE, type PhotoMask } from "../photo/PhotoTransform";
import type { WeaponConfig, WeaponId } from "./WeaponConfig";
import { add, rotate, type Point } from "./geometry";

export type WeaponPhotoTarget = WeaponId | "bullet";
interface Frame { center: Point; size: number; points: Point[] }
export interface WeaponSkin extends Frame { texture: string; pieces: Point[][]; photo: AppliedPhoto }

export function weaponFrame(config: WeaponConfig, id: WeaponPhotoTarget): Frame {
  const d = config.weapons[id === "bullet" ? "gun" : id], s = d.shape;
  let points: Point[];
  if (id === "bullet") {
    const r = d.projectile.radius;
    points = [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }];
  } else if (id === "bat") points = [{ x: 0, y: -s.width / 2 }, { x: s.length, y: -s.width / 2 },
    { x: s.length, y: s.width / 2 }, { x: 0, y: s.width / 2 }];
  else if (id === "hammer") {
    const left = s.length - s.headWidth / 2, right = s.length + s.headWidth / 2;
    points = [{ x: 0, y: -s.width / 2 }, { x: left, y: -s.width / 2 }, { x: left, y: -s.headHeight / 2 },
      { x: right, y: -s.headHeight / 2 }, { x: right, y: s.headHeight / 2 }, { x: left, y: s.headHeight / 2 },
      { x: left, y: s.width / 2 }, { x: 0, y: s.width / 2 }];
  } else {
    const left = -s.length / 2, right = s.length / 2, grip = left + s.width * 0.65;
    points = [{ x: left, y: -s.width / 2 }, { x: right, y: -s.width / 2 }, { x: right, y: s.width / 2 },
      { x: grip, y: s.width / 2 }, { x: grip, y: s.width * 1.5 }, { x: left, y: s.width * 1.5 }];
  }
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  return { center, size: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 0.94, points };
}

/** One shared texture per kind; instance images and concave collision pieces stay bounded. */
export class WeaponSkins {
  private readonly skins = new Map<WeaponPhotoTarget, WeaponSkin>();
  private readonly images = new Map<string, Phaser.GameObjects.Image>();
  private readonly used = new Set<string>();
  constructor(private readonly scene: Phaser.Scene) {}
  get(id: WeaponPhotoTarget) { return this.skins.get(id); }
  mask(config: WeaponConfig, id: WeaponPhotoTarget): PhotoMask {
    if (id === "bullet") return { kind: "circle", points: [], closed: false, smooth: false };
    const frame = weaponFrame(config, id);
    return { kind: "shape", points: [], closed: false, smooth: false, shape: frame.points.map(p => ({
      x: PHOTO_SIZE * (0.5 + (p.x - frame.center.x) / frame.size),
      y: PHOTO_SIZE * (0.5 + (p.y - frame.center.y) / frame.size),
    })) };
  }
  apply(config: WeaponConfig, id: WeaponPhotoTarget, photo: AppliedPhoto | null) {
    let next: WeaponSkin | undefined;
    if (photo) {
      const frame = weaponFrame(config, id);
      const pixels = photo.frames[0].getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
      if (!pixels.some((alpha, i) => i % 4 === 3 && alpha >= 128)) throw new Error("사진의 보이는 영역이 없어요. 사진과 위치를 확인해 주세요.");
      const pieces = photoPieces(photo.mask, { x: photo.source.width, y: photo.source.height }, photo.edit)
        .map(piece => piece.map(p => ({ x: frame.center.x + (p.x / PHOTO_SIZE - 0.5) * frame.size,
          y: frame.center.y + (p.y / PHOTO_SIZE - 0.5) * frame.size })));
      const points = pieces.flat();
      const texture = `weapon-photo-${id}-${Phaser.Utils.String.UUID()}`;
      this.scene.textures.addCanvas(texture, photo.frames[0]);
      next = { ...frame, points, pieces, texture, photo };
    }
    this.resetImages();
    const old = this.skins.get(id); if (old) this.scene.textures.remove(old.texture);
    if (next) this.skins.set(id, next); else this.skins.delete(id);
  }
  beginRender() { this.used.clear(); }
  draw(key: string, id: WeaponPhotoTarget, origin: Point, angle: number) {
    const skin = this.skins.get(id); if (!skin) return false;
    let image = this.images.get(key);
    if (!image) { image = this.scene.add.image(0, 0, skin.texture).setDepth(51); this.images.set(key, image); }
    const center = add(origin, rotate(skin.center, angle));
    image.setTexture(skin.texture).setPosition(center.x, center.y).setRotation(angle).setDisplaySize(skin.size, skin.size);
    this.used.add(key); return true;
  }
  endRender() {
    for (const [key, image] of this.images) if (!this.used.has(key)) { image.destroy(); this.images.delete(key); }
  }
  snapshot() { return { kinds: [...this.skins.keys()], images: this.images.size,
    pieces: Object.fromEntries([...this.skins].map(([id, skin]) => [id, skin.pieces.length])) }; }
  resetImages() { for (const image of this.images.values()) image.destroy(); this.images.clear(); }
  destroy() {
    this.resetImages(); for (const skin of this.skins.values()) this.scene.textures.remove(skin.texture); this.skins.clear();
  }
}
