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
import { emptyDefaultPhotos, loadDefaultImages } from "./photo/DefaultImages";
import { DEFAULT_WEAPON_CONFIG } from "./weapons/WeaponConfig";
import { WEAPON_REGISTRY, WEAPON_IDS, toolForShortcut, weaponPhotoTargets, weaponRegistration } from "./weapons/WeaponRegistry";
import { WeaponPicker } from "./weapons/WeaponPicker";
import { weaponSizeMax } from "./weapons/WeaponTypes";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main class="playground" id="playground" aria-label="충돌 실험실">
    <header class="toolbar">
      <a class="brand" href="./" aria-label="Picture Damage 홈"><span class="brand-mark">L↗</span><span>PICTURE DAMAGE</span></a>
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
          <output id="damage-limit-value" for="damage-limit">JSON</output>
        </div>
        <div class="toolbar-control weapon-size-panel">
          <label id="weapon-size-label" for="weapon-size">무기 크기</label>
          <input id="weapon-size" type="range" min="10" max="300" step="1" value="100" disabled>
          <output id="weapon-size-value" for="weapon-size">선택</output>
        </div>
        <div id="bullet-size-panel" class="toolbar-control weapon-size-panel" hidden>
          <label id="bullet-size-label" for="bullet-size">발사체 크기</label>
          <input id="bullet-size" type="range" min="10" max="300" step="1" value="100" disabled>
          <output id="bullet-size-value" for="bullet-size">100%</output>
        </div>
      </div>
      <div class="play-actions">
        <button id="spawn" disabled>인형 추가 <kbd>T</kbd></button>
        <button id="force-burst" title="선택한 인형의 체력을 0으로 만듭니다" disabled>강제 폭파 <kbd>B</kbd></button>
        <button id="photo-open" class="photo-primary" disabled>사진 추가</button>
        <button id="pause" class="icon-button" aria-label="일시정지" disabled>Ⅱ</button>
        <button id="reset" disabled><span aria-hidden="true">↻</span> 재배치 <kbd>R</kbd></button>
      </div>
      <div class="weapon-tools" id="weapon-picker" role="group" aria-label="무기 도구">
        <div class="weapon-strip" role="group" aria-label="무기 선택">
          <button type="button" class="weapon-tile" data-tool="hand" aria-pressed="true" disabled title="인형·잔해·바닥에 놓인 무기 잡기"><span class="weapon-tile-label">손</span><kbd>1</kbd></button>
          ${WEAPON_REGISTRY.map(weapon => `<button type="button" class="weapon-tile" data-tool="${weapon.id}" aria-pressed="false" aria-expanded="false" aria-controls="weapon-photo-panel" disabled title="${weapon.behavior.hint(DEFAULT_WEAPON_CONFIG.weapons[weapon.id])}"><img alt="" hidden><span class="weapon-tile-label">${weapon.label}</span><kbd>${weapon.keyLabel}</kbd></button>`).join("")}
        </div>
        <div class="weapon-photo-panel" id="weapon-photo-panel" role="group" aria-label="무기 사진 선택" hidden></div>
        <button id="clear-weapons" disabled title="방 안의 무기와 비행 중인 탄알을 모두 삭제 · 잡은 물건만 삭제하려면 X">무기 모두 삭제 <kbd>C</kbd></button>
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
const defaultImageAbort = new AbortController();
const defaultImagesReady = loadDefaultImages(defaultImageAbort.signal);
let defaultPhotos = emptyDefaultPhotos();
const photoSession = new PhotoSession();
const photoEditor = new PhotoEditor(photoSession, {
  begin: () => scene.beginPhotoEdit(), end: () => scene.endPhotoEdit(),
  apply: photo => scene.applyPhoto(photo),
  clear: () => {
    photoSession.current = defaultPhotos.face;
    if (defaultPhotos.face) scene.applyPhoto(defaultPhotos.face, false); else scene.clearPhoto();
  },
  previewSize: () => scene.game.canvas.getBoundingClientRect().width / ROOM.width * Math.max(PHOTO_BASE_SIZE, scene.face.displaySize),
});
const weaponEditors = new Map<WeaponPhotoTarget, PhotoEditor>();
const weaponPhotoLabel = (id: WeaponPhotoTarget) => id === "bullet" ? "탄알"
  : id === "bomber" ? "폭탄마" : scene.weapons.config.weapons[id].label;
const weaponPhotoEditor = (id: WeaponPhotoTarget) => {
  let editor = weaponEditors.get(id);
  if (!editor) {
    const session = new PhotoSession();
    const label = weaponPhotoLabel(id);
    session.current = scene.weapons.skins.get(id)?.photo ?? null;
    const shared = {
      begin: () => scene.beginPhotoEdit(), end: () => scene.endPhotoEdit(),
      previewSize: () => Math.min(190, weaponFrame(scene.weapons.config, id).size * scene.game.canvas.getBoundingClientRect().width / ROOM.width),
    };
    const asset = { id, label, mask: () => scene.weapons.skins.mask(scene.weapons.config, id) };
    editor = id === "bullet" ? new PhotoEditor(session, { ...shared,
      batch: {
        current: () => scene.weapons.skins.bulletPhotos(),
        apply: photos => {
          scene.weapons.applyBulletPhotos(photos);
          scene.onNotice(photos.length ? `탄알 사진 ${photos.length}장을 적용했어요.` : "탄알을 기본 도형으로 변경했어요.");
        },
      },
      clear: () => {
        scene.weapons.applyBulletPhotos(defaultPhotos.bullet);
        scene.onNotice("탄알을 기본 설정으로 되돌렸어요.");
      },
      clearLabel: () => defaultPhotos.bullet.length ? "기본 이미지로" : "기본 도형으로",
    }, asset) : new PhotoEditor(session, { ...shared,
      apply: photo => { scene.weapons.applyPhoto(id, photo); scene.onNotice(`새로 소환하는 ${label}에 이 사진을 사용해요.`); },
      clear: () => {
        session.current = defaultPhotos[id];
        scene.weapons.applyPhoto(id, defaultPhotos[id]);
        scene.onNotice(`새로 소환하는 ${label}에 기본 ${defaultPhotos[id] ? "이미지" : "도형"}을 사용해요.`);
      },
      clearLabel: () => defaultPhotos[id] ? "기본 이미지로" : "기본 도형으로",
    }, asset);
    weaponEditors.set(id, editor);
  }
  return editor;
};
let ready = false;
const sizeControls = [
  { input: element<HTMLInputElement>("weapon-size"), label: element("weapon-size-label"),
    output: element("weapon-size-value"), defaultLabel: "무기 크기" },
  { input: element<HTMLInputElement>("bullet-size"), label: element("bullet-size-label"),
    output: element("bullet-size-value"), defaultLabel: "발사체 크기" },
] as const;
const selectedSizeTargets = () => {
  const mode = scene.weapons?.mode;
  return ready && scene.weapons?.loaded && mode && mode !== "hand" ? weaponPhotoTargets(mode) : [] as const;
};
const weaponPicker = new WeaponPicker(element("weapon-picker"), {
  select: id => ready && scene.selectTool(id),
  edit: id => weaponPhotoEditor(id).show(scene.weapons.skins.get(id)?.photo ?? null),
  apply: (id, photo) => scene.weapons.applyPhoto(id, photo),
  applyBulletPhotos: photos => scene.weapons.applyBulletPhotos(photos),
  photo: id => scene.weapons?.skins.get(id)?.photo,
  bulletPhotos: () => scene.weapons.skins.bulletPhotos(),
  label: weaponPhotoLabel,
  hint: id => weaponRegistration(id).behavior.hint(scene.weapons.config.weapons[id]),
  notice: message => scene.onNotice(message),
});
scene.onToolState = () => {
  weaponPicker.sync(scene.weapons?.mode, ready && Boolean(scene.weapons?.loaded) && !scene.paused);
  const targets = selectedSizeTargets();
  element("bullet-size-panel").hidden = targets.length < 2;
  sizeControls.forEach(({ input, label, output, defaultLabel }, index) => {
    const target = targets[index];
    input.disabled = !target || scene.paused;
    if (target) {
      const percent = scene.weapons.sizePercent(target);
      input.max = String(weaponSizeMax(target));
      input.value = String(percent);
      input.setAttribute("aria-valuetext", `${percent}%`);
      label.textContent = `${weaponPhotoLabel(target)} 크기`;
      output.textContent = `${percent}%`;
    } else {
      input.removeAttribute("aria-valuetext");
      label.textContent = defaultLabel;
      output.textContent = "선택";
    }
  });
  element<HTMLButtonElement>("clear-weapons").disabled = !scene.weapons?.loaded || scene.paused || !scene.weapons.hasWeapons;
};
scene.onStats = (stats: LabStats) => {
  scene.onToolState();
  element<HTMLButtonElement>("spawn").disabled = !ready || stats.paused || stats.aliveCount >= stats.maxRagdolls;
  element<HTMLButtonElement>("force-burst").disabled = !ready || stats.paused || !scene.selectedActor?.lifecycle.interactive;
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
  scene.configure({ ...DEFAULT_SETTINGS }); scene.onAudioState();
  scene.events.once("shutdown", () => defaultImageAbort.abort());
  void (async () => {
    const [, photos] = await Promise.all([scene.weapons.ready, defaultImagesReady]);
    if (defaultImageAbort.signal.aborted) return;
    defaultPhotos = photos;
    photoSession.current = photos.face;
    if (photos.face) scene.applyPhoto(photos.face, false);
    for (const id of [...WEAPON_IDS, "bomber"] as const) {
      if (!photos[id]) continue;
      try { scene.weapons.applyPhoto(id, photos[id]); }
      catch (error) { defaultPhotos[id] = null; console.warn(`기본 이미지 ${id}: 기본 도형을 사용합니다.`, error); }
    }
    if (photos.bullet.length) {
      try { scene.weapons.applyBulletPhotos(photos.bullet); }
      catch (error) { photos.bullet = []; console.warn("기본 탄알 이미지: 기본 도형을 사용합니다.", error); }
    }
    ready = true; element("loading").hidden = true;
    app.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; });
    scene.onStats(scene.snapshot());
  })();
};
element("photo-open").addEventListener("click", () => photoEditor.show());
element("spawn").addEventListener("click", () => scene.spawnRagdoll());
element("force-burst").addEventListener("click", () => scene.forceBurst());
element("pause").addEventListener("click", () => scene.setPaused(!scene.paused));
element("resume").addEventListener("click", () => scene.setPaused(false));
element("reset").addEventListener("click", () => scene.reset());
element("clear-weapons").addEventListener("click", () => scene.weapons.clearWeapons());
element<HTMLInputElement>("sound-volume").addEventListener("input", event => {
  if (ready) scene.audio.setVolume(Number((event.target as HTMLInputElement).value) / 100);
});
element<HTMLInputElement>("sound-muted").addEventListener("change", event => {
  if (ready) scene.audio.setMuted((event.target as HTMLInputElement).checked);
});
sizeControls.forEach(({ input }, index) => {
  input.addEventListener("input", () => {
    const target = selectedSizeTargets()[index];
    if (target) scene.weapons.setSizePercent(target, input.valueAsNumber);
  });
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
    const tool = toolForShortcut(event.code);
    if (tool) { event.preventDefault(); weaponPicker.select(tool); return; }
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
    defaultImageAbort.abort();
    weaponPicker.destroy();
    photoEditor.destroy(); for (const editor of weaponEditors.values()) editor.destroy();
    observer.disconnect(); clearTimeout(noticeTimer);
  }
});
if (new URLSearchParams(location.search).has("diagnostics")) Object.assign(window, { __physicsLab: scene });
