import { FaceAnalyzer } from "./FaceAnalyzer";
import { PhotoSession, type PhotoDraft, type AppliedPhoto } from "./PhotoSession";
import { defaultTransform, fitFace, MASK_RADIUS, PHOTO_SIZE, renderPhoto, transformPoint } from "./PhotoTransform";
import { makeVariants } from "./PhotoVariants";

interface EditorActions {
  begin(): void;
  end(): void;
  apply(photo: AppliedPhoto): void;
  clear(): void;
  previewSize(): number;
}

export class PhotoEditor {
  private readonly dialog: HTMLDialogElement;
  private readonly analyzer = new FaceAnalyzer();
  private draft: PhotoDraft | null = null;
  private generation = 0;
  private edited = false;
  private busy = false;
  private analysisPending = false;
  private drag: { id: number; x: number; y: number } | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly session: PhotoSession, private readonly actions: EditorActions) {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "photo-dialog";
    this.dialog.setAttribute("aria-labelledby", "photo-title");
    this.dialog.innerHTML = `
      <div class="photo-heading"><div><p class="eyebrow">YOUR FACE / YOUR DOLL</p><h2 id="photo-title">사진으로 바꿔 볼까요?</h2></div><button id="photo-close" class="photo-close" aria-label="사진 편집 닫기">×</button></div>
      <p class="photo-copy">사진을 움직여 하얀 원 안에 맞춰 주세요. 원 안쪽만 얼굴에 적용돼요.</p>
      <div class="photo-layout">
        <div class="photo-preview-area"><div class="photo-canvas-wrap">
          <canvas id="photo-canvas" width="512" height="512" tabindex="0" aria-label="사진 위치 편집. 드래그 또는 방향키로 이동"></canvas>
          <span id="photo-empty">얼굴이 잘 보이는 사진을 골라 주세요</span>
        </div><p class="photo-hint">드래그로 이동 · 방향키로 세밀하게 조절</p></div>
        <div class="photo-controls">
          <label class="photo-file-button">사진 선택<input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <p id="photo-filename" class="photo-filename">JPEG · PNG · WebP / 최대 20MB</p>
          <p id="photo-status" class="photo-status" role="status" aria-live="polite">사진은 이 브라우저에서만 처리해요.</p>
          <button id="photo-manual" hidden>분석을 기다리지 않고 직접 맞추기</button>
          <div id="photo-faces" class="photo-faces" role="group" aria-label="적용할 얼굴 선택"></div>
          <div class="photo-sliders">
            <label for="photo-zoom">확대 <output id="photo-zoom-value">100%</output></label><input id="photo-zoom" type="range" min="10" max="800" step="1" value="100">
            <label for="photo-rotation">회전 <output id="photo-rotation-value">0°</output></label><input id="photo-rotation" type="range" min="-180" max="180" step="1" value="0">
            <label for="photo-x">좌우 위치</label><input id="photo-x" type="range" min="-512" max="512" step="1" value="0">
            <label for="photo-y">상하 위치</label><input id="photo-y" type="range" min="-512" max="512" step="1" value="0">
          </div>
          <div class="photo-adjust-buttons"><button id="photo-align">얼굴에 맞추기</button><button id="photo-flip" aria-pressed="false">좌우 반전</button><button id="photo-reset">편집 초기화</button></div>
          <label class="photo-landmark-toggle"><input id="photo-landmarks" type="checkbox" checked> 얼굴 기준점 보기</label>
          <div class="photo-actual"><canvas id="photo-small" width="144" height="144" aria-label="게임 속 얼굴 크기 미리보기"></canvas><span>게임 속 크기<small>얼굴이 잘 보이는지 확인해 주세요</small></span></div>
        </div>
      </div>
      <p id="photo-error" role="alert" class="photo-error"></p>
      <div class="photo-bottom"><button id="photo-clear" class="photo-clear">기본 얼굴로</button><span>재배치해도 유지 · 새로고침하면 해제</span><button id="photo-cancel">취소</button><button id="photo-apply" class="photo-primary" disabled>얼굴 적용하기 →</button></div>`;
    document.body.append(this.dialog);
    window.addEventListener("resize", () => { if (this.open) this.draw(); }, { signal: this.abort.signal });
    const listen = (id: string, event: string, listener: EventListener) =>
      this.el(id).addEventListener(event, listener, { signal: this.abort.signal });
    listen("photo-file", "change", () => {
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
      this.draft.edit = defaultTransform(this.draft.source.width, this.draft.source.height);
      this.edited = true; this.draw();
    });
    listen("photo-align", "click", () => this.align());
    listen("photo-flip", "click", () => {
      if (this.draft) { this.draft.edit.flip = !this.draft.edit.flip; this.edited = true; this.draw(); }
    });
    listen("photo-landmarks", "change", () => this.draw());
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
      if (!this.draft || this.busy || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId); canvas.focus();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || !this.draft || event.pointerId !== this.drag.id) return;
      const ratio = PHOTO_SIZE / canvas.getBoundingClientRect().width;
      this.draft.edit.x = Math.max(-512, Math.min(512, this.draft.edit.x + (event.clientX - this.drag.x) * ratio));
      this.draft.edit.y = Math.max(-512, Math.min(512, this.draft.edit.y + (event.clientY - this.drag.y) * ratio));
      this.drag.x = event.clientX; this.drag.y = event.clientY;
      this.edited = true; this.draw();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(event, () => { this.drag = null; });
    canvas.addEventListener("keydown", (event) => {
      if (!this.draft || this.busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const d = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") this.draft.edit.x -= d;
      if (event.key === "ArrowRight") this.draft.edit.x += d;
      if (event.key === "ArrowUp") this.draft.edit.y -= d;
      if (event.key === "ArrowDown") this.draft.edit.y += d;
      this.draft.edit.x = Math.max(-512, Math.min(512, this.draft.edit.x));
      this.draft.edit.y = Math.max(-512, Math.min(512, this.draft.edit.y));
      this.edited = true; this.draw();
    });
  }

  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.dialog.querySelector<T>(`#${id}`)!; }
  get open() { return this.dialog.open; }

  show() {
    if (this.open) return;
    this.actions.begin();
    const current = this.session.current;
    this.draft = current ? { ...current, edit: { ...current.edit } } : null;
    this.edited = false;
    this.el("photo-error").textContent = "";
    this.el("photo-status").textContent = current
      ? current.faces.length ? "얼굴 기준점을 불러왔어요. 위치를 다시 조절할 수 있어요." : "수동 사진이에요. 얼굴을 맞춰 적용해 주세요."
      : "사진은 이 브라우저에서만 처리해요.";
    this.el("photo-filename").textContent = current?.name ?? "JPEG · PNG · WebP / 최대 20MB";
    this.busy = false; this.analysisPending = false;
    this.renderFaces(); this.draw();
    this.dialog.showModal();
  }

  private close() {
    if (!this.open) return;
    this.generation++; this.drag = null; this.draft = null; this.busy = false; this.analysisPending = false;
    this.dialog.close(); this.actions.end();
    this.el<HTMLCanvasElement>("photo-canvas").getContext("2d")!.clearRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    this.el<HTMLCanvasElement>("photo-small").getContext("2d")!.clearRect(0, 0, 144, 144);
  }

  private async load(file: File) {
    const id = ++this.generation;
    this.el("photo-error").textContent = "";
    this.el("photo-status").textContent = "사진을 준비하고 있어요…";
    this.busy = true; this.analysisPending = false; this.controls();
    try {
      const source = await PhotoSession.decode(file);
      if (id !== this.generation || !this.open) return;
      this.draft = { source, name: file.name, faces: [], faceIndex: -1, edit: defaultTransform(source.width, source.height) };
      this.edited = false; this.analysisPending = true; this.renderFaces(); this.draw();
      this.el("photo-filename").textContent = file.name;
      this.el("photo-status").textContent = "얼굴 기준점을 찾고 있어요. 처음에는 모델 준비에 시간이 걸릴 수 있어요.";
      try {
        const faces = await this.analyzer.detect(source, () => id !== this.generation || !this.open);
        if (id !== this.generation || !this.open) return;
        this.draft.faces = faces;
        this.draft.faceIndex = faces.length === 1 ? 0 : -1;
        if (faces.length === 1 && !this.edited) this.draft.edit = fitFace(faces[0], source.width, source.height);
        this.el("photo-status").textContent = faces.length === 0
          ? "얼굴을 찾지 못했어요. 직접 맞춰 적용할 수 있어요. 사진 변형은 생략돼요."
          : faces.length === 1 ? "얼굴을 찾았어요. 필요하면 위치를 조절해 주세요." : `${faces.length}개의 얼굴을 찾았어요. 사용할 얼굴을 골라 주세요.`;
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
        this.draft!.faceIndex = index; this.align(); this.renderFaces();
      });
      container.append(button);
    });
  }

  private controls() {
    this.el("photo-manual").hidden = !this.analysisPending;
    for (const id of ["photo-zoom", "photo-rotation", "photo-x", "photo-y", "photo-flip", "photo-reset", "photo-landmarks"])
      this.el<HTMLInputElement>(id).disabled = !this.draft || this.busy;
    this.el<HTMLButtonElement>("photo-align").disabled = !this.draft || this.draft.faceIndex < 0 || this.busy;
    this.el<HTMLButtonElement>("photo-apply").disabled = !this.draft || this.busy || (this.draft.faces.length > 1 && this.draft.faceIndex < 0);
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
      const { source, edit, faces, faceIndex } = this.draft;
      ctx.drawImage(renderPhoto(source, edit, false), 0, 0);
      const cropped = renderPhoto(source, edit);
      smallCtx.fillStyle = "#e8bd8b"; smallCtx.beginPath(); smallCtx.arc(72, 72, 72, 0, Math.PI * 2); smallCtx.fill();
      smallCtx.drawImage(cropped, 0, 0, 144, 144);
      const base = defaultTransform(source.width, source.height).scale;
      const zoom = Math.round(edit.scale / base * 100), rotation = Math.round(edit.rotation * 180 / Math.PI);
      this.el<HTMLInputElement>("photo-zoom").max = String(Math.max(800, Math.ceil(zoom / 100) * 100));
      this.el<HTMLInputElement>("photo-zoom").value = String(zoom);
      this.el("photo-zoom-value").textContent = `${zoom}%`;
      this.el<HTMLInputElement>("photo-rotation").value = String(rotation);
      this.el("photo-rotation-value").textContent = `${rotation}°`;
      this.el<HTMLInputElement>("photo-x").value = String(edit.x);
      this.el<HTMLInputElement>("photo-y").value = String(edit.y);
      this.el("photo-flip").setAttribute("aria-pressed", String(edit.flip));
      if (this.el<HTMLInputElement>("photo-landmarks").checked && faceIndex >= 0) {
        ctx.fillStyle = "#d5ff72";
        for (const index of [1, 4, 10, 33, 61, 133, 152, 168, 263, 291, 362]) {
          const p = transformPoint(faces[faceIndex][index], { x: source.width, y: source.height }, edit);
          ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.fillStyle = "rgba(21,31,25,.62)";
    ctx.beginPath(); ctx.rect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, PHOTO_SIZE * MASK_RADIUS, 0, Math.PI * 2, true); ctx.fill("evenodd");
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, PHOTO_SIZE * MASK_RADIUS, 0, Math.PI * 2); ctx.stroke();
  }

  private async apply() {
    if (!this.draft || this.busy) return;
    const id = ++this.generation, draft = { ...this.draft, edit: { ...this.draft.edit } };
    this.busy = true; this.controls(); this.renderFaces();
    this.el("photo-status").textContent = "고화질 얼굴과 충격에 쓸 사진을 준비하고 있어요…";
    const current = () => id === this.generation && this.open;
    try {
      const landmarks = (draft.faces[draft.faceIndex] ?? []).map((p) =>
        transformPoint(p, { x: draft.source.width, y: draft.source.height }, draft.edit));
      const frame = renderPhoto(draft.source, draft.edit);
      let variants: HTMLCanvasElement[] = [];
      try { variants = await makeVariants(renderPhoto(draft.source, draft.edit, false), landmarks, () => !current()); }
      catch { /* The unmodified photo remains usable if variant generation fails. */ }
      if (!current()) return;
      const photo: AppliedPhoto = { ...draft, frames: [frame, ...variants], landmarks };
      this.actions.apply(photo);
      this.session.current = photo;
      this.close();
    } catch {
      if (!current()) return;
      this.busy = false; this.controls(); this.renderFaces();
      this.el("photo-error").textContent = "사진을 적용하지 못했어요. 다시 적용하거나 취소해 주세요.";
    }
  }

  destroy() {
    this.close(); this.analyzer.destroy(); this.abort.abort(); this.dialog.remove(); this.session.clear();
  }
}
