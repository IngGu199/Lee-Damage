import { prepareStoredPhoto } from "../photo/DefaultImages";
import { readPhotoCatalog, readSavedPhoto, savedPhotoUrl, type SavedPhoto } from "../photo/PhotoLibrary";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { isWeaponId, type ToolId, type WeaponId } from "./WeaponRegistry";

interface WeaponPickerActions {
  select(id: ToolId): boolean;
  edit(id: WeaponId): void;
  apply(id: WeaponId, photo: AppliedPhoto): void;
  photo(id: WeaponId): AppliedPhoto | undefined;
  label(id: WeaponId): string;
  hint(id: WeaponId): string;
  notice(message: string): void;
}

export class WeaponPicker {
  private readonly strip: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly add: HTMLButtonElement;
  private readonly status: HTMLElement;
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
    this.list = this.panel.querySelector(".weapon-photo-list")!;
    this.add = this.panel.querySelector(".weapon-photo-add")!;
    this.status = this.panel.querySelector(".weapon-photo-status")!;
    this.thumbnailCanvas.width = this.thumbnailCanvas.height = 96;
    const { signal } = this.events;

    for (const button of this.strip.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const id = button.dataset.tool ?? "";
      if (id !== "hand" && !isWeaponId(id)) continue;
      this.buttons.set(id, button);
      button.addEventListener("click", () => {
        if (id !== "hand" && this.openId !== id) {
          this.open(id);
          return;
        }
        if (this.actions.select(id)) this.close();
      }, { signal });
      button.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" && this.openId === id) { event.preventDefault(); this.add.focus(); }
      }, { signal });
    }
    this.add.addEventListener("click", () => {
      const id = this.openId;
      if (!id) return;
      this.close(true);
      this.actions.edit(id);
    }, { signal });
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
      if (this.openId && !this.applying) void this.loadPhotos(this.openId);
    }, { signal });
    this.layout = new ResizeObserver(this.position);
    this.layout.observe(root);
    const frame = root.closest(".playground");
    if (frame) this.layout.observe(frame);
  }

  select(id: ToolId) {
    if (!this.actions.select(id)) return;
    if (id === "hand") { this.close(); return; }
    this.open(id);
  }

  private open(id: WeaponId) {
    if (this.openId === id) return;
    const button = this.buttons.get(id);
    if (!button) return;
    this.close();
    this.openId = id;
    button.setAttribute("aria-expanded", "true");
    const label = this.actions.label(id);
    this.panel.setAttribute("aria-label", `${label} 사진 선택`);
    this.add.setAttribute("aria-label", `${label} 사진 편집`);
    this.panel.hidden = false;
    this.panel.scrollTop = 0;
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.position();
    if (this.openId === id) void this.loadPhotos(id);
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

  private async loadPhotos(id: WeaponId) {
    this.listing?.abort();
    const request = this.listing = new AbortController();
    this.list.replaceChildren();
    this.status.textContent = "사진을 불러오는 중…";
    try {
      const photos = (await readPhotoCatalog(request.signal)).filter(photo => photo.name.startsWith(`${id}-`));
      if (request.signal.aborted) return;
      const current = this.actions.photo(id)?.libraryPath;
      for (const photo of photos) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "weapon-photo-option";
        button.title = photo.name; button.setAttribute("aria-pressed", String(photo.path === current));
        const image = document.createElement("img");
        image.alt = ""; image.src = savedPhotoUrl(photo.path); image.loading = "lazy"; image.decoding = "async";
        const label = document.createElement("span");
        label.textContent = photo.name;
        button.append(image, label);
        button.addEventListener("click", () => void this.applyPhoto(id, photo));
        this.list.append(button);
      }
      this.status.textContent = photos.length ? "" : "저장된 사진이 없어요.";
    } catch {
      if (!request.signal.aborted) this.status.textContent = "사진 목록을 불러오지 못했어요.";
    }
  }

  private async applyPhoto(id: WeaponId, entry: SavedPhoto) {
    this.applying?.abort();
    const request = this.applying = new AbortController();
    this.status.textContent = "사진을 적용하는 중…";
    try {
      const file = await readSavedPhoto(entry, request.signal);
      if (request.signal.aborted) return;
      const photo = await prepareStoredPhoto(file, entry.path, id, request.signal);
      if (request.signal.aborted) return;
      this.actions.apply(id, photo);
      this.close(true);
      this.actions.notice(`새로 소환하는 ${this.actions.label(id)}에 이 사진을 사용해요.`);
    } catch (error) {
      if (!request.signal.aborted) {
        const message = error instanceof Error ? error.message : "사진을 적용하지 못했어요.";
        this.status.textContent = message;
        this.actions.notice(message);
      }
    } finally {
      if (this.applying === request) this.applying = undefined;
    }
  }

  destroy() { this.close(); this.events.abort(); this.layout.disconnect(); }
}
