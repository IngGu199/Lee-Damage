import { canvasOf, PHOTO_SIZE, type Point } from "./PhotoTransform";

interface Deformation extends Point { dx: number; dy: number; radius: number }

/** Inverse sampling retains a fixed canvas/mask. Every variant starts from the original. */
export async function makeVariants(
  original: HTMLCanvasElement, landmarks: Point[], cancelled: () => boolean, mask: HTMLCanvasElement,
): Promise<HTMLCanvasElement[]> {
  if (!landmarks[1] || !landmarks[61] || !landmarks[291]) return [];
  const source = original.getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  const variants: HTMLCanvasElement[] = [];
  const maskPixels = mask.getContext("2d")!.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
  for (const strength of [1, 1.7]) {
    const deformations: Deformation[] = [
      { ...landmarks[1], dx: 12 * strength, dy: 5 * strength, radius: 88 },
      { ...landmarks[61], dx: -8 * strength, dy: 9 * strength, radius: 65 },
      { ...landmarks[291], dx: 5 * strength, dy: -8 * strength, radius: 65 },
    ];
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
        for (const point of deformations) {
          const d = Math.hypot(x - point.x, y - point.y) / point.radius;
          const weight = d < 1 ? (1 - d * d) ** 2 : 0;
          sx -= point.dx * weight; sy -= point.dy * weight;
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
