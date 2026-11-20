import { prepareStoredPhoto } from "../photo/DefaultImages";
import { MAX_BULLET_PHOTOS } from "../photo/ImageConfig";
import { readPhotoCatalog, readSavedPhoto, savedPhotoUrl, type SavedPhoto } from "../photo/PhotoLibrary";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { isWeaponId, weaponPhotoTargets, type ToolId, type WeaponId } from "./WeaponRegistry";
import type { WeaponPhotoTarget } from "./WeaponTypes";

interface WeaponPickerActions {
  select(id: ToolId): boolean;
  edit(id: WeaponPhotoTarget): void;
  apply(id: Exclude<WeaponPhotoTarget, "bullet">, photo: AppliedPhoto): void;
  applyBulletPhotos(photos: readonly AppliedPhoto[]): void;
  photo(id: WeaponPhotoTarget): AppliedPhoto | undefined;
  bulletPhotos(): AppliedPhoto[];
  label(id: WeaponPhotoTarget): string;
  hint(id: WeaponId): string;
  notice(message: string): void;
}

interface PhotoColumn {
  target: WeaponPhotoTarget;
  element: HTMLElement;
  add: HTMLButtonElement;
  list: HTMLElement;
  status: HTMLElement;
}

export class WeaponPicker {
  private readonly strip: HTMLElement;
  private readonly panel: HTMLElement;
  private columns: PhotoColumn[] = [];
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();
  private readonly thumbnails = new WeakMap<HTMLCanvasElement, string>();
  private readonly thumbnailCanvas = document.createElement("canvas");
  private readonly events = new AbortController();
  private readonly layout: ResizeObserver;
  private openId?: WeaponId;
  private listing?: AbortController;
  private applying?: AbortController;

  constructor(private readonly root: HTMLElement, private readonly actions: WeaponPickerActions) {
    this.strip = root.querySelector(".weapon-strip")!;
    this.panel = root.querySelector(".weapon-photo-panel")!;
    this.thumbnailCanvas.width = this.thumbnailCanvas.height = 96;
    const { signal } = this.events;

    for (const button of this.strip.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const id = button.dataset.tool ?? "";
      if (id !== "hand" && !isWeaponId(id)) continue;
      this.buttons.set(id, button);
      button.addEventListener("click", () => {
        if (id === "hand" || this.openId === id) this.select(id);
        else this.open(id);
      }, { signal });
      button.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" && this.openId === id) { event.preventDefault(); this.columns[0]?.add.focus(); }
      }, { signal });
    }
    this.strip.addEventListener("scroll", this.position, { passive: true, signal });
    this.strip.addEventListener("wheel", event => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || this.strip.scrollWidth <= this.strip.clientWidth) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.strip.clientWidth : 1;
      this.strip.scrollLeft += event.deltaY * unit;
    }, { passive: false, signal });
    document.addEventListener("pointerdown", event => {
      if (this.openId && event.target instanceof Node && !this.root.contains(event.target)) this.close();
    }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.openId) { event.preventDefault(); this.close(true); }
    }, { signal });
    window.addEventListener("resize", this.position, { signal });
    window.addEventListener("photo-library-changed", () => {
      if (this.openId && !this.applying) void this.loadPhotos();
    }, { signal });
    this.layout = new ResizeObserver(this.position);
    this.layout.observe(root);
    const frame = root.closest(".playground");
    if (frame) this.layout.observe(frame);
  }

  select(id: ToolId) {
    if (this.actions.select(id)) this.close();
  }

  private open(id: WeaponId) {
    if (this.openId === id) return;
    const button = this.buttons.get(id);
    if (!button) return;
    this.close();
    this.openId = id;
    button.setAttribute("aria-expanded", "true");
    const targets = weaponPhotoTargets(id);
    this.columns = targets.map(target => this.createColumn(target, targets.length > 1));
    this.panel.replaceChildren(...this.columns.map(column => column.element));
    this.panel.dataset.columns = String(this.columns.length);
    this.panel.setAttribute("aria-label", `${this.actions.label(id)} 사진 선택`);
    this.panel.hidden = false;
    this.panel.scrollTop = 0;
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.position();
    if (this.openId === id) void this.loadPhotos();
  }

  private createColumn(target: WeaponPhotoTarget, showTitle: boolean): PhotoColumn {
    const element = document.createElement("section"), label = this.actions.label(target);
    element.className = "weapon-photo-column";
    element.dataset.photoTarget = target;
    element.setAttribute("aria-label", `${label} 사진`);
    element.innerHTML = `<button type="button" class="weapon-photo-add">+</button>
      <p class="weapon-photo-status" role="status"></p><div class="weapon-photo-list"></div>`;
    if (showTitle) {
      const title = document.createElement("div");
      title.className = "weapon-photo-title";
      title.textContent = label;
      element.prepend(title);
    }
    const add = element.querySelector<HTMLButtonElement>(".weapon-photo-add")!;
    add.setAttribute("aria-label", `${label} 사진 편집`);
    add.addEventListener("click", () => {
      this.close(true);
      this.actions.edit(target);
    });
    return { target, element, add, list: element.querySelector(".weapon-photo-list")!, status: element.querySelector(".weapon-photo-status")! };
  }

  sync(mode: ToolId | undefined, enabled: boolean) {
    if (this.openId && !enabled) this.close();
    for (const [id, button] of this.buttons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(id === mode));
      if (!enabled || id === "hand") continue;
      const label = button.querySelector<HTMLElement>(".weapon-tile-label")!;
      const name = this.actions.label(id);
      if (label.textContent !== name) label.textContent = name;
      const hint = this.actions.hint(id);
      if (button.title !== hint) button.title = hint;
      const image = button.querySelector<HTMLImageElement>("img")!;
      const frame = this.actions.photo(id)?.frames[0];
      image.hidden = !frame;
      if (!frame) { image.removeAttribute("src"); continue; }
      let source = this.thumbnails.get(frame);
      if (!source) {
        const canvas = this.thumbnailCanvas, context = canvas.getContext("2d")!;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        source = canvas.toDataURL();
        this.thumbnails.set(frame, source);
      }
      if (image.getAttribute("src") !== source) image.src = source;
    }
  }

  close(restoreFocus = false) {
    const button = this.openId && this.buttons.get(this.openId);
    if (button) {
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus) button.focus({ preventScroll: true });
    }
    this.openId = undefined;
    this.panel.hidden = true;
    this.listing?.abort(); this.listing = undefined;
    this.applying?.abort(); this.applying = undefined;
  }

  private position = () => {
    if (!this.openId) return;
    const trigger = this.buttons.get(this.openId)!.getBoundingClientRect();
    const strip = this.strip.getBoundingClientRect(), root = this.root.getBoundingClientRect();
    if (trigger.right <= strip.left || trigger.left >= strip.right) { this.close(); return; }
    const horizontal = Math.max(0, Math.min(root.width - this.panel.offsetWidth, Math.max(trigger.left, strip.left) - root.left));
    const frame = this.root.closest(".playground")?.getBoundingClientRect();
    const below = Math.min(window.innerHeight, frame?.bottom ?? window.innerHeight) - trigger.bottom - 6;
    const above = trigger.top - Math.max(0, frame?.top ?? 0) - 6;
    this.panel.style.maxHeight = `${Math.max(0, Math.max(below, above))}px`;
    const top = below < this.panel.offsetHeight && above > below
      ? trigger.top - this.panel.offsetHeight - 6 : trigger.bottom + 6;
    this.panel.style.left = `${horizontal}px`;
    this.panel.style.top = `${top - root.top - this.root.clientTop}px`;
  };

  private async loadPhotos() {
    this.listing?.abort();
    const request = this.listing = new AbortController();
    const columns = this.columns;
    for (const column of columns) {
      column.list.replaceChildren();
      column.status.textContent = "사진을 불러오는 중…";
    }
    try {
      const catalog = await readPhotoCatalog(request.signal);
      if (request.signal.aborted) return;
      for (const column of columns) {
        const photos = catalog.filter(photo => photo.name.startsWith(`${column.target}-`));
        for (const photo of photos) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "weapon-photo-option";
          button.title = photo.name; button.dataset.photoPath = photo.path;
          const image = document.createElement("img");
          image.alt = ""; image.src = savedPhotoUrl(photo.path); image.loading = "lazy"; image.decoding = "async";
          const label = document.createElement("span");
          label.textContent = photo.name;
          button.append(image, label);
          button.addEventListener("click", () => void this.applyPhoto(column, photo));
          column.list.append(button);
        }
        this.markSelection(column);
        column.status.textContent = photos.length ? "" : "저장된 사진이 없어요.";
      }
    } catch {
      if (!request.signal.aborted) for (const column of columns) column.status.textContent = "사진 목록을 불러오지 못했어요.";
    }
  }

  private markSelection(column: PhotoColumn) {
    const selected = column.target === "bullet" ? this.actions.bulletPhotos().map(photo => photo.libraryPath)
      : [this.actions.photo(column.target)?.libraryPath];
    for (const button of column.list.querySelectorAll<HTMLButtonElement>("button"))
      button.setAttribute("aria-pressed", String(selected.includes(button.dataset.photoPath)));
  }

  private async applyPhoto(column: PhotoColumn, entry: SavedPhoto) {
    if (this.applying) return;
    const request = this.applying = new AbortController();
    const { target, status } = column;
    status.textContent = "사진을 적용하는 중…";
    try {
      const bullets = target === "bullet" ? this.actions.bulletPhotos() : [];
      const remaining = bullets.filter(photo => photo.libraryPath !== entry.path);
      if (remaining.length < bullets.length) {
        this.actions.applyBulletPhotos(remaining);
        this.markSelection(column);
        status.textContent = "";
        return;
      }
      if (bullets.length >= MAX_BULLET_PHOTOS) throw new Error(`탄알 사진은 최대 ${MAX_BULLET_PHOTOS}장까지 선택할 수 있어요.`);
      const file = await readSavedPhoto(entry, request.signal);
      if (request.signal.aborted) return;
      const photo = await prepareStoredPhoto(file, entry.path, target, request.signal);
      if (request.signal.aborted) return;
      if (target === "bullet") {
        this.actions.applyBulletPhotos([...bullets, photo]);
        this.markSelection(column);
        status.textContent = "";
        return;
      }
      this.actions.apply(target, photo);
      this.close(true);
      this.actions.notice(`새로 소환하는 ${this.actions.label(target)}에 이 사진을 사용해요.`);
    } catch (error) {
      if (!request.signal.aborted) {
        const message = error instanceof Error ? error.message : "사진을 적용하지 못했어요.";
        status.textContent = message;
        this.actions.notice(message);
      }
    } finally {
      if (this.applying === request) this.applying = undefined;
    }
  }

  destroy() { this.close(); this.events.abort(); this.layout.disconnect(); }
}
