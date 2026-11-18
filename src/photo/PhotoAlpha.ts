import Phaser from "phaser";
import { canvasOf, PHOTO_SIZE, type PhotoMask, type PhotoTransform, type Point } from "./PhotoTransform";
import { simplifyStroke } from "./PhotoContour";
import { polygonArea } from "./PhotoGeometry";

/** Preserve the full saved frame instead of fitting it through another crop. */
export function alphaTransform(source: HTMLCanvasElement): PhotoTransform {
  return { x: 0, y: 0, scale: PHOTO_SIZE / Math.max(source.width, source.height), rotation: 0, flip: false };
}

const contains = (loop: Point[], point: Point) => {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** Trace the visible pixels, retaining separate islands and transparent holes. */
export function recoverAlphaMask(source: HTMLCanvasElement): PhotoMask | null {
  const ratio = Math.min(1, PHOTO_SIZE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * ratio)), height = Math.max(1, Math.round(source.height * ratio));
  const canvas = canvasOf(width, height), ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const solid = new Uint8Array(width * height);
  let filled = 0;
  for (let i = 0; i < solid.length; i++) { solid[i] = pixels[i * 4 + 3] >= 128 ? 1 : 0; filled += solid[i]; }
  if (filled === solid.length) return null;
  if (!filled) throw new Error("사진의 보이는 영역이 없어요. 보이는 부분이 있는 사진을 선택해 주세요.");

  type Edge = { x: number; y: number; endX: number; endY: number; direction: number; used: boolean };
  const edges: Edge[] = [], starts = new Map<number, Edge[]>();
  const key = (x: number, y: number) => y * (width + 1) + x;
  const add = (x: number, y: number, endX: number, endY: number, direction: number) => {
    const edge = { x, y, endX, endY, direction, used: false };
    edges.push(edge);
    if (edges.length > 32768) throw new Error("투명 배경 윤곽이 너무 복잡해요. 작은 점이나 배경 잔여물을 정리해 주세요.");
    const id = key(x, y), list = starts.get(id);
    if (list) list.push(edge); else starts.set(id, [edge]);
  };
  const occupied = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && solid[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!occupied(x, y)) continue;
    // Clockwise outer boundaries keep solid pixels on the right of every edge.
    if (!occupied(x, y - 1)) add(x, y, x + 1, y, 0);
    if (!occupied(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
    if (!occupied(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
    if (!occupied(x - 1, y)) add(x, y + 1, x, y, 3);
  }
  const outlines: Point[][] = [];
  for (const first of edges) {
    if (first.used) continue;
    const loop: Point[] = [];
    let edge = first;
    while (!edge.used) {
      edge.used = true; loop.push({ x: edge.x, y: edge.y });
      if (edge.endX === first.x && edge.endY === first.y) break;
      const candidates = (starts.get(key(edge.endX, edge.endY)) ?? []).filter(next => !next.used);
      // At diagonally touching pixels, turn right to keep their outlines separate.
      const turnOrder = [1, 0, 3, 2];
      const next = turnOrder.map(turn => candidates.find(next => (next.direction - edge.direction + 4) % 4 === turn))
        .find(next => next !== undefined);
      if (!next) throw new Error("투명 배경의 윤곽을 연결하지 못했어요. 다른 사진을 선택해 주세요.");
      edge = next;
    }
    const corners = loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    });
    const simplified = simplifyStroke([...corners, corners[0]], 0.6).slice(0, -1);
    // Very small islands must still retain a closed outline.
    outlines.push(simplified.length >= 3 && Math.sign(polygonArea(simplified)) === Math.sign(polygonArea(corners))
      ? simplified : corners);
  }
  if (outlines.reduce((sum, loop) => sum + loop.length, 0) > 4096)
    throw new Error("투명 배경 윤곽이 너무 복잡해요. 작은 점이나 배경 잔여물을 정리해 주세요.");

  const groups = outlines.filter(loop => polygonArea(loop) > 0).map(outer => ({ outer, holes: [] as Point[][] }));
  for (const hole of outlines.filter(loop => polygonArea(loop) < 0)) {
    const parent = groups.filter(group => contains(group.outer, hole[0]))
      .sort((a, b) => polygonArea(a.outer) - polygonArea(b.outer))[0];
    if (!parent) throw new Error("사진의 투명 영역을 구분하지 못했어요. 배경을 정리해 주세요.");
    parent.holes.push(hole);
  }
  const pieces: Point[][] = [];
  for (const { outer, holes } of groups) {
    const convex = outer.every((p, i) => {
      const q = outer[(i + 1) % outer.length], r = outer[(i + 2) % outer.length];
      return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x) >= 0;
    });
    // Keep a solid convex outline as one collider instead of many touching triangles.
    if (!holes.length && convex) { pieces.push(outer); continue; }
    const points = [...outer], indices: number[] = [];
    for (const hole of holes) { indices.push(points.length); points.push(...hole); }
    const triangles = Phaser.Geom.Polygon.Earcut(points.flatMap(p => [p.x, p.y]), indices, 2);
    for (let i = 0; i < triangles.length; i += 3) {
      const triangle = triangles.slice(i, i + 3).map(index => points[index]);
      if (Math.abs(polygonArea(triangle)) > 0) pieces.push(triangle);
    }
  }
  if (!pieces.length) throw new Error("사진의 보이는 윤곽을 만들지 못했어요. 다른 사진을 선택해 주세요.");
  const toSource = (points: Point[]) => points.map(p => ({ x: p.x * source.width / width, y: p.y * source.height / height }));
  return { kind: "alpha", points: [], closed: true, smooth: false,
    alpha: { outlines: outlines.map(toSource), pieces: pieces.map(toSource) } };
}
