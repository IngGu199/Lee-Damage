import Phaser from "phaser";
import "@fontsource-variable/noto-sans-kr";
import "./style.css";
import { PhysicsScene } from "./game/PhysicsScene";
import { PhotoSession } from "./photo/PhotoSession";
import { PhotoEditor } from "./photo/PhotoEditor";
import { FIXED_APPEARANCE, INJURY_KINDS, PHOTO_BASE_SIZE } from "./game/appearanceConfig";
import { APPEARANCE_RULES } from "./game/ImpactAppearance";
import {
  ANGULAR_INERTIA_SCALE,
  DEFAULT_SETTINGS,
  JOINT_DAMPING,
  MAX_ANGULAR_SPEED,
  REFERENCE_STEP,
  ROOM,
  type LabStats,
} from "./game/config";

const app = document.querySelector<HTMLDivElement>("#app")!;
const injuryLabels = { bruise: "멍 크기", scratch: "상처 크기", bandage: "반창고 크기" };
app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="./" aria-label="Lee Damage 홈"><span class="brand-mark">L<span>↗</span></span>LEE DAMAGE<span class="brand-dot">®</span></a>
    <div class="header-meta"><span class="status-dot"></span>개발 중인 작은 실험<span class="version">BUILD 0.6</span></div>
  </header>
  <main>
    <section class="intro" aria-labelledby="title">
      <div><p class="eyebrow">THE RAGDOLL PROJECT <span>/ 02</span></p><h1 id="title">사진 실험실<span class="title-dot">.</span></h1><p class="intro-copy">얼굴을 붙이고, 잡고 흔들어 보세요. 나머지는 중력에 맡기고.</p></div>
      <div class="stage-label"><span>PROTOTYPE</span><strong>02 <span>/ 08</span></strong><small>사진 적용 시제품</small></div>
    </section>
    <div class="workspace">
      <section class="playground" aria-label="물리 시제품">
        <div class="toolbar">
          <div class="tools"><span class="tool active"><span aria-hidden="true">✥</span> 잡기 · 던지기</span></div>
          <div class="play-actions"><button id="pause" class="icon-button" aria-label="일시정지" disabled>Ⅱ</button><span class="toolbar-divider"></span><button id="reset" class="reset-button" disabled><span aria-hidden="true">↻</span> 재배치 <kbd>R</kbd></button></div>
        </div>
        <div class="canvas-wrap"><div id="game"></div><div id="loading" class="game-overlay">물리 실험실을 준비하고 있어요…</div><div id="pause-overlay" class="game-overlay" hidden><span class="pause-symbol">Ⅱ</span><strong>잠깐 쉬는 중</strong><p>창을 벗어나면 자동으로 멈춥니다.</p><button id="resume">실험 계속하기 <span>→</span></button></div></div>
        <div class="game-footer"><span><span class="status-dot" id="live-dot"></span><span id="live-status">준비 중</span></span><span id="grip-status">인형의 어느 부위든 잡을 수 있어요</span><span class="engine-label">PHASER + MATTER</span></div>
      </section>
      <aside class="lab-panel" aria-label="실험 설정">
        <section class="photo-panel" aria-labelledby="face-panel-title">
          <p class="eyebrow">MAKE IT YOURS</p><h2 id="face-panel-title">인형의 얼굴</h2>
          <p class="photo-panel-copy" id="photo-state">내 사진을 붙이거나 얼굴 윤곽을 직접 그려 보세요.</p>
          <div class="photo-panel-actions"><button id="photo-open" class="photo-primary" disabled>사진 적용 +</button><button id="photo-remove" disabled>기본 얼굴로</button></div>
          <p class="photo-panel-note">사진은 브라우저 안에서만 처리해요.<br>재배치해도 유지 · 새로고침하면 해제</p>
          <details class="appearance-preview"><summary>충격에 따른 변화 미리보기</summary><p>물리적인 힘 없이 사진과 상처의 변화만 확인해요.</p><label for="impact-part">확인할 부위</label><select id="impact-part"><option value="0">머리</option><option value="1">몸통</option><option value="3">왼팔</option><option value="5">오른팔</option><option value="7">왼다리</option><option value="9">오른다리</option></select><button id="impact-preview" disabled>충격 미리보기</button><button id="appearance-clear" disabled>상처 지우기</button><p id="appearance-state" role="status" aria-live="polite">상처 0개</p></details>
        </section>
        <div class="panel-heading"><h2>실험 노트</h2><span>LAB NOTES</span></div>
        <section class="appearance-settings" aria-label="외형 고정값">
          <dl class="fixed-settings" aria-label="확정된 외형 설정">
            <div><dt>사진 크기 배수</dt><dd id="photo-scale-value">${FIXED_APPEARANCE.photoScale.toFixed(1)}×</dd></div>
            <div><dt>일그러짐 강도</dt><dd id="deformation-scale-value">${FIXED_APPEARANCE.deformationScale.toFixed(1)}×</dd></div>
            ${INJURY_KINDS.map((kind) => `<div><dt>${injuryLabels[kind]}</dt><dd id="injury-scale-${kind}-value">${FIXED_APPEARANCE.injuryScale[kind].toFixed(1)}×</dd></div>`).join("")}
          </dl>
          <p>사진의 충돌 범위는 원래 머리 도형이에요.<br>자국은 테두리까지 무작위로, 최대 ${APPEARANCE_RULES.maxInjuries}개 표시해요.</p>
        </section>
        <p class="panel-copy">조작 종료 2초 뒤<br>몸통 기준으로 관절을 정렬합니다.</p>
        <dl class="fixed-settings" aria-label="확정된 물리 설정">
          <div><dt>탄성</dt><dd>95%</dd></div>
          <div><dt>던지기 강도</dt><dd>50%</dd></div>
          <div><dt>중력</dt><dd>2.5×</dd></div>
          <div><dt>관절 정렬 대기</dt><dd>2초</dd></div>
          <div><dt>관절 지연</dt><dd>0%</dd></div>
          <div><dt>기립 대기</dt><dd>2초</dd></div>
        </dl>
        <p class="panel-copy" id="repair-policy">현재 몸통 위치·방향과 이동 벡터를 유지하며 정렬합니다.</p>
        <p class="panel-copy">기존 안정 조건 또는 최대 속력 50px/s 이하가<br>2초 이어지면 현재 위치에서 일어납니다.</p>
        <section class="angular-note" aria-labelledby="angular-title">
          <h3 id="angular-title">각운동</h3>
          <p class="panel-copy">잡은 지점을 축으로 중력과 관성에 따라 회전하며, 놓은 뒤에도 회전이 이어집니다. 관성과 감쇠를 낮춰 더 쉽게 회전하고 오래 흔들리도록 했습니다.</p>
          <dl class="fixed-settings" aria-label="각운동 적용값">
            <div><dt>회전 관성 · 기본 대비</dt><dd>${Math.round(ANGULAR_INERTIA_SCALE * 100)}%</dd></div>
            <div><dt>관절 감쇠</dt><dd>${JOINT_DAMPING}</dd></div>
            <div><dt>각속도 상한</dt><dd>${(MAX_ANGULAR_SPEED * 1000 / REFERENCE_STEP).toFixed(0)} rad/s</dd></div>
          </dl>
        </section>
        <label class="debug-toggle"><span>관절·물리 표시<small>연결점과 이동 방향 보기</small></span><input id="debug" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label>
        <div class="telemetry"><div class="telemetry-title"><span class="status-dot"></span> LIVE TELEMETRY</div><div class="metrics"><div><strong id="fps">—</strong><span>FPS</span></div><div><strong id="speed">0</strong><span>최대 속도 · px/s</span></div></div><div class="metric-detail"><span>신체 <b id="bodies">10</b> / 관절 <b id="joints">9</b></span><span>120 Hz</span></div><p id="self-collision-status">자기 충돌 ON</p><p id="alignment-status">조작 후 관절 정렬 대기</p><p id="posture-status">기립 상태</p><p id="recovery-status">안정성 복구 0회</p></div>
      </aside>
    </div>
    <section class="instructions" aria-label="조작 방법"><div><span class="instruction-number">01</span><p><strong>잡고, 흔들고</strong><span>잡고 있는 동안 신체끼리 충돌해요.</span></p></div><div><span class="instruction-number">02</span><p><strong>손을 놓으면, 휙</strong><span id="release-instruction">놓은 뒤에도 신체·벽·바닥과 계속 부딪혀요.</span></p></div><div><span class="instruction-number">03</span><p><strong>쉬면 다시 일어나요</strong><span id="alignment-instruction">조작 종료 2초 뒤 정렬하고, 안정되거나 50px/s 이하면 2초 뒤 기립해요.</span></p></div></section>
    <p id="notice" role="status" aria-live="polite"></p>
    <footer class="page-footer"><span>작은 인형에, 나만의 얼굴을.</span><span>PHYSICS FIRST. FUN FOLLOWS.</span></footer>
  </main>`;

const scene = new PhysicsScene();
const photoSession = new PhotoSession();
const photoEditor = new PhotoEditor(photoSession, {
  begin: () => scene.beginPhotoEdit(),
  end: () => scene.endPhotoEdit(),
  apply: (photo) => scene.applyPhoto(photo),
  clear: clearPhoto,
  previewSize: () => scene.game.canvas.getBoundingClientRect().width / ROOM.width * Math.max(PHOTO_BASE_SIZE, scene.face.displaySize),
});
const settings = { ...DEFAULT_SETTINGS };
let ready = false;
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function renderStats(stats: LabStats) {
  const face = scene.face;
  element<HTMLButtonElement>("photo-remove").disabled = !face?.active;
  element("photo-open").textContent = face?.active ? "사진 편집 ↗" : "사진 적용 +";
  element("photo-state").textContent = face?.active
    ? face.frameCount > 1 ? `사진 적용 중 · 충격별 변형 ${face.frameCount - 1}단계 준비됨` : "사진 적용 중 · 수동으로 맞춘 얼굴"
    : "내 사진을 붙이거나 얼굴 윤곽을 직접 그려 보세요.";
  element("appearance-state").textContent = `자국 ${scene.appearance.injuries.length} / ${APPEARANCE_RULES.maxInjuries}개 · 머리 충격 ${scene.appearance.headHits}회`;
  element("fps").textContent = String(stats.fps);
  element("speed").textContent = String(stats.speed);
  element("bodies").textContent = String(stats.bodies - 4);
  element("joints").textContent = String(
    stats.joints - (stats.grabbed ? 1 : 0),
  );
  element("self-collision-status").textContent = stats.selfCollision
    ? "자기 충돌 ON"
    : "자기 충돌 OFF · 벽·바닥 충돌 유지";
  element("alignment-status").hidden = stats.experiment !== 2;
  element("alignment-status").textContent = stats.alignmentRemaining !== null
    ? `관절 정렬까지 ${stats.alignmentRemaining.toFixed(1)}초`
    : stats.posture === "untangling"
      ? "이동을 유지하며 관절 정렬 중"
      : "다음 조작 후 관절 정렬";
  element("recovery-status").textContent = `안정성 복구 ${stats.recoveries}회`;
  element("posture-status").textContent = {
    standing: "기립 상태",
    active: "물리 반응 중",
    untangling: stats.experiment === 2 ? "몸통 기준으로 관절 정렬 중" : "꼬인 관절을 푸는 중",
    waiting: `기립까지 ${stats.idleRemaining.toFixed(1)}초`,
    recovering: "현재 위치에서 일어나는 중",
  }[stats.posture];
  element("grip-status").textContent = stats.grabbed
    ? `${stats.grabbed} 잡는 중 · 놓으면 던지기`
    : "인형의 어느 부위든 잡을 수 있어요";
  element("live-status").textContent = stats.paused
    ? "일시정지"
    : "실험 진행 중";
  element("live-dot").classList.toggle("paused", stats.paused);
  element("pause-overlay").hidden = !stats.paused;
  element("pause").textContent = stats.paused ? "▷" : "Ⅱ";
  element("pause").setAttribute(
    "aria-label",
    stats.paused ? "계속하기" : "일시정지",
  );
}

scene.onStats = renderStats;
scene.onNotice = (message) => {
  element("notice").textContent = message;
};
scene.onReady = () => {
  ready = true;
  element("loading").hidden = true;
  app.querySelectorAll<HTMLButtonElement>("button:not(#photo-remove)").forEach((button) => {
    button.disabled = false;
  });
  scene.configure(settings);
};

function clearPhoto() {
  photoSession.clear(); scene.clearPhoto();
}

element("photo-open").addEventListener("click", () => photoEditor.show());
element("photo-remove").addEventListener("click", clearPhoto);
element("impact-preview").addEventListener("click", () => scene.previewImpact(Number(element<HTMLSelectElement>("impact-part").value)));
element("appearance-clear").addEventListener("click", () => scene.resetAppearance());
window.addEventListener("pagehide", (event) => {
  if (!(event as PageTransitionEvent).persisted) photoEditor.destroy();
});

element("pause").addEventListener("click", () =>
  scene.setPaused(!scene.paused),
);
element("resume").addEventListener("click", () => scene.setPaused(false));
element("reset").addEventListener("click", () => {
  scene.reset();
  element("notice").textContent = "인형을 처음 위치로 재배치했습니다.";
});
element<HTMLInputElement>("debug").addEventListener("change", (event) => {
  settings.debug = (event.target as HTMLInputElement).checked;
  if (ready) scene.configure(settings);
});
window.addEventListener("keydown", (event) => {
  if (!ready || photoEditor.open || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
    return;
  if (
    (event.target as HTMLElement).closest(
      "input, button, a, select, textarea, [contenteditable]",
    )
  )
    return;
  if (event.code === "KeyR") scene.reset();
  if (event.code === "Space") {
    event.preventDefault();
    scene.setPaused(!scene.paused);
  }
});

// Load the canvas label's Korean glyphs before Phaser rasterizes its text.
await document.fonts.load(
  '400 20px "Noto Sans KR Variable"',
  "잡아서 위로 들어 보세요",
);
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: ROOM.width,
  height: ROOM.height,
  backgroundColor: "#f8f9f4",
  antialias: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: {
    default: "matter",
    matter: {
      gravity: { x: 0, y: DEFAULT_SETTINGS.gravity },
      positionIterations: 10,
      velocityIterations: 8,
      constraintIterations: 24,
      enableSleeping: false,
    },
  },
  scene: [scene],
});

// Opt-in diagnostics for automated physics checks, absent from ordinary sessions.
if (new URLSearchParams(location.search).has("diagnostics")) {
  Object.assign(window, { __physicsLab: scene });
}
