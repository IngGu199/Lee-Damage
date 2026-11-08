import type { Point } from "./PhotoTransform";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Remove redundant freehand samples without rounding off deliberately placed corners. */
export function simplifyStroke(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const first = points[0], last = points.at(-1)!;
  const dx = last.x - first.x, dy = last.y - first.y, length = dx * dx + dy * dy;
  let farthest = -1, maximum = tolerance;
  for (let index = 1; index < points.length - 1; index++) {
    const p = points[index];
    const t = length ? Math.max(0, Math.min(1, ((p.x - first.x) * dx + (p.y - first.y) * dy) / length)) : 0;
    const gap = distance(p, { x: first.x + dx * t, y: first.y + dy * t });
    if (gap > maximum) { maximum = gap; farthest = index; }
  }
  if (farthest < 0) return [first, last];
  return [...simplifyStroke(points.slice(0, farthest + 1), tolerance).slice(0, -1),
    ...simplifyStroke(points.slice(farthest), tolerance)];
}

export function contourProblem(points: Point[]): string | null {
  if (points.length < 3) return "테두리에 점을 3개 이상 찍어 주세요.";
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    for (let j = i + 2; j < points.length; j++) {
      if ((j + 1) % points.length === i) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8)
        return "선이 서로 교차해요. 점을 옮기거나 이전 선을 지워 주세요.";
    }
  }
  let area = 0;
  points.forEach((p, i) => { const q = points[(i + 1) % points.length]; area += p.x * q.y - q.x * p.y; });
  if (Math.abs(area) < 8) return "너무 좁은 영역이에요. 얼굴을 둘러싸도록 그려 주세요.";
  return null;
}
