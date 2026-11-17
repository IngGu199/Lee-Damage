import Phaser from "phaser";
import "@fontsource-variable/noto-sans-kr";
import "./style.css";
import { PhysicsScene } from "./game/PhysicsScene";
import { PhotoSession } from "./photo/PhotoSession";
import { PhotoEditor } from "./photo/PhotoEditor";
import { PHOTO_BASE_SIZE } from "./game/appearanceConfig";
import { DAMAGE_RULES } from "./game/damageConfig";
import { DEFAULT_SETTINGS, ROOM, type LabStats } from "./game/config";

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
          <input id="damage-limit" type="range" min="0" max="${DAMAGE_RULES.maxCollisionDamage}" step="1" value="${DAMAGE_RULES.maxCollisionDamage}" aria-label="최대 데미지">
          <output id="damage-limit-value" for="damage-limit">${DAMAGE_RULES.maxCollisionDamage}</output>
        </div>
      </div>
      <div class="play-actions">
        <button id="spawn" disabled>인형 추가 <kbd>T</kbd></button>
        <button id="force-burst" title="선택한 인형의 체력을 0으로 만듭니다" disabled>강제 폭파 <kbd>B</kbd></button>
        <button id="photo-open" class="photo-primary" disabled>사진 추가</button>
        <button id="pause" class="icon-button" aria-label="일시정지" disabled>Ⅱ</button>
        <button id="reset" disabled><span aria-hidden="true">↻</span> 재배치 <kbd>R</kbd></button>
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
let ready = false;
scene.onStats = (stats: LabStats) => {
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
element("spawn").addEventListener("click", () => scene.spawnRagdoll());
element("force-burst").addEventListener("click", () => scene.forceBurst());
element("pause").addEventListener("click", () => scene.setPaused(!scene.paused));
element("resume").addEventListener("click", () => scene.setPaused(false));
element("reset").addEventListener("click", () => scene.reset());
element<HTMLInputElement>("sound-volume").addEventListener("input", event => {
  if (ready) scene.audio.setVolume(Number((event.target as HTMLInputElement).value) / 100);
});
element<HTMLInputElement>("sound-muted").addEventListener("change", event => {
  if (ready) scene.audio.setMuted((event.target as HTMLInputElement).checked);
});
element<HTMLInputElement>("damage-limit").addEventListener("input", event => {
  const value = Number((event.target as HTMLInputElement).value);
  element("damage-limit-value").textContent = value === 0 ? "무적" : String(value);
  element("damage-limit").setAttribute("aria-valuetext", value === 0 ? "무적" : `최대 ${value}`);
  scene.setMaxDamage(value);
});
window.addEventListener("keydown", event => {
  if (!ready || photoEditor.open || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
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
});
observer.observe(element("game"));
window.addEventListener("pagehide", event => {
  if (!(event as PageTransitionEvent).persisted) { photoEditor.destroy(); observer.disconnect(); clearTimeout(noticeTimer); }
});
if (new URLSearchParams(location.search).has("diagnostics")) Object.assign(window, { __physicsLab: scene });
