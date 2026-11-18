import { loadSettings } from "../weapons/WeaponConfig";
import { PhotoSession, type AppliedPhoto, type PhotoDraft } from "./PhotoSession";
import { FaceAnalyzer } from "./FaceAnalyzer";
import { preparePhoto } from "./preparePhoto";
import { alphaTransform, recoverAlphaMask } from "./PhotoAlpha";
import { PHOTO_SIZE, type PhotoMask } from "./PhotoTransform";
import { photoPieces } from "./PhotoGeometry";

import { DEFAULT_IMAGE_CONFIG, IMAGE_TARGETS, parseImageConfig, type ImageTarget } from "./ImageConfig";

export type DefaultPhotos = Record<ImageTarget, AppliedPhoto | null>;

async function loadPhoto(path: string, signal: AbortSignal, target: ImageTarget): Promise<AppliedPhoto> {
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
  const draft: PhotoDraft = { source, name, libraryPath: path, preserveFraming: true,
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
  return preparePhoto(draft, () => signal.aborted, target === "face");
}

/** Packaged faces gain landmarks/variants without auto-fitting; weapons only restore their outlines. */
export async function loadDefaultImages(signal: AbortSignal): Promise<DefaultPhotos> {
  const config = await loadSettings("config/images.json", DEFAULT_IMAGE_CONFIG, parseImageConfig, signal);
  const entries = await Promise.all(IMAGE_TARGETS.map(async target => {
    const path = config[target];
    try { return [target, path && !signal.aborted ? await loadPhoto(path, signal, target) : null] as const; }
    catch (error) {
      if (!signal.aborted) console.warn(`기본 이미지 ${target}: 기본 도형을 사용합니다.`, error);
      return [target, null] as const;
    }
  }));
  return Object.fromEntries(entries) as DefaultPhotos;
}
