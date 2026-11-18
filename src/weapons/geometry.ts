export interface Point { x: number; y: number }
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const multiply = (a: Point, n: number): Point => ({ x: a.x * n, y: a.y * n });
export const rotate = (p: Point, angle: number): Point => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) });
export const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
export function unit(p: Point): Point { const length = Math.hypot(p.x, p.y); return length > 1e-9 ? multiply(p, 1 / length) : { x: 1, y: 0 }; }
export function inside(point: Point, vertices: Point[]) {
  let result = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

/** Continuous circle/convex-polygon contact; catches fast bullets between physics ticks. */
export function sweepCircle(start: Point, end: Point, radius: number, vertices: Point[]): number | null {
  if (inside(start, vertices)) return 0;
  const movement = subtract(end, start), length2 = dot(movement, movement);
  let earliest = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length], edge = subtract(b, a), edge2 = dot(edge, edge);
    if (!edge2) continue;
    const projection = Math.max(0, Math.min(1, dot(subtract(start, a), edge) / edge2));
    const closest = add(a, multiply(edge, projection)), distance = subtract(start, closest);
    if (dot(distance, distance) <= radius * radius) return 0;
    if (!length2) continue;
    const offset = subtract(start, a), qb = 2 * dot(offset, movement), qc = dot(offset, offset) - radius * radius;
    const discriminant = qb * qb - 4 * length2 * qc;
    if (discriminant >= 0) {
      const t = (-qb - Math.sqrt(discriminant)) / (2 * length2);
      if (t >= 0 && t <= 1) earliest = Math.min(earliest, t);
    }
    const normal = unit({ x: -edge.y, y: edge.x }), speed = dot(movement, normal);
    if (Math.abs(speed) < 1e-9) continue;
    for (const sign of [-1, 1]) {
      const t = (sign * radius - dot(offset, normal)) / speed;
      if (t < 0 || t > 1) continue;
      const along = dot(subtract(add(start, multiply(movement, t)), a), edge) / edge2;
      if (along >= 0 && along <= 1) earliest = Math.min(earliest, t);
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}
