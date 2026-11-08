import { canvasOf, type PhotoTransform, type Point, type PhotoMask } from "./PhotoTransform";

export interface PhotoDraft {
  source: HTMLCanvasElement;
  name: string;
  faces: Point[][];
  faceIndex: number;
  edit: PhotoTransform;
  mask: PhotoMask;
}
export interface AppliedPhoto extends PhotoDraft {
  frames: HTMLCanvasElement[];
  landmarks: Point[];
}

export const PHOTO_LIMITS = { bytes: 20 * 1024 * 1024, pixels: 40_000_000, edge: 4096 };

/** No storage API: all user images belong to the current document only. */
export class PhotoSession {
  current: AppliedPhoto | null = null;

  static async decode(file: File): Promise<HTMLCanvasElement> {
    if (!file.size || file.size > PHOTO_LIMITS.bytes)
      throw new Error("20MB 이하의 사진을 선택해 주세요.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("JPEG, PNG, WebP 사진을 선택해 주세요.");
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch { throw new Error("사진을 읽지 못했어요. 다른 사진을 선택해 주세요."); }
    try {
      if (bitmap.width * bitmap.height > PHOTO_LIMITS.pixels)
        throw new Error("4천만 화소 이하로 줄인 사진을 선택해 주세요.");
      const ratio = Math.min(1, PHOTO_LIMITS.edge / Math.max(bitmap.width, bitmap.height));
      const source = canvasOf(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
      const ctx = source.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, source.width, source.height);
      return source;
    } finally { bitmap.close(); }
  }

  clear() { this.current = null; }
}
