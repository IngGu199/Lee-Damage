import { loadSettings } from "../weapons/WeaponConfig";
import { PhotoSession, type AppliedPhoto, type PhotoDraft } from "./PhotoSession";
import { FaceAnalyzer } from "./FaceAnalyzer";
import { preparePhoto } from "./preparePhoto";
import { alphaTransform, recoverAlphaMask } from "./PhotoAlpha";
import { PHOTO_SIZE, type PhotoMask } from "./PhotoTransform";
import { photoPieces } from "./PhotoGeometry";
import { savedPhotoUrl } from "./PhotoLibrary";

import { DEFAULT_IMAGE_CONFIG, IMAGE_TARGETS, parseImageConfig, type ImageTarget, type SingleImageTarget } from "./ImageConfig";

export type DefaultPhotos = Record<SingleImageTarget, AppliedPhoto | null> & { bullet: AppliedPhoto[] };
export function emptyDefaultPhotos(): DefaultPhotos {
  return { ...Object.fromEntries(IMAGE_TARGETS.map(target => [target, null])), bullet: [] } as DefaultPhotos;
}

async function loadPhoto(path: string, signal: AbortSignal, target: ImageTarget): Promise<AppliedPhoto> {
  const response = await fetch(savedPhotoUrl(path), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const type = blob.type || (/\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg");
  const name = path.split("/").at(-1)!;
  return prepareStoredPhoto(new File([blob], name, { type }), path, target, signal);
}

/** Preserve the saved crop and scale for both configured defaults and one-click selection. */
export async function prepareStoredPhoto(file: File, path: string, target: ImageTarget, signal: AbortSignal): Promise<AppliedPhoto> {
  const source = await PhotoSession.decode(file);
  if (signal.aborted) throw new Error("기본 이미지 불러오기를 취소했습니다.");
  const alphaMask = recoverAlphaMask(source), edit = alphaTransform(source);
  const mask: PhotoMask = alphaMask ?? { kind: "shape", points: [], closed: true, smooth: false,
    shape: [{ x: 0, y: 0 }, { x: PHOTO_SIZE, y: 0 }, { x: PHOTO_SIZE, y: PHOTO_SIZE }, { x: 0, y: PHOTO_SIZE }] };
  // Validate geometry now so a bad cutout only disables this target, not startup.
  photoPieces(mask, { x: source.width, y: source.height }, edit);
  const draft: PhotoDraft = { source, name: file.name, libraryPath: path, preserveFraming: true,
    faces: [], faceIndex: -1, edit, mask, alphaMask: alphaMask ?? undefined };
  if (target === "face") {
    const analyzer = new FaceAnalyzer();
    try {
      draft.faces = await analyzer.detect(source, () => signal.aborted);
      draft.faceIndex = draft.faces.length === 1 ? 0 : -1;
    } catch (error) {
      if (!signal.aborted) console.warn("기본 얼굴의 기준점을 검출하지 못했어요. 사진은 그대로 사용합니다.", error);
    } finally { analyzer.destroy(); }
  }
  if (signal.aborted) throw new Error("기본 이미지 불러오기를 취소했습니다.");
  const photo = await preparePhoto(draft, () => signal.aborted, target === "face");
  if (target === "bullet") {
    const pixels = photo.frames[0].getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
    if (!pixels.some((value, index) => index % 4 === 3 && value >= 128)) throw new Error("사진의 보이는 영역이 없어요.");
  }
  return photo;
}

/** Packaged faces gain landmarks/variants without auto-fitting; weapons only restore their outlines. */
export async function loadDefaultImages(signal: AbortSignal): Promise<DefaultPhotos> {
  const config = await loadSettings("config/images.json", DEFAULT_IMAGE_CONFIG, parseImageConfig, signal);
  const photos = emptyDefaultPhotos();
  const load = async (path: string, target: ImageTarget) => {
    try { return signal.aborted ? null : await loadPhoto(path, signal, target); }
    catch (error) {
      if (!signal.aborted) console.warn(`기본 이미지 ${target}: ${path} 불러오기 실패`, error);
      return null;
    }
  };
  await Promise.all(IMAGE_TARGETS.map(async target => {
    if (target === "bullet") {
      const paths = Array.isArray(config.bullet) ? config.bullet : config.bullet ? [config.bullet] : [];
      for (const path of paths) {
        const photo = await load(path, target);
        if (photo) photos.bullet.push(photo);
      }
    } else {
      const path = config[target];
      if (path) photos[target] = await load(path, target);
    }
  }));
  return photos;
}
