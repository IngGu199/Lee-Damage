export interface Point { x: number; y: number }
export interface PhotoTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flip: boolean;
}

/** Contour vertices live in source-image coordinates, so edits move image and mask together. */
export interface PhotoMask {
  kind: "circle" | "contour" | "shape" | "alpha";
  /** Recovered from image transparency; all coordinates belong to the source image. */
  alpha?: { outlines: Point[][]; pieces: Point[][] };
  shape?: Point[];
  points: Point[];
  closed: boolean;
  smooth: boolean;
}

export function defaultMask(): PhotoMask {
  return { kind: "circle", points: [], closed: false, smooth: false };
}

export function copyMask(mask: PhotoMask): PhotoMask {
  const copy = (points: Point[]) => points.map(point => ({ ...point }));
  return { ...mask, points: copy(mask.points), shape: mask.shape && copy(mask.shape),
    alpha: mask.alpha && { outlines: mask.alpha.outlines.map(copy), pieces: mask.alpha.pieces.map(copy) } };
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

export function inversePoint(point: Point, source: Point, edit: PhotoTransform): Point {
  const x = point.x - PHOTO_SIZE / 2 - edit.x, y = point.y - PHOTO_SIZE / 2 - edit.y;
  const c = Math.cos(edit.rotation), s = Math.sin(edit.rotation);
  return { x: source.x / 2 + (x * c + y * s) / edit.scale * (edit.flip ? -1 : 1),
    y: source.y / 2 + (-x * s + y * c) / edit.scale };
}

export function contourPath(points: Point[], smooth: boolean, closed: boolean): Path2D {
  const path = new Path2D();
  if (!points.length) return path;
  if (smooth && closed && points.length >= 3) {
    const last = points.at(-1)!, first = points[0];
    path.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      path.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    });
  } else {
    path.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) path.lineTo(point.x, point.y);
  }
  if (closed) path.closePath();
  return path;
}

export function photoMaskPath(mask: PhotoMask, source: Point, edit: PhotoTransform): Path2D {
  if (mask.kind === "alpha") {
    const path = new Path2D();
    for (const outline of mask.alpha?.outlines ?? [])
      path.addPath(contourPath(outline.map(point => transformPoint(point, source, edit)), false, true));
    return path;
  }
  if (mask.kind === "shape") return contourPath(mask.shape ?? [], false, true);
  if (mask.kind === "contour") {
    if (!mask.closed) return new Path2D();
    return contourPath(mask.points.map((p) => transformPoint(p, source, edit)), mask.smooth, true);
  }
  const path = new Path2D();
  path.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, PHOTO_SIZE * MASK_RADIUS, 0, Math.PI * 2);
  return path;
}

export function renderMask(mask: PhotoMask, source: Point, edit: PhotoTransform) {
  const canvas = canvasOf(PHOTO_SIZE), ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  // The source already contains its alpha mask. Avoid multiplying antialiased edges again.
  const path = mask.kind === "alpha" ? contourPath([
    { x: 0, y: 0 }, { x: source.x, y: 0 }, source, { x: 0, y: source.y },
  ].map(point => transformPoint(point, source, edit)), false, true) : photoMaskPath(mask, source, edit);
  ctx.fill(path, "evenodd");
  return canvas;
}

export function fitContour(mask: PhotoMask, source: Point, edit: PhotoTransform): PhotoTransform {
  if (mask.points.length < 3) return { ...edit };
  const bounds = (points: Point[]) => ({
    minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
  });
  const first = bounds(mask.points.map((p) => transformPoint(p, source, edit)));
  const scale = PHOTO_SIZE * MASK_RADIUS * 2 / Math.max(1, first.maxX - first.minX, first.maxY - first.minY);
  const next = { ...edit, scale: edit.scale * scale, x: 0, y: 0 };
  const final = bounds(mask.points.map((p) => transformPoint(p, source, next)));
  next.x = PHOTO_SIZE / 2 - (final.minX + final.maxX) / 2;
  next.y = PHOTO_SIZE / 2 - (final.minY + final.maxY) / 2;
  return next;
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

export function renderPhoto(source: HTMLCanvasElement, edit: PhotoTransform, masked: boolean | PhotoMask = true) {
  const output = canvasOf(PHOTO_SIZE);
  const ctx = output.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(PHOTO_SIZE / 2 + edit.x, PHOTO_SIZE / 2 + edit.y);
  ctx.rotate(edit.rotation);
  ctx.scale(edit.scale * (edit.flip ? -1 : 1), edit.scale);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  ctx.restore();
  if (masked && (typeof masked === "boolean" || masked.kind !== "alpha")) {
    // Match the variants' alpha composition, including fractional edge coverage.
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(renderMask(typeof masked === "boolean" ? defaultMask() : masked,
      { x: source.width, y: source.height }, edit), 0, 0);
  }
  return output;
}
