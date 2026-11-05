import Phaser from "phaser";
import "@fontsource-variable/noto-sans-kr";
import "./style.css";
import { PhysicsScene } from "./game/PhysicsScene";
import {
  DEFAULT_SETTINGS,
  ROOM,
  type LabStats,
  type Tool,
} from "./game/config";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="./" aria-label="Lee Damage 홈"><span class="brand-mark">L<span>↗</span></span>LEE DAMAGE<span class="brand-dot">®</span></a>
    <div class="header-meta"><span class="status-dot"></span>개발 중인 작은 실험<span class="version">BUILD 0.5</span></div>
  </header>
  <main>
    <section class="intro" aria-labelledby="title">
      <div><p class="eyebrow">THE RAGDOLL PROJECT <span>/ 01</span></p><h1 id="title">물리 실험실<span class="title-dot">.</span></h1><p class="intro-copy">일단, 잡고 흔들어 보세요. 나머지는 중력에 맡기고.</p></div>
      <div class="stage-label"><span>PROTOTYPE</span><strong>01 <span>/ 08</span></strong><small>최소 물리 시제품</small></div>
    </section>
    <div class="workspace">
      <section class="playground" aria-label="물리 시제품">
        <div class="toolbar">
          <div class="tools" role="group" aria-label="조작 도구">
            <button class="tool active" data-tool="grab" aria-pressed="true" disabled><span aria-hidden="true">✥</span> 잡기 <kbd>1</kbd></button>
            <button class="tool" data-tool="push" aria-pressed="false" disabled><span aria-hidden="true">↗</span> 밀치기 <kbd>2</kbd></button>
          </div>
          <div class="play-actions"><button id="pause" class="icon-button" aria-label="일시정지" disabled>Ⅱ</button><span class="toolbar-divider"></span><button id="reset" class="reset-button" disabled><span aria-hidden="true">↻</span> 재배치 <kbd>R</kbd></button></div>
        </div>
        <div class="canvas-wrap"><div id="game"></div><div id="loading" class="game-overlay">물리 실험실을 준비하고 있어요…</div><div id="pause-overlay" class="game-overlay" hidden><span class="pause-symbol">Ⅱ</span><strong>잠깐 쉬는 중</strong><p>창을 벗어나면 자동으로 멈춥니다.</p><button id="resume">실험 계속하기 <span>→</span></button></div></div>
        <div class="game-footer"><span><span class="status-dot" id="live-dot"></span><span id="live-status">준비 중</span></span><span id="grip-status">인형의 어느 부위든 잡을 수 있어요</span><span class="engine-label">PHASER + MATTER</span></div>
      </section>
      <aside class="lab-panel" aria-label="실험 설정">
        <div class="panel-heading"><h2>실험 노트</h2><span>LAB NOTES</span></div>
        <p class="panel-copy">실험 1 · 놓은 뒤 자기 충돌 해제<br>기립할 때 관절을 정렬하고 다시 켭니다.</p>
        <div class="setting"><label for="gravity">중력 <output id="gravity-value">1.0×</output></label><input id="gravity" type="range" min="0" max="2" step="0.1" value="1"><div class="range-labels"><span>둥실둥실</span><span>묵직하게</span></div></div>
        <div class="setting"><label for="bounce">탄성 <output id="bounce-value">55%</output></label><input id="bounce" type="range" min="0" max="0.95" step="0.05" value="0.55"><div class="range-labels"><span>툭</span><span>통통</span></div></div>
        <div class="setting"><label for="strength">밀치는 힘 <output id="strength-value">1.0×</output></label><input id="strength" type="range" min="0.3" max="2" step="0.1" value="1"><div class="range-labels"><span>살짝</span><span>힘껏</span></div></div>
        <div class="setting"><label for="throwScale">던지기 강도 <output id="throwScale-value">35%</output></label><input id="throwScale" type="range" min="0" max="1.5" step="0.05" value="0.35"><div class="range-labels"><span>0% · 던지기 없음</span><span>150%</span></div></div>
        <p class="panel-copy" id="repair-policy">관절 복구: 기립할 때 함께 정렬합니다.</p>
        <div class="setting"><label for="lag">관절 지연 <output id="lag-value">65%</output></label><input id="lag" type="range" min="0" max="1" step="0.05" value="0.65"><div class="range-labels"><span>빠른 추종</span><span>느린 추종</span></div></div>
        <div class="setting"><label for="idleSeconds">기립 대기 <output id="idleSeconds-value">3초</output></label><input id="idleSeconds" type="range" min="1" max="8" step="0.5" value="3"><div class="range-labels"><span>1초</span><span>8초</span></div></div>
        <label class="debug-toggle"><span>관절·물리 표시<small>연결점과 이동 방향 보기</small></span><input id="debug" type="checkbox" role="switch"><span class="switch" aria-hidden="true"></span></label>
        <div class="telemetry"><div class="telemetry-title"><span class="status-dot"></span> LIVE TELEMETRY</div><div class="metrics"><div><strong id="fps">—</strong><span>FPS</span></div><div><strong id="speed">0</strong><span>최대 속도 · px/s</span></div></div><div class="metric-detail"><span>신체 <b id="bodies">10</b> / 관절 <b id="joints">9</b></span><span>120 Hz</span></div><p id="self-collision-status">자기 충돌 ON</p><p id="posture-status">기립 상태</p><p id="recovery-status">안정성 복구 0회</p></div>
      </aside>
    </div>
    <section class="instructions" aria-label="조작 방법"><div><span class="instruction-number">01</span><p><strong>잡고, 흔들고</strong><span>잡고 있는 동안 신체끼리 충돌해요.</span></p></div><div><span class="instruction-number">02</span><p><strong>손을 놓으면, 휙</strong><span>놓으면 자기 충돌을 끄고 벽·바닥과 부딪혀요.</span></p></div><div><span class="instruction-number">03</span><p><strong>쉬면 다시 일어나요</strong><span>기립할 때 관절 정렬 후 자기 충돌을 다시 켜요.</span></p></div></section>
    <p id="notice" role="status" aria-live="polite"></p>
    <footer class="page-footer"><span>아직은 도형이지만, 움직임부터 제대로.</span><span>PHYSICS FIRST. FUN FOLLOWS.</span></footer>
  </main>`;

const scene = new PhysicsScene();
const settings = { ...DEFAULT_SETTINGS };
let ready = false;
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function selectTool(tool: Tool) {
  if (!ready) return;
  scene.setTool(tool);
  document
    .querySelectorAll<HTMLButtonElement>("[data-tool]")
    .forEach((button) => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
}

function renderStats(stats: LabStats) {
  element("fps").textContent = String(stats.fps);
  element("speed").textContent = String(stats.speed);
  element("bodies").textContent = String(stats.bodies - 4);
  element("joints").textContent = String(
    stats.joints - (stats.grabbed ? 1 : 0),
  );
  element("self-collision-status").textContent = stats.selfCollision
    ? "자기 충돌 ON"
    : "자기 충돌 OFF · 벽·바닥 충돌 유지";
  element("recovery-status").textContent = `안정성 복구 ${stats.recoveries}회`;
  element("posture-status").textContent = {
    standing: "기립 상태",
    active: "물리 반응 중",
    untangling: "꼬인 관절을 푸는 중",
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
  app.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = false;
  });
  selectTool("grab");
};

document
  .querySelectorAll<HTMLButtonElement>("[data-tool]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      selectTool(button.dataset.tool as Tool),
    ),
  );
element("pause").addEventListener("click", () =>
  scene.setPaused(!scene.paused),
);
element("resume").addEventListener("click", () => scene.setPaused(false));
element("reset").addEventListener("click", () => {
  scene.reset();
  element("notice").textContent = "인형을 처음 위치로 재배치했습니다.";
});
for (const key of [
  "gravity",
  "bounce",
  "strength",
  "idleSeconds",
  "throwScale",
  "lag",
] as const) {
  element<HTMLInputElement>(key).addEventListener("input", (event) => {
    settings[key] = Number((event.target as HTMLInputElement).value);
    element(`${key}-value`).textContent =
      key === "idleSeconds"
        ? `${settings[key]}초`
        : key === "bounce" || key === "lag" || key === "throwScale"
          ? `${Math.round(settings[key] * 100)}%`
          : `${settings[key].toFixed(1)}×`;
    if (ready) scene.configure(settings);
  });
}
element<HTMLInputElement>("debug").addEventListener("change", (event) => {
  settings.debug = (event.target as HTMLInputElement).checked;
  if (ready) scene.configure(settings);
});
window.addEventListener("keydown", (event) => {
  if (!ready || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
    return;
  if (
    (event.target as HTMLElement).closest(
      "input, button, a, select, textarea, [contenteditable]",
    )
  )
    return;
  if (event.code === "Digit1") selectTool("grab");
  if (event.code === "Digit2") selectTool("push");
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
      gravity: { x: 0, y: 1 },
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
