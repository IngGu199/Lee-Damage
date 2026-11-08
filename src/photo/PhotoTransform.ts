export interface Point { x: number; y: number }
export interface PhotoTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flip: boolean;
}

export const PHOTO_SIZE = 512;
export const MASK_RADIUS = 0.47;

export function canvasOf(width: number, height = width) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** All edit coordinates are in the square output, independent of CSS size. */
export function transformPoint(point: Point, source: Point, edit: PhotoTransform): Point {
  const x = (point.x - source.x / 2) * edit.scale * (edit.flip ? -1 : 1);
  const y = (point.y - source.y / 2) * edit.scale;
  const c = Math.cos(edit.rotation), s = Math.sin(edit.rotation);
  return { x: PHOTO_SIZE / 2 + edit.x + x * c - y * s,
    y: PHOTO_SIZE / 2 + edit.y + x * s + y * c };
}

export function defaultTransform(width: number, height: number): PhotoTransform {
  return { x: 0, y: 0, scale: PHOTO_SIZE / Math.min(width, height), rotation: 0, flip: false };
}

export function fitFace(points: Point[], width: number, height: number): PhotoTransform {
  const edit = defaultTransform(width, height);
  const left = points[33], right = points[263], top = points[10], chin = points[152];
  if (!left || !right || !top || !chin) return edit;
  edit.rotation = -Math.atan2(right.y - left.y, right.x - left.x);
  edit.scale = PHOTO_SIZE * 0.82 / Math.max(1, Math.hypot(chin.x - top.x, chin.y - top.y));
  const center = { x: (top.x + chin.x) / 2, y: (top.y + chin.y) / 2 };
  const mapped = transformPoint(center, { x: width, y: height }, edit);
  edit.x = PHOTO_SIZE / 2 - mapped.x;
  edit.y = PHOTO_SIZE / 2 - mapped.y;
  return edit;
}

export function renderPhoto(source: HTMLCanvasElement, edit: PhotoTransform, masked = true) {
  const output = canvasOf(PHOTO_SIZE);
  const ctx = output.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (masked) {
    ctx.beginPath();
    ctx.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, PHOTO_SIZE * MASK_RADIUS, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.translate(PHOTO_SIZE / 2 + edit.x, PHOTO_SIZE / 2 + edit.y);
  ctx.rotate(edit.rotation);
  ctx.scale(edit.scale * (edit.flip ? -1 : 1), edit.scale);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return output;
}
