import type { AppliedPhoto, PhotoDraft } from "./PhotoSession";
import { renderMask, renderPhoto, transformPoint } from "./PhotoTransform";
import { makeVariants } from "./PhotoVariants";

/** Derive landmarks and damage frames without changing the source framing or mask. */
export async function preparePhoto(draft: PhotoDraft, cancelled: () => boolean, deform = true): Promise<AppliedPhoto> {
  const sourceSize = { x: draft.source.width, y: draft.source.height };
  const landmarks = (draft.faces[draft.faceIndex] ?? []).map(point => transformPoint(point, sourceSize, draft.edit));
  const frame = renderPhoto(draft.source, draft.edit, draft.mask);
  let variants: HTMLCanvasElement[] = [];
  try {
    if (deform && landmarks.length && !cancelled()) variants = await makeVariants(
      renderPhoto(draft.source, draft.edit, false), landmarks, cancelled,
      renderMask(draft.mask, sourceSize, draft.edit));
  } catch { /* Preserve the original photo and landmarks if deformation fails. */ }
  return { ...draft, frames: [frame, ...variants], landmarks };
}
