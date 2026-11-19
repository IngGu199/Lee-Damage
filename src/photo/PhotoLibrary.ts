export interface SavedPhoto { path: string; name: string }

function assetUrl(path: string) {
  return `${import.meta.env.BASE_URL}${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function readSavedPhoto(entry: SavedPhoto, signal: AbortSignal) {
  const response = await fetch(assetUrl(entry.path), { cache: "no-store", signal });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/"))
    throw new Error("저장된 사진이 없어요. 목록을 새로고침해 주세요.");
  const blob = await response.blob();
  return new File([blob], entry.name, { type: blob.type });
}

/** Both development and static builds expose the same read-only catalog. */
export class PhotoLibrary {
  private readonly grid: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly abort = new AbortController();
  private listing?: AbortController;
  private selection?: AbortController;
  private visible = false;
  private selectedPaths = new Set<string>();

  constructor(container: HTMLElement, private readonly target: string,
    private readonly select: (file: File, entry: SavedPhoto) => Promise<void>,
    private readonly chooseForBatch?: (entry: SavedPhoto) => void) {
    container.innerHTML = `<div class="photo-library-heading"><strong>저장된 사진</strong><button type="button">목록 새로고침</button></div>
      <p class="photo-library-status" role="status" aria-live="polite"></p>
      <div class="photo-library-grid" role="group" aria-label="public/images에 저장된 사진"></div>`;
    this.grid = container.querySelector(".photo-library-grid")!;
    this.status = container.querySelector(".photo-library-status")!;
    this.refreshButton = container.querySelector("button")!;
    this.refreshButton.addEventListener("click", () => void this.refresh(), { signal: this.abort.signal });
    window.addEventListener("photo-library-changed", () => { if (this.visible) void this.refresh(); }, { signal: this.abort.signal });
  }
  open(paths: readonly string[] = []) { this.visible = true; this.setSelection(paths); void this.refresh(); }
  close() { this.visible = false; this.listing?.abort(); this.cancelSelection(); }
  cancelSelection() { this.selection?.abort(); }
  clearSelection() { this.cancelSelection(); this.setSelection([]); }
  setSelection(paths: readonly string[]) { this.selectedPaths = new Set(paths); this.markSelected(); }

  private markSelected() {
    for (const button of this.grid.querySelectorAll<HTMLButtonElement>("button"))
      button.setAttribute("aria-pressed", String(this.selectedPaths.has(button.dataset.photoPath!)));
  }
  private async refresh() {
    this.listing?.abort(); const request = this.listing = new AbortController();
    this.refreshButton.disabled = true; this.status.textContent = "사진 목록을 불러오고 있어요…";
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}images/catalog.json`, { cache: "no-store", signal: request.signal });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error();
      const catalog = await response.json();
      if (catalog.version !== 1 || !Array.isArray(catalog.images)) throw new Error();
      const images: SavedPhoto[] = catalog.images;
      if (!images.every(entry => entry && typeof entry.path === "string" && typeof entry.name === "string" &&
        entry.path.startsWith("images/") && /\.(png|jpe?g|webp)$/i.test(entry.path) && !entry.path.includes("\\") &&
        entry.path.split("/").every(part => part && part !== "." && part !== ".."))) throw new Error();
      if (request.signal.aborted || !this.visible) return;
      images.sort((a, b) => Number(b.name.startsWith(`${this.target}-`)) - Number(a.name.startsWith(`${this.target}-`)));
      const fragment = document.createDocumentFragment();
      for (const entry of images) {
        const button = document.createElement("button"); button.type = "button"; button.dataset.photoPath = entry.path;
        button.title = entry.path; button.setAttribute("aria-label", `저장된 사진 선택: ${entry.name}`);
        const image = document.createElement("img"); image.src = assetUrl(entry.path); image.alt = ""; image.loading = "lazy"; image.decoding = "async";
        const name = document.createElement("span"); name.textContent = entry.name;
        button.append(image, name); button.addEventListener("click", () => void this.choose(entry)); fragment.append(button);
      }
      this.grid.replaceChildren(fragment); this.markSelected();
      this.status.textContent = images.length ? this.chooseForBatch ? `${images.length}장 · 사진을 누를 때마다 탄알 목록에 추가돼요.`
        : `${images.length}장 · 사진을 눌러 바로 불러오세요.`
        : "저장된 사진이 없어요. public/images에 사진을 넣거나 아래에서 새 사진을 추가해 주세요.";
    } catch {
      if (!request.signal.aborted && this.visible) this.status.textContent = "사진 목록을 불러오지 못했어요. 목록 새로고침을 눌러 주세요.";
    } finally { if (!request.signal.aborted) this.refreshButton.disabled = false; }
  }
  private async choose(entry: SavedPhoto) {
    if (this.chooseForBatch) { this.chooseForBatch(entry); return; }
    this.cancelSelection(); const request = this.selection = new AbortController();
    this.status.textContent = `${entry.name} 사진을 불러오고 있어요…`;
    try {
      const file = await readSavedPhoto(entry, request.signal);
      if (request.signal.aborted || !this.visible) return;
      this.setSelection([entry.path]);
      await this.select(file, entry);
      if (!request.signal.aborted && this.visible) this.status.textContent = `${entry.name} 사진을 불러왔어요.`;
    } catch (error) {
      if (!request.signal.aborted && this.visible) this.status.textContent = error instanceof Error ? error.message : "사진을 불러오지 못했어요.";
    }
  }
  destroy() { this.close(); this.abort.abort(); this.grid.replaceChildren(); }
}
