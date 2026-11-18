import { FaceAnalyzer } from "./FaceAnalyzer";
import { PhotoSession, type PhotoDraft, type AppliedPhoto } from "./PhotoSession";
import {
  defaultTransform, fitFace, PHOTO_SIZE, renderPhoto, transformPoint, inversePoint,
  defaultMask, copyMask, contourPath, photoMaskPath, fitContour,
  type Point, type PhotoMask, type PhotoTransform,
} from "./PhotoTransform";
import { faceBendControls } from "./PhotoVariants";
import { preparePhoto } from "./preparePhoto";
import { FIXED_APPEARANCE } from "../game/appearanceConfig";
import { contourProblem, simplifyStroke } from "./PhotoContour";
import { PhotoLibrary } from "./PhotoLibrary";
import { alphaTransform, recoverAlphaMask } from "./PhotoAlpha";

interface EditorActions {
  begin(): void;
  end(): void;
  apply(photo: AppliedPhoto): void;
  clear(): void;
  clearLabel?(): string;
  previewSize(): number;
}
interface PhotoAsset { id: string; label: string; mask(): PhotoMask }

export class PhotoEditor {
  private readonly dialog: HTMLDialogElement;
  private readonly analyzer = new FaceAnalyzer();
  private readonly library: PhotoLibrary;
  private draft: PhotoDraft | null = null;
  private generation = 0;
  private edited = false;
  private busy = false;
  private analysisPending = false;
  private drag: { id: number; x: number; y: number; mode: "photo" | "draw" | "point"; strokeStart: number } | null = null;
  private contourTool: "draw" | "points" | "move" = "draw";
  private selectedPoint = -1;
  private readonly contourHistory: { mask: PhotoMask; edit: PhotoTransform }[] = [];
  private readonly abort = new AbortController();

  constructor(private readonly session: PhotoSession, private readonly actions: EditorActions, private readonly asset?: PhotoAsset) {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "photo-dialog";
    this.dialog.setAttribute("aria-labelledby", "photo-title");
    this.dialog.innerHTML = `
      <div class="photo-heading"><div><p class="eyebrow">YOUR FACE / YOUR DOLL</p><h2 id="photo-title">사진으로 바꿔 볼까요?</h2></div><button id="photo-close" class="photo-close" aria-label="사진 편집 닫기">×</button></div>
      <p class="photo-copy" id="photo-copy">하얀 원에 맞추거나, 얼굴 테두리를 직접 그려 잘라낼 수 있어요.</p>
      <div class="photo-layout">
        <div class="photo-preview-area"><div class="photo-canvas-wrap">
          <canvas id="photo-canvas" class="photo-editor-canvas" width="512" height="512" tabindex="0" aria-label="사진 위치 편집. 드래그 또는 방향키로 이동"></canvas>
          <span id="photo-empty" class="photo-empty">얼굴이 잘 보이는 사진을 골라 주세요</span>
        </div><p class="photo-hint" id="photo-hint">드래그로 이동 · 방향키로 세밀하게 조절</p></div>
        <div class="photo-controls">
          <section class="photo-library" aria-label="저장된 사진 선택"></section>
          <label class="photo-file-button">내 기기에서 새 사진 추가<input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <p id="photo-filename" class="photo-filename">JPEG · PNG · WebP / 최대 20MB</p>
          <p id="photo-status" class="photo-status" role="status" aria-live="polite">사진은 이 브라우저에서만 처리해요.</p>
          <button id="photo-manual" hidden>분석을 기다리지 않고 직접 맞추기</button>
          <div id="photo-faces" class="photo-faces" role="group" aria-label="적용할 얼굴 선택"></div>
          <div class="photo-mask-modes" role="group" aria-label="사진 자르기 방식"><button id="photo-mask-circle" aria-pressed="true">원형으로 자르기</button><button id="photo-mask-contour" aria-pressed="false">직접 윤곽 그리기</button><button id="photo-mask-alpha" aria-pressed="false" hidden>투명 배경 윤곽</button></div>
          <div id="photo-contour-tools" hidden>
            <div class="photo-contour-tool-row" role="group" aria-label="윤곽 편집 도구"><button id="photo-contour-draw" aria-pressed="true">선 긋기</button><button id="photo-contour-points" aria-pressed="false">점 수정</button><button id="photo-contour-move" aria-pressed="false">사진 이동</button></div>
            <p id="photo-contour-status" class="photo-contour-status" role="status" aria-live="polite"></p>
            <div class="photo-contour-actions"><button id="photo-contour-finish">윤곽 완성</button><button id="photo-contour-undo">윤곽 실행 취소</button><button id="photo-contour-delete">선택한 점 삭제</button><button id="photo-contour-redraw">다시 그리기</button></div>
            <label class="photo-landmark-toggle"><input id="photo-contour-smooth" type="checkbox"> 윤곽 부드럽게 하기</label>
          </div>
          <div class="photo-sliders">
            <label for="photo-zoom">확대 <output id="photo-zoom-value">100%</output></label><input id="photo-zoom" type="range" min="10" max="800" step="1" value="100">
            <label for="photo-rotation">회전 <output id="photo-rotation-value">0°</output></label><input id="photo-rotation" type="range" min="-180" max="180" step="1" value="0">
            <label for="photo-x">좌우 위치</label><input id="photo-x" type="range" min="-512" max="512" step="1" value="0">
            <label for="photo-y">상하 위치</label><input id="photo-y" type="range" min="-512" max="512" step="1" value="0">
          </div>
          <div class="photo-adjust-buttons"><button id="photo-align">얼굴에 맞추기</button><button id="photo-flip" aria-pressed="false">좌우 반전</button><button id="photo-reset">편집 초기화</button></div>
          <label class="photo-landmark-toggle"><input id="photo-landmarks" type="checkbox" checked> 얼굴 기준점 보기</label>
          <div class="photo-actual"><canvas id="photo-small" class="photo-small" width="144" height="144" aria-label="게임 속 크기 미리보기"></canvas><span>게임 속 크기<small>사진이 잘 보이는지 확인해 주세요</small></span></div>
        </div>
      </div>
      <p id="photo-error" role="alert" class="photo-error"></p>
      <div class="photo-bottom"><button id="photo-clear" class="photo-clear">기본 얼굴로</button><span>재배치해도 유지 · 새로고침하면 해제</span><button id="photo-cancel">취소</button><button id="photo-apply" class="photo-primary" disabled>얼굴 적용하기 →</button></div>`;
    if (asset) {
      this.dialog.innerHTML = this.dialog.innerHTML.replace(/(id|for|aria-labelledby)="photo-([^"]*)"/g,
        (_, attribute, suffix) => `${attribute}="${asset.id}-photo-${suffix}"`);
      this.dialog.setAttribute("aria-labelledby", `${asset.id}-photo-title`);
      this.el("photo-title").textContent = `${asset.label} 사진`;
      this.dialog.querySelector(".eyebrow")!.textContent = "무기 이미지";
      this.el("photo-copy").textContent = "기본 모형에 맞춰 자르거나, 사진의 윤곽을 직접 그려 주세요. 윤곽 밖은 충돌하지 않아요.";
      this.el("photo-mask-circle").textContent = "모형으로 자르기";
      this.el("photo-apply").textContent = `${asset.label}에 적용하기 →`;
      this.el("photo-clear").textContent = "기본 도형으로";
      this.el("photo-empty").textContent = "무기로 사용할 사진을 골라 주세요";
      this.el("photo-landmarks").closest("label")!.hidden = true;
    }
    this.el("photo-contour-tools").classList.add("photo-contour-tools");
    this.dialog.dataset.photoTarget = asset?.id ?? "face";
    document.body.append(this.dialog);
    this.library = new PhotoLibrary(this.dialog.querySelector(".photo-library")!, asset?.id ?? "face",
      (file, entry) => this.load(file, entry.path));
    window.addEventListener("resize", () => { if (this.open) this.draw(); }, { signal: this.abort.signal });
    const listen = (id: string, event: string, listener: EventListener) =>
      this.el(id).addEventListener(event, listener, { signal: this.abort.signal });
    listen("photo-file", "change", () => {
      this.library.clearSelection();
      const file = this.el<HTMLInputElement>("photo-file").files?.[0];
      if (file) void this.load(file);
      this.el<HTMLInputElement>("photo-file").value = "";
    });
    for (const id of ["photo-close", "photo-cancel"]) listen(id, "click", () => this.close());
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    listen("photo-clear", "click", () => {
      this.session.clear(); this.actions.clear(); this.close();
    });
    listen("photo-apply", "click", () => void this.apply());
    listen("photo-manual", "click", () => {
      if (!this.draft || !this.analysisPending) return;
      this.generation++; this.analysisPending = false; this.busy = false;
      this.draft.faces = []; this.draft.faceIndex = -1;
      this.el("photo-status").textContent = "사진을 직접 맞춰 주세요. 기준점이 없어 사진 변형은 생략돼요.";
      this.renderFaces(); this.draw();
    });
    listen("photo-reset", "click", () => {
      if (!this.draft) return;
      this.draft.edit = this.draft.mask.kind === "alpha" ? alphaTransform(this.draft.source) : this.initialTransform(this.draft.source);
      this.edited = true; this.draw();
    });
    listen("photo-align", "click", () => this.align());
    listen("photo-flip", "click", () => {
      if (this.draft) { this.draft.edit.flip = !this.draft.edit.flip; this.edited = true; this.draw(); }
    });
    listen("photo-landmarks", "change", () => this.draw());
    for (const kind of ["circle", "contour", "alpha"] as const) listen(`photo-mask-${kind}`, "click", () => {
      if (!this.draft || this.busy) return;
      if (kind === "alpha" && !this.draft.alphaMask) return;
      this.saveContour();
      if (kind === "alpha") this.draft.mask = copyMask(this.draft.alphaMask!);
      else if (kind === "circle" && this.asset) this.draft.mask = { ...this.draft.mask, ...this.asset.mask(), points: this.draft.mask.points };
      else this.draft.mask.kind = kind;
      if (kind === "contour" && this.draft.mask.points.length < 3) this.draft.mask.closed = false;
      this.contourTool = this.draft.mask.closed ? "points" : "draw";
      this.selectedPoint = -1; this.edited = true; this.draw();
    });
    for (const tool of ["draw", "points", "move"] as const) listen(`photo-contour-${tool}`, "click", () => {
      if (!this.draft || this.busy) return;
      if (tool === "draw" && this.draft.mask.closed) {
        this.saveContour(); this.draft.mask.closed = false;
      }
      this.contourTool = tool; this.draw();
    });
    listen("photo-contour-finish", "click", () => this.finishContour());
    listen("photo-contour-undo", "click", () => this.undoContour());
    listen("photo-contour-delete", "click", () => this.deletePoint());
    listen("photo-contour-redraw", "click", () => {
      if (!this.draft || this.busy) return;
      this.saveContour(); this.draft.mask.points = []; this.draft.mask.closed = false;
      this.contourTool = "draw"; this.selectedPoint = -1; this.draw();
    });
    listen("photo-contour-smooth", "change", () => {
      if (!this.draft || this.busy) return;
      this.saveContour(); this.draft.mask.smooth = this.el<HTMLInputElement>("photo-contour-smooth").checked;
      this.draw();
    });
    for (const id of ["zoom", "rotation", "x", "y"]) listen(`photo-${id}`, "input", () => {
      if (!this.draft) return;
      const value = Number(this.el<HTMLInputElement>(`photo-${id}`).value);
      if (id === "zoom") this.draft.edit.scale = value / 100 * defaultTransform(this.draft.source.width, this.draft.source.height).scale;
      else if (id === "rotation") this.draft.edit.rotation = value * Math.PI / 180;
      else if (id === "x") this.draft.edit.x = value;
      else this.draft.edit.y = value;
      this.edited = true; this.draw();
    });
    const canvas = this.el<HTMLCanvasElement>("photo-canvas");
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.draft || this.busy || event.button !== 0 || this.drag) return;
      event.preventDefault();
      const output = this.outputPoint(event), mask = this.draft.mask;
      let mode: "photo" | "draw" | "point" = "photo";
      if (mask.kind === "contour" && this.contourTool !== "move") {
        const near = this.nearestPoint(output);
        if (this.contourTool === "draw") {
          if (near === 0 && mask.points.length >= 3) { this.finishContour(); return; }
          if (mask.points.length >= 256) return;
          this.saveContour();
          this.selectedPoint = -1; mode = "draw";
          mask.points.push(this.sourcePoint(output));
        } else {
          this.selectedPoint = near;
          if (near < 0) { this.draw(); return; }
          this.saveContour(); mode = "point";
        }
      }
      canvas.setPointerCapture(event.pointerId); canvas.focus();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, mode,
        strokeStart: this.draft.mask.points.length - 1 };
      this.edited = true; this.draw();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || !this.draft || event.pointerId !== this.drag.id) return;
      const output = this.outputPoint(event), mask = this.draft.mask;
      if (this.drag.mode === "point") {
        mask.points[this.selectedPoint] = this.sourcePoint(output); this.draw(); return;
      }
      if (this.drag.mode === "draw") {
        const last = transformPoint(mask.points.at(-1)!, this.sourceSize(), this.draft.edit);
        if (Math.hypot(last.x - output.x, last.y - output.y) >= 3) {
          // Keep freehand interaction bounded even on long strokes.
          if (mask.points.length >= 256) {
            mask.points = mask.points.filter((_, index) => index % 2 === 0);
            this.drag.strokeStart = Math.floor(this.drag.strokeStart / 2);
          }
          mask.points.push(this.sourcePoint(output)); this.draw();
        }
        return;
      }
      const ratio = PHOTO_SIZE / canvas.getBoundingClientRect().width;
      this.draft.edit.x = this.constrainOffset(this.draft.edit.x + (event.clientX - this.drag.x) * ratio, "x");
      this.draft.edit.y = this.constrainOffset(this.draft.edit.y + (event.clientY - this.drag.y) * ratio, "y");
      this.drag.x = event.clientX; this.drag.y = event.clientY;
      this.edited = true; this.draw();
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!this.drag || event.pointerId !== this.drag.id || !this.draft) return;
      const drag = this.drag; this.drag = null;
      if (drag.mode === "draw") {
        const mask = this.draft.mask, start = Math.max(0, drag.strokeStart);
        mask.points = [...mask.points.slice(0, start), ...simplifyStroke(mask.points.slice(start), 1.2 / this.draft.edit.scale)];
        if (mask.points.length >= 3 && this.nearestPoint(this.outputPoint(event)) === 0) {
          const first = mask.points[0], last = mask.points.at(-1)!;
          if (Math.hypot(first.x - last.x, first.y - last.y) * this.draft.edit.scale < 14) mask.points.pop();
          this.finishContour(); return;
        }
      }
      this.draw();
    });
    for (const event of ["pointercancel", "lostpointercapture"])
      canvas.addEventListener(event, () => {
        if (!this.drag) return;
        const editContour = this.drag.mode !== "photo"; this.drag = null;
        if (editContour) this.undoContour();
      });
    canvas.addEventListener("dblclick", () => {
      if (this.draft?.mask.kind === "contour" && !this.draft.mask.closed) this.finishContour();
    });
    canvas.addEventListener("keydown", (event) => {
      if (!this.draft || this.busy) return;
      const mask = this.draft.mask;
      if (mask.kind === "contour") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault(); this.undoContour(); return;
        }
        if (event.key === "Enter") { event.preventDefault(); this.finishContour(); return; }
        if (["Delete", "Backspace"].includes(event.key)) {
          event.preventDefault();
          if (this.selectedPoint >= 0) this.deletePoint(); else this.undoContour();
          return;
        }
        if (this.contourTool === "points" && mask.points.length && ["[", "]"].includes(event.key)) {
          event.preventDefault();
          this.selectedPoint = (this.selectedPoint + (event.key === "]" ? 1 : -1) + mask.points.length) % mask.points.length;
          this.draw(); return;
        }
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const d = event.shiftKey ? 10 : 1;
      if (mask.kind === "contour" && this.contourTool === "points" && this.selectedPoint >= 0) {
        this.saveContour();
        const p = transformPoint(mask.points[this.selectedPoint], this.sourceSize(), this.draft.edit);
        p.x += event.key === "ArrowLeft" ? -d : event.key === "ArrowRight" ? d : 0;
        p.y += event.key === "ArrowUp" ? -d : event.key === "ArrowDown" ? d : 0;
        mask.points[this.selectedPoint] = this.sourcePoint(p); this.draw(); return;
      }
      if (mask.kind === "contour" && this.contourTool !== "move") return;
      if (event.key === "ArrowLeft") this.draft.edit.x -= d;
      if (event.key === "ArrowRight") this.draft.edit.x += d;
      if (event.key === "ArrowUp") this.draft.edit.y -= d;
      if (event.key === "ArrowDown") this.draft.edit.y += d;
      this.draft.edit.x = this.constrainOffset(this.draft.edit.x, "x");
      this.draft.edit.y = this.constrainOffset(this.draft.edit.y, "y");
      this.edited = true; this.draw();
    });
  }

  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.dialog.querySelector<T>(`#${this.asset ? `${this.asset.id}-${id}` : id}`)!;
  }
  private initialTransform(source: HTMLCanvasElement) {
    const edit = defaultTransform(source.width, source.height);
    if (this.asset) edit.scale = PHOTO_SIZE * 0.94 / Math.max(source.width, source.height);
    return edit;
  }
  get open() { return this.dialog.open; }

  private sourceSize() { return { x: this.draft!.source.width, y: this.draft!.source.height }; }

  private offsetLimit(axis: "x" | "y") {
    return Math.ceil(PHOTO_SIZE + (axis === "x" ? this.draft!.source.width : this.draft!.source.height) * this.draft!.edit.scale / 2);
  }

  private constrainOffset(value: number, axis: "x" | "y") {
    const limit = this.offsetLimit(axis);
    return Math.max(-limit, Math.min(limit, value));
  }

  private outputPoint(event: PointerEvent): Point {
    const box = this.el<HTMLCanvasElement>("photo-canvas").getBoundingClientRect();
    return { x: (event.clientX - box.left) * PHOTO_SIZE / box.width,
      y: (event.clientY - box.top) * PHOTO_SIZE / box.height };
  }

  private sourcePoint(output: Point): Point {
    const point = inversePoint(output, this.sourceSize(), this.draft!.edit);
    return { x: Math.max(0, Math.min(this.draft!.source.width, point.x)),
      y: Math.max(0, Math.min(this.draft!.source.height, point.y)) };
  }

  private nearestPoint(output: Point): number {
    if (!this.draft) return -1;
    const radius = 13 * PHOTO_SIZE / this.el<HTMLCanvasElement>("photo-canvas").getBoundingClientRect().width;
    let nearest = -1, gap = radius;
    this.draft.mask.points.forEach((point, index) => {
      const projected = transformPoint(point, this.sourceSize(), this.draft!.edit);
      const distance = Math.hypot(output.x - projected.x, output.y - projected.y);
      if (this.contourTool === "draw" && index === 0 && distance <= radius) nearest = 0;
      if ((nearest !== 0 || this.contourTool !== "draw") && distance <= gap) { gap = distance; nearest = index; }
    });
    return nearest;
  }

  private saveContour() {
    if (!this.draft) return;
    this.contourHistory.push({ mask: copyMask(this.draft.mask), edit: { ...this.draft.edit } });
    if (this.contourHistory.length > 40) this.contourHistory.shift();
    this.edited = true;
  }

  private undoContour() {
    if (!this.draft || this.busy) return;
    const previous = this.contourHistory.pop();
    if (!previous) return;
    this.draft.mask = previous.mask; this.draft.edit = previous.edit;
    this.selectedPoint = -1;
    this.contourTool = previous.mask.closed ? "points" : "draw";
    this.draw();
  }

  private deletePoint() {
    if (!this.draft || this.busy || this.selectedPoint < 0) return;
    const mask = this.draft.mask;
    if (mask.closed && mask.points.length <= 3) return;
    this.saveContour(); mask.points.splice(this.selectedPoint, 1);
    this.selectedPoint = -1; this.draw();
  }

  private finishContour() {
    if (!this.draft || this.busy || this.draft.mask.kind !== "contour" || this.draft.mask.closed) return;
    if (contourProblem(this.draft.mask.points)) { this.draw(); return; }
    this.saveContour(); this.draft.mask.closed = true;
    this.draft.edit = fitContour(this.draft.mask, this.sourceSize(), this.draft.edit);
    this.contourTool = "points"; this.selectedPoint = -1; this.draw();
  }

  show() {
    if (this.open) return;
    if (this.actions.clearLabel) this.el("photo-clear").textContent = this.actions.clearLabel();
    this.actions.begin();
    const current = this.session.current;
    this.draft = current ? { ...current, edit: { ...current.edit }, mask: copyMask(current.mask ?? defaultMask()) } : null;
    this.contourHistory.length = 0; this.selectedPoint = -1; this.drag = null;
    this.contourTool = this.draft?.mask.closed ? "points" : "draw";
    this.edited = false;
    this.el("photo-error").textContent = "";
    this.el("photo-status").textContent = current
      ? current.mask.kind === "alpha" ? "투명 배경에서 복원한 윤곽이에요. 사진 위치를 조절하거나 그대로 적용할 수 있어요."
        : current.faces.length ? "얼굴 기준점을 불러왔어요. 위치를 다시 조절할 수 있어요." : "수동 사진이에요. 얼굴을 맞춰 적용해 주세요."
      : "사진은 이 브라우저에서만 처리해요.";
    this.el("photo-filename").textContent = current?.name ?? "JPEG · PNG · WebP / 최대 20MB";
    this.busy = false; this.analysisPending = false;
    this.renderFaces(); this.draw();
    this.dialog.showModal();
    this.library.open(current?.libraryPath);
  }

  private close() {
    if (!this.open) return;
    this.generation++; this.drag = null; this.draft = null; this.busy = false; this.analysisPending = false;
    this.library.close();
    this.contourHistory.length = 0; this.selectedPoint = -1;
    this.dialog.close(); this.actions.end();
    this.el<HTMLCanvasElement>("photo-canvas").getContext("2d")!.clearRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    this.el<HTMLCanvasElement>("photo-small").getContext("2d")!.clearRect(0, 0, 144, 144);
  }

  private async load(file: File, libraryPath?: string) {
    const id = ++this.generation;
    this.el("photo-error").textContent = "";
    this.el("photo-status").textContent = "사진을 준비하고 있어요…";
    this.busy = true; this.analysisPending = false; this.controls();
    try {
      const source = await PhotoSession.decode(file);
      if (id !== this.generation || !this.open) return;
      const alphaMask = recoverAlphaMask(source);
      this.draft = { source, name: file.name, libraryPath, preserveFraming: Boolean(alphaMask || libraryPath), faces: [], faceIndex: -1,
        edit: alphaMask ? alphaTransform(source) : this.initialTransform(source),
        mask: alphaMask ? copyMask(alphaMask) : this.asset?.mask() ?? defaultMask(), alphaMask: alphaMask ?? undefined };
      this.contourHistory.length = 0; this.selectedPoint = -1; this.contourTool = "draw";
      this.edited = false; this.analysisPending = true; this.renderFaces(); this.draw();
      this.el("photo-filename").textContent = file.name;
      if (this.asset) {
        this.analysisPending = false;
        this.el("photo-status").textContent = alphaMask
          ? "투명 배경에서 윤곽을 자동으로 복원했어요. 저장된 모양 그대로 적용할 수 있어요."
          : "사진을 모형에 맞추거나 윤곽을 직접 그려 적용해 주세요.";
        return;
      }
      this.el("photo-status").textContent = this.draft.preserveFraming
        ? "사진의 위치와 윤곽을 유지하면서 얼굴 기준점을 찾고 있어요. 처음에는 모델 준비에 시간이 걸릴 수 있어요."
        : "얼굴 기준점을 찾고 있어요. 처음에는 모델 준비에 시간이 걸릴 수 있어요.";
      try {
        const faces = await this.analyzer.detect(source, () => id !== this.generation || !this.open);
        if (id !== this.generation || !this.open) return;
        this.draft.faces = faces;
        this.draft.faceIndex = faces.length === 1 ? 0 : -1;
        if (faces.length === 1 && !this.edited && !this.draft.preserveFraming)
          this.draft.edit = fitFace(faces[0], source.width, source.height);
        this.el("photo-status").textContent = faces.length === 0
          ? "얼굴을 찾지 못했어요. 직접 맞춰 적용할 수 있어요. 사진 변형은 생략돼요."
          : faces.length === 1 ? this.draft.preserveFraming
            ? "얼굴 기준점을 찾았어요. 사진의 위치와 윤곽은 그대로 유지했어요."
            : "얼굴을 찾았어요. 필요하면 위치를 조절해 주세요."
          : `${faces.length}개의 얼굴을 찾았어요. 사용할 얼굴을 골라 주세요.`;
      } catch {
        if (id !== this.generation || !this.open) return;
        this.el("photo-status").textContent = "얼굴 분석을 준비하지 못했어요. 수동으로 적용하거나 사진을 다시 선택해 주세요.";
      }
    } catch (error) {
      if (id !== this.generation || !this.open) return;
      this.el("photo-error").textContent = error instanceof Error ? error.message : "사진을 준비하지 못했어요.";
      this.el("photo-status").textContent = "다른 사진을 선택하거나 기존 사진으로 계속할 수 있어요.";
    } finally {
      if (id === this.generation && this.open) {
        this.busy = false; this.analysisPending = false; this.renderFaces(); this.draw();
      }
    }
  }

  private align() {
    if (this.draft?.mask.kind === "alpha") {
      this.draft.edit = alphaTransform(this.draft.source); this.edited = true; this.draw(); return;
    }
    if (this.asset && this.draft && this.draft.mask.kind !== "contour") {
      this.draft.edit = this.initialTransform(this.draft.source); this.edited = true; this.draw(); return;
    }
    if (this.draft?.mask.kind === "contour" && this.draft.mask.closed) {
      this.saveContour(); this.draft.edit = fitContour(this.draft.mask, this.sourceSize(), this.draft.edit);
      this.draw(); return;
    }
    if (!this.draft || this.draft.faceIndex < 0) return;
    this.draft.edit = fitFace(this.draft.faces[this.draft.faceIndex], this.draft.source.width, this.draft.source.height);
    this.edited = true; this.draw();
  }

  private renderFaces() {
    const container = this.el("photo-faces"); container.replaceChildren();
    if (!this.draft || this.draft.faces.length < 2) return;
    this.draft.faces.forEach((_, index) => {
      const button = document.createElement("button");
      button.textContent = `얼굴 ${index + 1}`;
      button.disabled = this.busy;
      button.setAttribute("aria-pressed", String(this.draft!.faceIndex === index));
      button.addEventListener("click", () => {
        this.draft!.faceIndex = index;
        if (this.draft!.preserveFraming) this.draw(); else this.align();
        this.renderFaces();
      });
      container.append(button);
    });
  }

  private controls() {
    const mask = this.draft?.mask ?? defaultMask(), custom = mask.kind === "contour";
    const problem = custom ? contourProblem(mask.points) : null;
    this.el("photo-contour-tools").hidden = !custom;
    this.el("photo-mask-alpha").hidden = !this.draft?.alphaMask;
    for (const kind of ["circle", "contour", "alpha"]) {
      const button = this.el<HTMLButtonElement>(`photo-mask-${kind}`);
      button.disabled = !this.draft || this.busy;
      button.setAttribute("aria-pressed", String(mask.kind === kind || (kind === "circle" && mask.kind === "shape")));
    }
    for (const tool of ["draw", "points", "move"]) {
      const button = this.el<HTMLButtonElement>(`photo-contour-${tool}`);
      button.disabled = !this.draft || this.busy;
      button.setAttribute("aria-pressed", String(this.contourTool === tool));
    }
    this.el<HTMLButtonElement>("photo-contour-finish").disabled = this.busy || mask.closed || mask.points.length < 3;
    this.el<HTMLButtonElement>("photo-contour-undo").disabled = this.busy || !this.contourHistory.length;
    this.el<HTMLButtonElement>("photo-contour-delete").disabled = this.busy || this.selectedPoint < 0 || (mask.closed && mask.points.length <= 3);
    this.el<HTMLButtonElement>("photo-contour-redraw").disabled = this.busy || !mask.points.length;
    this.el<HTMLInputElement>("photo-contour-smooth").disabled = this.busy || !mask.closed;
    this.el<HTMLInputElement>("photo-contour-smooth").checked = mask.smooth;
    this.el("photo-contour-status").textContent = mask.points.length >= 3 && problem ? problem
      : mask.closed ? `윤곽 완성 · 점 ${mask.points.length}개. 점을 끌어 위치를 수정할 수 있어요.`
      : mask.points.length >= 256 ? "점은 최대 256개예요. 시작점을 누르거나 ‘윤곽 완성’으로 마무리해 주세요."
      : `${this.asset ? "무기 윤곽" : "얼굴"}을 따라 클릭하거나 드래그해 주세요. 점 ${mask.points.length}개 · 시작점을 누르거나 ‘윤곽 완성’으로 마무리해요.`;
    this.el("photo-hint").textContent = !custom || this.contourTool === "move"
      ? "드래그로 사진 이동 · 방향키로 세밀하게 조절"
      : this.contourTool === "draw" ? "클릭 또는 드래그로 테두리 그리기 · Enter로 완성 · Ctrl+Z로 취소"
      : "점을 끌어 수정 · [ / ]로 점 선택 · 방향키로 이동 · Delete로 삭제";
    this.el<HTMLCanvasElement>("photo-canvas").style.cursor = !custom || this.contourTool === "move" ? "move" : this.contourTool === "draw" ? "crosshair" : "default";
    this.el<HTMLCanvasElement>("photo-canvas").setAttribute("aria-label", custom ? "얼굴 윤곽 편집. 클릭 또는 드래그로 그리고 Enter로 완성" : "사진 위치 편집. 드래그 또는 방향키로 이동");
    this.el("photo-manual").hidden = !this.analysisPending;
    for (const id of ["photo-zoom", "photo-rotation", "photo-x", "photo-y", "photo-flip", "photo-reset", "photo-landmarks"])
      this.el<HTMLInputElement>(id).disabled = !this.draft || this.busy;
    this.el("photo-align").textContent = mask.kind === "alpha" ? "저장된 크기로 맞추기" : custom ? "윤곽에 맞추기" : this.asset ? "사진 맞추기" : "얼굴에 맞추기";
    this.el<HTMLButtonElement>("photo-align").disabled = !this.draft || this.busy ||
      (mask.kind !== "alpha" && (custom ? !mask.closed : !this.asset && this.draft.faceIndex < 0));
    this.el<HTMLButtonElement>("photo-apply").disabled = !this.draft || this.busy ||
      (custom && (!mask.closed || Boolean(problem))) || (this.draft.faces.length > 1 && this.draft.faceIndex < 0);
    this.el<HTMLInputElement>("photo-file").disabled = false;
    this.el<HTMLButtonElement>("photo-clear").disabled = !this.session.current;
  }

  private draw() {
    this.controls();
    const canvas = this.el<HTMLCanvasElement>("photo-canvas"), ctx = canvas.getContext("2d")!;
    const small = this.el<HTMLCanvasElement>("photo-small"), smallCtx = small.getContext("2d")!;
    const previewSize = this.actions.previewSize();
    small.style.width = `${previewSize}px`; small.style.height = `${previewSize}px`;
    ctx.clearRect(0, 0, PHOTO_SIZE, PHOTO_SIZE); smallCtx.clearRect(0, 0, 144, 144);
    this.el("photo-empty").hidden = Boolean(this.draft);
    if (this.draft) {
      const { source, edit, faces, faceIndex, mask } = this.draft;
      ctx.drawImage(renderPhoto(source, edit, false), 0, 0);
      const cropped = renderPhoto(source, edit, mask);
      const photoScale = FIXED_APPEARANCE.photoScale, frameScale = Math.min(1, photoScale);
      smallCtx.drawImage(cropped, 72 * (1 - frameScale), 72 * (1 - frameScale), 144 * frameScale, 144 * frameScale);
      // Generic preview hook used by optional local tools, with no storage dependency.
      this.dialog.dispatchEvent(new CustomEvent("photo-preview", { bubbles: true, detail: {
        canvas: cropped, target: this.asset?.id ?? "face", name: this.draft.name,
        valid: !this.el<HTMLButtonElement>("photo-apply").disabled,
      } }));
      const base = defaultTransform(source.width, source.height).scale;
      const zoom = Math.round(edit.scale / base * 100), rotation = Math.round(edit.rotation * 180 / Math.PI);
      this.el<HTMLInputElement>("photo-zoom").max = String(Math.max(800, Math.ceil(zoom / 100) * 100));
      this.el<HTMLInputElement>("photo-zoom").value = String(zoom);
      this.el("photo-zoom-value").textContent = `${zoom}%`;
      this.el<HTMLInputElement>("photo-rotation").value = String(rotation);
      this.el("photo-rotation-value").textContent = `${rotation}°`;
      this.el<HTMLInputElement>("photo-x").value = String(edit.x);
      this.el<HTMLInputElement>("photo-y").value = String(edit.y);
      for (const axis of ["x", "y"] as const) {
        const control = this.el<HTMLInputElement>(`photo-${axis}`);
        control.min = String(-this.offsetLimit(axis)); control.max = String(this.offsetLimit(axis));
        control.value = String(edit[axis]);
      }
      this.el("photo-flip").setAttribute("aria-pressed", String(edit.flip));
      if (this.el<HTMLInputElement>("photo-landmarks").checked && faceIndex >= 0) {
        ctx.fillStyle = "#d5ff72";
        for (const index of [1, 4, 10, 33, 61, 133, 152, 168, 263, 291, 362]) {
          const p = transformPoint(faces[faceIndex][index], { x: source.width, y: source.height }, edit);
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        }
        const points = faces[faceIndex].map((point) => transformPoint(point, this.sourceSize(), edit));
        ctx.fillStyle = "#ffe085";
        for (const { center } of faceBendControls(points)) {
          ctx.beginPath(); ctx.arc(center.x, center.y, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    const mask = this.draft?.mask ?? defaultMask();
    const points = this.draft ? mask.points.map((p) => transformPoint(p, this.sourceSize(), this.draft!.edit)) : [];
    const path = mask.kind !== "contour" ? photoMaskPath(mask, this.draft ? this.sourceSize() : { x: 512, y: 512 },
      this.draft?.edit ?? defaultTransform(512, 512))
      : contourPath(points, mask.smooth, mask.closed);
    if (mask.kind !== "contour" || mask.closed) {
      const outside = new Path2D(); outside.rect(0, 0, PHOTO_SIZE, PHOTO_SIZE); outside.addPath(path);
      ctx.fillStyle = "rgba(21,31,25,.62)"; ctx.fill(outside, "evenodd");
    }
    ctx.strokeStyle = mask.kind === "contour" && mask.points.length >= 3 && contourProblem(mask.points) ? "#ffab96" : "#fff";
    ctx.lineWidth = 2; ctx.stroke(path);
    if (mask.kind === "contour" && this.contourTool !== "move") {
      points.forEach((p, index) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, index === this.selectedPoint || index === 0 ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = index === this.selectedPoint ? "#ffe085" : index === 0 ? "#c4ef7c" : "#fff"; ctx.fill();
        ctx.strokeStyle = "#344c2e"; ctx.lineWidth = 1; ctx.stroke();
      });
    }
  }

  private async apply() {
    if (!this.draft || this.busy) return;
    if (this.draft.mask.kind === "contour" && (!this.draft.mask.closed || contourProblem(this.draft.mask.points))) return;
    const id = ++this.generation, draft = { ...this.draft, edit: { ...this.draft.edit }, mask: copyMask(this.draft.mask) };
    this.busy = true; this.controls(); this.renderFaces();
    this.el("photo-status").textContent = this.asset ? "무기 사진과 충돌 윤곽을 준비하고 있어요…" : "고화질 얼굴과 충격에 쓸 사진을 준비하고 있어요…";
    const current = () => id === this.generation && this.open;
    try {
      const photo = await preparePhoto(draft, () => !current(), !this.asset);
      if (!current()) return;
      this.actions.apply(photo);
      this.session.current = photo;
      this.close();
    } catch (error) {
      if (!current()) return;
      this.busy = false; this.controls(); this.renderFaces();
      this.el("photo-error").textContent = error instanceof Error ? error.message : "사진을 적용하지 못했어요. 다시 적용하거나 취소해 주세요.";
    }
  }

  refreshPreview() { if (this.open) this.draw(); }

  destroy() {
    this.close(); this.library.destroy(); this.analyzer.destroy(); this.abort.abort(); this.dialog.remove(); this.session.clear();
  }
}
