import Phaser from "phaser";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { photoOutlineVertexCount, photoPieces } from "../photo/PhotoGeometry";
import { PHOTO_SIZE, type PhotoMask } from "../photo/PhotoTransform";
import type { WeaponConfig } from "./WeaponConfig";
import { PROJECTILE_WEAPON_ID, weaponRegistration } from "./WeaponRegistry";
import type { WeaponPhotoTarget } from "./WeaponTypes";
export type { WeaponPhotoTarget } from "./WeaponTypes";
import { add, rotate, type Point } from "./geometry";

interface Frame { center: Point; size: number; points: Point[] }
/** Empty pieces keep the image visible while opting into the weapon's default collider. */
export interface WeaponSkin extends Frame { readonly target: WeaponPhotoTarget; texture: string; pieces: Point[][]; photo: AppliedPhoto }
const MAX_PHOTO_COLLISION_VERTICES = 10;

export function weaponFrame(config: WeaponConfig, id: WeaponPhotoTarget): Frame {
  let points: Point[];
  if (id === "bullet" || id === "bomber") {
    const r = id === "bullet" ? config.weapons[PROJECTILE_WEAPON_ID].projectile.radius : config.bomb.bomberSize / 2;
    points = [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }];
  } else points = weaponRegistration(id).behavior.frame(config.weapons[id]);
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  return { center, size: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 0.94, points };
}

/** Instances share a skin and keep it alive after the selection changes. */
export class WeaponSkins {
  private readonly skins = new Map<WeaponPhotoTarget, WeaponSkin>();
  private bulletSkins: WeaponSkin[] = [];
  private readonly retiredSkins = new Set<WeaponSkin>();
  private readonly drawnSkins = new Set<WeaponSkin>();
  private readonly images = new Map<string, Phaser.GameObjects.Image>();
  private readonly used = new Set<string>();
  constructor(private readonly scene: Phaser.Scene) {}
  get(id: WeaponPhotoTarget) { return id === "bullet" ? this.bulletSkins[0] : this.skins.get(id); }
  bulletPhotos() { return this.bulletSkins.map(skin => skin.photo); }
  chooseBulletSkin() {
    return this.bulletSkins.length <= 1 ? this.bulletSkins[0]
      : this.bulletSkins[Math.floor(Math.random() * this.bulletSkins.length)];
  }
  mask(config: WeaponConfig, id: WeaponPhotoTarget): PhotoMask {
    if (id === "bullet" || id === "bomb") return { kind: "circle", points: [], closed: false, smooth: false };
    const frame = weaponFrame(config, id);
    return { kind: "shape", points: [], closed: false, smooth: false, shape: frame.points.map(p => ({
      x: PHOTO_SIZE * (0.5 + (p.x - frame.center.x) / frame.size),
      y: PHOTO_SIZE * (0.5 + (p.y - frame.center.y) / frame.size),
    })) };
  }
  apply(config: WeaponConfig, id: WeaponPhotoTarget, photo: AppliedPhoto | null) {
    if (id === "bullet") { this.applyBulletPhotos(config, photo ? [photo] : []); return; }
    const old = this.skins.get(id);
    if ((old?.photo ?? null) === photo) return;
    const next = photo ? [...this.retiredSkins].find(skin => skin.target === id && skin.photo === photo)
      ?? this.createSkin(config, id, photo) : undefined;
    if (old) this.retiredSkins.add(old);
    if (next) {
      this.retiredSkins.delete(next);
      this.skins.set(id, next);
    } else this.skins.delete(id);
  }
  applyBulletPhotos(config: WeaponConfig, photos: readonly AppliedPhoto[]) {
    const reusable = new Map<AppliedPhoto, WeaponSkin>();
    for (const skin of this.retiredSkins) if (skin.target === "bullet") reusable.set(skin.photo, skin);
    for (const skin of this.bulletSkins) reusable.set(skin.photo, skin);
    const next: WeaponSkin[] = [];
    const created: WeaponSkin[] = [];
    try {
      for (const photo of photos) {
        try {
          let skin = reusable.get(photo);
          if (!skin) {
            skin = this.createSkin(config, "bullet", photo);
            created.push(skin);
            reusable.set(photo, skin);
          }
          next.push(skin);
        }
        catch (error) { throw new Error(`${photo.name} · ${error instanceof Error ? error.message : "사진을 적용하지 못했어요."}`); }
      }
    } catch (error) {
      for (const skin of created) this.scene.textures.remove(skin.texture);
      throw error;
    }
    for (const skin of this.bulletSkins) this.retiredSkins.add(skin);
    for (const skin of next) this.retiredSkins.delete(skin);
    this.bulletSkins = next;
  }
  private createSkin(config: WeaponConfig, id: WeaponPhotoTarget, photo: AppliedPhoto): WeaponSkin {
    const frame = weaponFrame(config, id);
    const pixels = photo.frames[0].getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
    if (!pixels.some((alpha, i) => i % 4 === 3 && alpha >= 128)) throw new Error("사진의 보이는 영역이 없어요. 사진과 위치를 확인해 주세요.");
    const source = { x: photo.source.width, y: photo.source.height };
    const usePhotoOutline = id !== "bomber" && photoOutlineVertexCount(photo.mask, source, photo.edit) <= MAX_PHOTO_COLLISION_VERTICES;
    const pieces = usePhotoOutline ? photoPieces(photo.mask, source, photo.edit).map(piece => piece.map(p => ({
      x: frame.center.x + (p.x / PHOTO_SIZE - 0.5) * frame.size,
      y: frame.center.y + (p.y / PHOTO_SIZE - 0.5) * frame.size,
    }))) : [];
    const points = pieces.flat();
    const texture = `weapon-photo-${id}-${Phaser.Utils.String.UUID()}`;
    this.scene.textures.addCanvas(texture, photo.frames[0]);
    return { ...frame, target: id, points, pieces, texture, photo };
  }
  /** Scale the existing outline and texture placement without re-uploading image pixels. */
  resize(config: WeaponConfig, id: WeaponPhotoTarget) {
    const skin = this.skins.get(id), frame = weaponFrame(config, id);
    const variants = id === "bullet" ? [...this.bulletSkins] : skin ? [skin] : [];
    for (const retired of this.retiredSkins) if (retired.target === id) variants.push(retired);
    for (const variant of variants) {
      const ratio = frame.size / variant.size;
      const pieces = variant.pieces.map(piece => piece.map(point => ({
        x: frame.center.x + (point.x - variant.center.x) * ratio,
        y: frame.center.y + (point.y - variant.center.y) * ratio,
      })));
      Object.assign(variant, frame, { pieces, points: pieces.flat() });
    }
  }
  beginRender() { this.used.clear(); this.drawnSkins.clear(); }
  draw(key: string, skin: WeaponSkin | undefined, origin: Point, angle: number) {
    if (!skin) return false;
    let image = this.images.get(key);
    if (!image) { image = this.scene.add.image(0, 0, skin.texture).setDepth(51); this.images.set(key, image); }
    const center = add(origin, rotate(skin.center, angle));
    image.setTexture(skin.texture).setPosition(center.x, center.y).setRotation(angle).setDisplaySize(skin.size, skin.size);
    this.used.add(key);
    this.drawnSkins.add(skin);
    return true;
  }
  endRender() {
    for (const [key, image] of this.images) if (!this.used.has(key)) { image.destroy(); this.images.delete(key); }
    this.releaseRetiredSkins(this.drawnSkins);
  }
  releaseRetiredSkins(stillUsed?: ReadonlySet<WeaponSkin>) {
    for (const skin of this.retiredSkins) {
      if (stillUsed?.has(skin)) continue;
      this.scene.textures.remove(skin.texture);
      this.retiredSkins.delete(skin);
    }
  }
  snapshot() {
    const entries = [...this.skins];
    const bullet = this.bulletSkins[0];
    if (bullet) entries.push(["bullet", bullet]);
    return { kinds: entries.map(([id]) => id), images: this.images.size,
      pieces: Object.fromEntries(entries.map(([id, skin]) => [id, skin.pieces.length])) };
  }
  resetImages() {
    for (const image of this.images.values()) image.destroy();
    this.images.clear();
    this.beginRender();
  }
  destroy() {
    this.resetImages();
    for (const skin of [...this.skins.values(), ...this.bulletSkins, ...this.retiredSkins]) this.scene.textures.remove(skin.texture);
    this.skins.clear(); this.bulletSkins = []; this.retiredSkins.clear(); this.drawnSkins.clear();
  }
}
