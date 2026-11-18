import { loadSettings } from "../weapons/WeaponConfig";
import { PhotoSession, type AppliedPhoto } from "./PhotoSession";
import { alphaTransform, recoverAlphaMask } from "./PhotoAlpha";
import { PHOTO_SIZE, renderPhoto, type PhotoMask } from "./PhotoTransform";
import { photoPieces } from "./PhotoGeometry";

import { DEFAULT_IMAGE_CONFIG, IMAGE_TARGETS, parseImageConfig, type ImageTarget } from "./ImageConfig";

export type DefaultPhotos = Record<ImageTarget, AppliedPhoto | null>;

async function loadPhoto(path: string, signal: AbortSignal): Promise<AppliedPhoto> {
  const url = `${import.meta.env.BASE_URL}${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const type = blob.type || (/\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg");
  const name = path.split("/").at(-1)!;
  const source = await PhotoSession.decode(new File([blob], name, { type }));
  if (signal.aborted) throw new Error("기본 이미지 불러오기를 취소했습니다.");
  const alphaMask = recoverAlphaMask(source), edit = alphaTransform(source);
  const mask: PhotoMask = alphaMask ?? { kind: "shape", points: [], closed: true, smooth: false,
    shape: [{ x: 0, y: 0 }, { x: PHOTO_SIZE, y: 0 }, { x: PHOTO_SIZE, y: PHOTO_SIZE }, { x: 0, y: PHOTO_SIZE }] };
  // Validate geometry now so a bad cutout only disables this target, not startup.
  photoPieces(mask, { x: source.width, y: source.height }, edit);
  return { source, name, libraryPath: path, faces: [], faceIndex: -1, edit, mask, alphaMask: alphaMask ?? undefined,
    frames: [renderPhoto(source, edit, mask)], landmarks: [] };
}

/** Defaults are packaged assets, independent of user-photo storage and face inference. */
export async function loadDefaultImages(signal: AbortSignal): Promise<DefaultPhotos> {
  const config = await loadSettings("config/images.json", DEFAULT_IMAGE_CONFIG, parseImageConfig, signal);
  const entries = await Promise.all(IMAGE_TARGETS.map(async target => {
    const path = config[target];
    try { return [target, path && !signal.aborted ? await loadPhoto(path, signal) : null] as const; }
    catch (error) {
      if (!signal.aborted) console.warn(`기본 이미지 ${target}: 기본 도형을 사용합니다.`, error);
      return [target, null] as const;
    }
  }));
  return Object.fromEntries(entries) as DefaultPhotos;
}
