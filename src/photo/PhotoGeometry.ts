import { PHOTO_SIZE, transformPoint, type PhotoMask, type PhotoTransform, type Point } from "./PhotoTransform";
import { simplifyStroke } from "./PhotoContour";

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export const polygonArea = (points: Point[]) => points.reduce((sum, p, i) => {
  const next = points[(i + 1) % points.length]; return sum + p.x * next.y - next.x * p.y;
}, 0) / 2;

/** Clip to the output and image footprint; invisible space cannot become a collider. */
export function clipPolygon(subject: Point[], boundary: Point[]) {
  let output = subject;
  const sign = Math.sign(polygonArea(boundary));
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length], input = output; output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const dp = cross(a, b, p) * sign, dq = cross(a, b, q) * sign;
      if (dp >= -1e-7) output.push(p);
      if ((dp < 0) !== (dq < 0)) {
        const t = dp / (dp - dq); output.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
  }
  return output;
}

/** Same outline as the canvas mask, including the editor's rounded quadratic curves. */
export function maskPolygon(mask: PhotoMask, source: Point, edit: PhotoTransform, clipToImage = true) {
  let points: Point[];
  if (mask.kind === "circle") points = Array.from({ length: 48 }, (_, i) => ({
    x: PHOTO_SIZE * (0.5 + 0.47 * Math.cos(i * Math.PI / 24)),
    y: PHOTO_SIZE * (0.5 + 0.47 * Math.sin(i * Math.PI / 24)),
  }));
  else if (mask.kind === "shape") points = mask.shape ?? [];
  else {
    if (!mask.closed) throw new Error("윤곽을 완성해 주세요.");
    points = mask.points.map(point => transformPoint(point, source, edit));
    if (mask.smooth) points = points.flatMap((point, i, all) => {
      const previous = all[(i + all.length - 1) % all.length], next = all[(i + 1) % all.length];
      const start = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
      const end = { x: (next.x + point.x) / 2, y: (next.y + point.y) / 2 };
      return Array.from({ length: 8 }, (_, step) => {
        const t = step / 8, s = 1 - t;
        return { x: s * s * start.x + 2 * s * t * point.x + t * t * end.x,
          y: s * s * start.y + 2 * s * t * point.y + t * t * end.y };
      });
    });
  }
  if (mask.smooth && points.length > 3) points = simplifyStroke([...points, points[0]], 0.6).slice(0, -1);
  if (!clipToImage) return points;
  const image = [{ x: 0, y: 0 }, { x: source.x, y: 0 }, source, { x: 0, y: source.y }]
    .map(point => transformPoint(point, source, edit));
  points = clipPolygon(clipPolygon(points, image), [{ x: 0, y: 0 }, { x: PHOTO_SIZE, y: 0 },
    { x: PHOTO_SIZE, y: PHOTO_SIZE }, { x: 0, y: PHOTO_SIZE }]);
  return points;
}

/** Clip convex pieces separately: cropping can split a concave outline into islands. */
export function photoPieces(mask: PhotoMask, source: Point, edit: PhotoTransform) {
  const image = [{ x: 0, y: 0 }, { x: source.x, y: 0 }, source, { x: 0, y: source.y }]
    .map(point => transformPoint(point, source, edit));
  const output = [{ x: 0, y: 0 }, { x: PHOTO_SIZE, y: 0 }, { x: PHOTO_SIZE, y: PHOTO_SIZE }, { x: 0, y: PHOTO_SIZE }];
  const pieces = convexPieces(maskPolygon(mask, source, edit, false))
    .map(piece => clipPolygon(clipPolygon(piece, image), output)).filter(piece => Math.abs(polygonArea(piece)) > 0.01);
  if (!pieces.length) throw new Error("사진이 자르기 영역 밖에 있어요. 사진 위치를 맞춰 주세요.");
  return pieces;
}

/** Ear clipping preserves concave cutouts, unlike a convex-hull fallback. */
export function convexPieces(input: Point[]): Point[][] {
  let points = input.filter((point, i) => Math.hypot(point.x - input[(i + 1) % input.length].x,
    point.y - input[(i + 1) % input.length].y) > 1e-5).map(point => ({ ...point }));
  if (polygonArea(points) < 0) points.reverse();
  if (points.length < 3 || polygonArea(points) < 0.01) throw new Error("사진의 보이는 영역이 너무 작아요. 위치와 윤곽을 확인해 주세요.");
  // Drop collinear samples before triangulating, without changing the boundary.
  points = points.filter((p, i, all) => Math.abs(cross(all[(i + all.length - 1) % all.length], p, all[(i + 1) % all.length])) > 1e-7);
  if (points.every((p, i, all) => cross(p, all[(i + 1) % all.length], all[(i + 2) % all.length]) >= -1e-7)) return [points];
  const remaining = [...points], result: Point[][] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length], b = remaining[i], c = remaining[(i + 1) % remaining.length];
      if (cross(a, b, c) <= 1e-7) continue;
      if (remaining.some(p => p !== a && p !== b && p !== c && cross(a, b, p) >= -1e-7 &&
        cross(b, c, p) >= -1e-7 && cross(c, a, p) >= -1e-7)) continue;
      result.push([a, b, c]); remaining.splice(i, 1); found = true; break;
    }
    if (!found) throw new Error("충돌 윤곽을 만들지 못했어요. 교차하거나 겹치는 선을 정리해 주세요.");
  }
  result.push(remaining);
  return result;
}
