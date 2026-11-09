import { canvasOf, PHOTO_SIZE, type Point } from "./PhotoTransform";
import { FIXED_APPEARANCE } from "../game/appearanceConfig";

interface FaceBend {
  center: Point;
  axis: Point;
  down: Point;
  span: number;
}

// MediaPipe lip corners, right eye corners, left eye corners.
const CORNER_PAIRS = [[61, 291], [33, 133], [362, 263]] as const;
const finitePoint = (point: Point | undefined): point is Point =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

/** Midpoints are fixed control points, also shown by the editor's landmark overlay. */
export function faceBendControls(landmarks: Point[]): FaceBend[] {
  const top = landmarks[10], chin = landmarks[152];
  const faceDown = finitePoint(top) && finitePoint(chin)
    ? { x: chin.x - top.x, y: chin.y - top.y } : { x: 0, y: 1 };
  return CORNER_PAIRS.flatMap(([first, last]) => {
    const a = landmarks[first], b = landmarks[last];
    if (!finitePoint(a) || !finitePoint(b)) return [];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span < 2) return [];
    const axis = { x: (b.x - a.x) / span, y: (b.y - a.y) / span };
    const down = { x: -axis.y, y: axis.x };
    if (down.x * faceDown.x + down.y * faceDown.y < 0) { down.x *= -1; down.y *= -1; }
    return [{ center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, axis, down, span }];
  });
}

/** Inverse sampling of a local bend: center stays still, both ends move toward the chin. */
function unbend(x: number, y: number, bend: FaceBend, strength: number): Point {
  const dx = x - bend.center.x, dy = y - bend.center.y;
  const u = (dx * bend.axis.x + dy * bend.axis.y) / (bend.span / 2);
  const v = dx * bend.down.x + dy * bend.down.y;
  const radius = bend.span * 0.8;
  const t = Math.abs(u);
  if (t >= 1.8 || Math.abs(v) >= radius) return { x, y };
  const smooth = (value: number) => value * value * (3 - 2 * value);
  const weight = t <= 1 ? smooth(t) : 1 - smooth((t - 1) / 0.8);
  const amount = bend.span * 0.14 * strength * weight;
  if (!amount) return { x, y };
  // Smooth compact falloff, monotone even at the fixed stage-two strength.
  // Invert the forward bend with a bounded search to avoid folds and empty pixels.
  let low = Math.max(-radius, v - amount), high = v;
  for (let step = 0; step < 12; step++) {
    const middle = (low + high) / 2, falloff = 1 - (middle / radius) ** 2;
    if (middle + amount * falloff * falloff < v) low = middle;
    else high = middle;
  }
  const sourceV = (low + high) / 2;
  return { x: x + bend.down.x * (sourceV - v), y: y + bend.down.y * (sourceV - v) };
}

/** Inverse sampling retains a fixed canvas/mask. Every variant starts from the original. */
export async function makeVariants(
  original: HTMLCanvasElement, landmarks: Point[], cancelled: () => boolean, mask: HTMLCanvasElement,
): Promise<HTMLCanvasElement[]> {
  const bends = faceBendControls(landmarks).reverse();
  if (!bends.length) return [];
  const source = original.getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  const variants: HTMLCanvasElement[] = [];
  const maskPixels = mask.getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
  for (const strength of [1, 1.7]) {
    const output = canvasOf(PHOTO_SIZE), ctx = output.getContext("2d")!;
    const pixels = ctx.createImageData(PHOTO_SIZE, PHOTO_SIZE);
    for (let y = 0; y < PHOTO_SIZE; y++) {
      if (y % 48 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (cancelled()) return [];
      }
      for (let x = 0; x < PHOTO_SIZE; x++) {
        if (!maskPixels[(y * PHOTO_SIZE + x) * 4 + 3]) continue;
        let sx = x, sy = y;
        for (const bend of bends) {
          const sample = unbend(sx, sy, bend, strength * FIXED_APPEARANCE.deformationScale);
          sx = sample.x; sy = sample.y;
        }
        sx = Math.max(0, Math.min(PHOTO_SIZE - 1.001, sx));
        sy = Math.max(0, Math.min(PHOTO_SIZE - 1.001, sy));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        const a = (y0 * PHOTO_SIZE + x0) * 4, b = a + 4;
        const c = a + PHOTO_SIZE * 4, d = c + 4;
        const target = (y * PHOTO_SIZE + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          pixels.data[target + channel] =
            source.data[a + channel] * (1 - fx) * (1 - fy) + source.data[b + channel] * fx * (1 - fy) +
            source.data[c + channel] * (1 - fx) * fy + source.data[d + channel] * fx * fy;
        }
      }
    }
    ctx.putImageData(pixels, 0, 0);
    // Use the same circular or custom silhouette for every frame.
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    variants.push(output);
  }
  return variants;
}
