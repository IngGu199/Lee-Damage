import Phaser from "phaser";
import "@fontsource-variable/noto-sans-kr";
import "./style.css";
import { PhysicsScene } from "./game/PhysicsScene";
import { PhotoSession } from "./photo/PhotoSession";
import { PhotoEditor } from "./photo/PhotoEditor";
import { PHOTO_BASE_SIZE } from "./game/appearanceConfig";
import { DAMAGE_RULES } from "./game/damageConfig";
import { DEFAULT_SETTINGS, ROOM, type LabStats } from "./game/config";
import { weaponFrame, type WeaponPhotoTarget } from "./weapons/WeaponSkins";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main class="playground" id="playground" aria-label="충돌 실험실">
    <header class="toolbar">
      <a class="brand" href="./" aria-label="Lee Damage 홈"><span class="brand-mark">L↗</span><span>LEE DAMAGE</span></a>
      <div class="sliders">
        <div class="toolbar-control sound-panel">
          <label id="sound-title" for="sound-volume">효과음</label>
          <input id="sound-volume" type="range" min="0" max="100" value="100" aria-label="효과음 음량">
          <output id="sound-volume-value" for="sound-volume">100%</output>
          <label class="sound-mute" title="효과음 음소거"><input id="sound-muted" type="checkbox" aria-label="음소거"><span aria-hidden="true">음소거</span></label>
        </div>
        <div class="toolbar-control damage-panel">
          <label for="damage-limit">최대 데미지</label>
          <input id="damage-limit" type="number" min="-1" step="1" value="${DAMAGE_RULES.maxCollisionDamage}" aria-label="최대 데미지" aria-describedby="damage-limit-value" title="0: 무적 · -1: JSON의 조건별 상한 사용 · 양수: 모든 타격에 우선 적용">
          <output id="damage-limit-value" for="damage-limit">상한</output>
        </div>
      </div>
      <div class="play-actions">
        <button id="spawn" disabled>인형 추가 <kbd>T</kbd></button>
        <button id="force-burst" title="선택한 인형의 체력을 0으로 만듭니다" disabled>강제 폭파 <kbd>B</kbd></button>
        <button id="photo-open" class="photo-primary" disabled>사진 추가</button>
        <button id="pause" class="icon-button" aria-label="일시정지" disabled>Ⅱ</button>
        <button id="reset" disabled><span aria-hidden="true">↻</span> 재배치 <kbd>R</kbd></button>
      </div>
      <div class="weapon-tools" role="toolbar" aria-label="무기 선택">
        <button data-tool="hand" aria-pressed="true" disabled title="인형·잔해·바닥에 놓인 무기 잡기">손 <kbd>1</kbd></button>
        <button data-tool="bat" aria-pressed="false" disabled title="누를 때마다 방망이 생성 · 좌클릭을 누른 채 잡기 · 우클릭마다 15° 회전 · 잡은 무기 삭제 X">야구방망이 <kbd>2</kbd></button>
        <button data-tool="hammer" aria-pressed="false" disabled title="누를 때마다 망치 생성 · 원하는 지점을 클릭해 잡기 · 잡은 무기 삭제 X">망치 <kbd>3</kbd></button>
        <button data-tool="gun" aria-pressed="false" disabled title="누를 때마다 마우스 위치에 총 생성 · 좌클릭으로 모든 총 발사 · 다른 도구를 선택하면 총 일괄 삭제">총 <kbd>4</kbd></button>
        <button id="clear-weapons" disabled title="방 안의 무기와 비행 중인 탄알을 모두 삭제 · 잡은 물건만 삭제하려면 X">무기 모두 삭제 <kbd>C</kbd></button>
        <div class="weapon-photo-controls">
          <label class="sr-only" for="weapon-photo-target">사진을 적용할 무기</label>
          <select id="weapon-photo-target"><option value="bat">야구방망이</option><option value="hammer">망치</option><option value="gun">총</option><option value="bullet">탄알</option></select>
          <button id="weapon-photo-open" disabled>무기 사진</button>
        </div>
      </div>
    </header>
    <div class="canvas-wrap">
      <div id="game"></div>
      <div id="loading" class="game-overlay">방을 준비하고 있어요…</div>
      <div id="pause-overlay" class="game-overlay" hidden><span class="pause-symbol">Ⅱ</span><strong>잠깐 쉬는 중</strong><button id="resume">계속하기</button></div>
    </div>
    <button id="resize-playground" class="resize-handle" aria-label="화면 크기 조절" title="드래그하여 크기 조절 · 두 번 누르면 화면에 맞춤">◢</button>
  </main>
  <p id="sound-state" class="sr-only" role="status" aria-live="polite"></p>
  <p id="notice" class="notice" role="status" aria-live="polite"></p>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = new PhysicsScene();
const photoSession = new PhotoSession();
const photoEditor = new PhotoEditor(photoSession, {
  begin: () => scene.beginPhotoEdit(), end: () => scene.endPhotoEdit(),
  apply: photo => scene.applyPhoto(photo),
  clear: () => { photoSession.clear(); scene.clearPhoto(); },
  previewSize: () => scene.game.canvas.getBoundingClientRect().width / ROOM.width * Math.max(PHOTO_BASE_SIZE, scene.face.displaySize),
});
const weaponEditors = new Map<WeaponPhotoTarget, PhotoEditor>();
const weaponPhotoEditor = (id: WeaponPhotoTarget) => {
  let editor = weaponEditors.get(id);
  if (!editor) {
    const session = new PhotoSession(), label = id === "bullet" ? "탄알" : scene.weapons.config.weapons[id].label;
    editor = new PhotoEditor(session, {
      begin: () => scene.beginPhotoEdit(), end: () => scene.endPhotoEdit(),
      apply: photo => { scene.weapons.applyPhoto(id, photo); scene.onNotice(`${label} 사진과 충돌 윤곽을 적용했어요.`); },
      clear: () => { scene.weapons.applyPhoto(id, null); scene.onNotice(`${label}을 기본 도형으로 되돌렸어요.`); },
      previewSize: () => Math.min(190, weaponFrame(scene.weapons.config, id).size * scene.game.canvas.getBoundingClientRect().width / ROOM.width),
    }, { id, label, mask: () => scene.weapons.skins.mask(scene.weapons.config, id) });
    weaponEditors.set(id, editor);
  }
  return editor;
};
let ready = false;
scene.onToolState = () => {
  element<HTMLButtonElement>("weapon-photo-open").disabled = !scene.weapons?.loaded;
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.disabled = !scene.weapons?.loaded || scene.paused;
    button.setAttribute("aria-pressed", String(button.dataset.tool === scene.weapons?.mode));
    if (button.dataset.tool !== "hand" && scene.weapons?.loaded) {
      const label = scene.weapons.config.weapons[button.dataset.tool as "bat" | "hammer" | "gun"].label;
      button.firstChild!.textContent = `${label} `;
      if (button.dataset.tool === "bat") button.title = `누를 때마다 방망이 생성 · 좌클릭을 누른 채 잡기 · 우클릭마다 ${scene.weapons.config.weapons.bat.handling.rotateStepDegrees}° 회전 · 잡은 무기 삭제 X`;
    }
  }
  element<HTMLButtonElement>("clear-weapons").disabled = !scene.weapons?.loaded || scene.paused || !scene.weapons.hasWeapons;
};
scene.onStats = (stats: LabStats) => {
  scene.onToolState();
  element<HTMLButtonElement>("spawn").disabled = stats.paused || stats.aliveCount >= stats.maxRagdolls;
  element<HTMLButtonElement>("force-burst").disabled = stats.paused || !scene.selectedActor?.lifecycle.interactive;
  element("photo-open").textContent = scene.face?.active ? "사진 편집" : "사진 추가";
  element("pause-overlay").hidden = !stats.paused;
  element("pause").textContent = stats.paused ? "▷" : "Ⅱ";
  element("pause").setAttribute("aria-label", stats.paused ? "계속하기" : "일시정지");
};
scene.onAudioState = () => {
  const audio = scene.audio.snapshot();
  element<HTMLInputElement>("sound-volume").value = String(Math.round(audio.volume * 100));
  element("sound-volume-value").textContent = `${Math.round(audio.volume * 100)}%`;
  element<HTMLInputElement>("sound-muted").checked = audio.muted;
  element("sound-state").textContent = audio.state === "loading" ? "효과음을 준비하고 있어요."
    : audio.state === "disabled" ? "효과음을 사용할 수 없어요. 소리 없이 계속할 수 있어요."
    : audio.muted || audio.volume === 0 ? "소리를 껐어요."
    : audio.locked ? "화면을 클릭하거나 키를 누르면 소리가 켜져요."
    : audio.state === "partial" ? "일부 효과음을 불러오지 못했어요. 준비된 소리로 진행해요."
    : "충돌 속도에 따라 소리 크기가 달라져요.";
};
let noticeTimer: ReturnType<typeof setTimeout>;
scene.onNotice = message => {
  element("notice").textContent = message;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { element("notice").textContent = ""; }, 3500);
};
scene.onReady = () => {
  ready = true; element("loading").hidden = true;
  app.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; });
  scene.configure({ ...DEFAULT_SETTINGS }); scene.onAudioState();
};
element("photo-open").addEventListener("click", () => photoEditor.show());
element("weapon-photo-open").addEventListener("click", () => {
  if (scene.weapons.loaded) weaponPhotoEditor(element<HTMLSelectElement>("weapon-photo-target").value as WeaponPhotoTarget).show();
});
element("spawn").addEventListener("click", () => scene.spawnRagdoll());
element("force-burst").addEventListener("click", () => scene.forceBurst());
element("pause").addEventListener("click", () => scene.setPaused(!scene.paused));
element("resume").addEventListener("click", () => scene.setPaused(false));
element("reset").addEventListener("click", () => scene.reset());
element("clear-weapons").addEventListener("click", () => scene.weapons.clearWeapons());
for (const button of app.querySelectorAll<HTMLButtonElement>("[data-tool]"))
  button.addEventListener("click", () => scene.selectTool(button.dataset.tool as "hand" | "bat" | "hammer" | "gun"));
element<HTMLInputElement>("sound-volume").addEventListener("input", event => {
  if (ready) scene.audio.setVolume(Number((event.target as HTMLInputElement).value) / 100);
});
element<HTMLInputElement>("sound-muted").addEventListener("change", event => {
  if (ready) scene.audio.setMuted((event.target as HTMLInputElement).checked);
});
const damageInput = element<HTMLInputElement>("damage-limit");
const updateDamageLimit = () => {
  const value = damageInput.valueAsNumber;
  // Preserve the setting while typing an empty field, a minus, or an invalid value.
  if (!damageInput.validity.valid || !Number.isFinite(value)) return;
  scene.setMaxDamage(value);
  element("damage-limit-value").textContent = value === -1 ? "JSON" : value === 0 ? "무적" : "상한";
  damageInput.setAttribute("aria-valuetext", value === -1 ? "JSON의 조건별 상한 적용" : value === 0 ? "무적" : `최대 ${value}`);
};
damageInput.addEventListener("input", updateDamageLimit);
damageInput.addEventListener("blur", () => { damageInput.value = String(scene.maxDamage); updateDamageLimit(); });
window.addEventListener("keydown", event => {
  if (!ready || photoEditor.open || [...weaponEditors.values()].some(editor => editor.open) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (!target.closest("input, select, textarea, [contenteditable]")) {
    const tools = { Digit1: "hand", Digit2: "bat", Digit3: "hammer", Digit4: "gun" } as const;
    const tool = tools[event.code as keyof typeof tools];
    if (tool) { event.preventDefault(); scene.selectTool(tool); return; }
    if (event.code === "KeyX") { event.preventDefault(); scene.weapons.deleteHeld(); return; }
    if (event.code === "KeyC") { event.preventDefault(); scene.weapons.clearWeapons(); return; }
  }
  if (event.code === "KeyT" && !target.closest("input, select, textarea, [contenteditable]")) {
    event.preventDefault(); scene.spawnRagdoll(); return;
  }
  if (event.code === "KeyB" && !target.closest("input, select, textarea, [contenteditable]")) {
    event.preventDefault(); scene.forceBurst(); return;
  }
  if (target.closest("input, button, a, select, textarea, [contenteditable]")) return;
  if (event.code === "KeyR") scene.reset();
  if (event.code === "Space") { event.preventDefault(); scene.setPaused(!scene.paused); }
});

const frame = element("playground"), handle = element("resize-playground");
let drag: { id: number; x: number; y: number; width: number; height: number } | undefined;
const sizeFrame = (width: number, height: number) => {
  const bounds = app.getBoundingClientRect();
  frame.style.width = `${Math.max(Math.min(620, bounds.width), Math.min(bounds.width, width))}px`;
  frame.style.height = `${Math.max(Math.min(360, bounds.height), Math.min(bounds.height, height))}px`;
};
handle.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault(); handle.setPointerCapture(event.pointerId);
  const bounds = frame.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
});
handle.addEventListener("pointermove", event => {
  if (drag?.id === event.pointerId) sizeFrame(drag.width + event.clientX - drag.x, drag.height + event.clientY - drag.y);
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(name, () => { drag = undefined; });
const fitFrame = () => { frame.style.width = ""; frame.style.height = ""; };
handle.addEventListener("dblclick", fitFrame);
handle.addEventListener("keydown", event => {
  if (event.key === "Home") { event.preventDefault(); fitFrame(); }
  const offsets: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
  if (offsets[event.key]) {
    event.preventDefault(); const bounds = frame.getBoundingClientRect(), [x, y] = offsets[event.key];
    sizeFrame(bounds.width + x, bounds.height + y);
  }
});
window.addEventListener("resize", () => {
  if (frame.style.width) { const bounds = frame.getBoundingClientRect(); sizeFrame(bounds.width, bounds.height); }
});

await document.fonts.load('400 20px "Noto Sans KR Variable"');
const game = new Phaser.Game({
  type: Phaser.AUTO, parent: "game", width: ROOM.width, height: ROOM.height,
  backgroundColor: "#f8f9f4", antialias: true,
  scale: { mode: Phaser.Scale.RESIZE },
  physics: { default: "matter", matter: { gravity: { x: 0, y: DEFAULT_SETTINGS.gravity },
    positionIterations: 10, velocityIterations: 8, constraintIterations: 24, enableSleeping: false } },
  scene: [scene],
});
const observer = new ResizeObserver(entries => {
  const { width, height } = entries[0].contentRect;
  if (width > 0 && height > 0 && (game.scale.width !== Math.round(width) || game.scale.height !== Math.round(height)))
    game.scale.resize(Math.round(width), Math.round(height));
  photoEditor.refreshPreview();
  for (const editor of weaponEditors.values()) editor.refreshPreview();
});
observer.observe(element("game"));
window.addEventListener("pagehide", event => {
  if (!(event as PageTransitionEvent).persisted) {
    photoEditor.destroy(); for (const editor of weaponEditors.values()) editor.destroy();
    observer.disconnect(); clearTimeout(noticeTimer);
  }
});
if (new URLSearchParams(location.search).has("diagnostics")) Object.assign(window, { __physicsLab: scene });
