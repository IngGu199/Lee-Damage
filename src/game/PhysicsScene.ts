import Phaser from "phaser";
import { Matter } from "./matter";
import {
  DEFAULT_SETTINGS,
  FIXED_STEP,
  REFERENCE_STEP,
  MAX_TRAVEL_PER_SUBSTEP,
  MAX_SUBSTEPS,
  ROOM,
  type LabSettings,
  type LabStats,
  type Tool,
} from "./config";
import { Ragdoll } from "./Ragdoll";
import { PointerController } from "./PointerController";
import { drawDoll, drawRoom } from "./draw";
import { PostureController } from "./PostureController";

export class PhysicsScene extends Phaser.Scene {
  settings: LabSettings = { ...DEFAULT_SETTINGS };
  doll!: Ragdoll;
  pointer!: PointerController;
  posture!: PostureController;
  paused = false;
  recoveries = 0;
  private accumulator = 0;
  private statsElapsed = 0;
  private graphics!: Phaser.GameObjects.Graphics;
  private readonly abort = new AbortController();
  onStats: (stats: LabStats) => void = () => {};
  onReady: () => void = () => {};
  onNotice: (message: string) => void = () => {};

  constructor() {
    super("PhysicsLab");
  }

  create() {
    const { Bodies } = Matter;
    this.matter.world.autoUpdate = false;
    // Thick static walls plus adaptive substeps reduce high-speed tunneling.
    for (const [x, y, width, height] of [
      [-70, 350, 200, 1100],
      [1270, 350, 200, 1100],
      [600, -58, 1600, 200],
      [600, 750, 1600, 200],
    ])
      this.matter.world.add(
        Bodies.rectangle(x, y, width, height, {
          isStatic: true,
          restitution: 0,
          friction: 0.4,
          label: "room-wall",
        }),
      );
    drawRoom(this);
    this.graphics = this.add.graphics();
    this.doll = new Ragdoll(this.matter.world, this.settings.bounce);
    this.posture = new PostureController(this.doll);
    const canvas = this.game.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "물리 실험실. 인형을 마우스로 잡고 흔들거나 던지세요. 1 잡기, 2 밀치기, R 재배치, 스페이스 일시정지.",
    );
    this.pointer = new PointerController(
      canvas,
      this.matter.world,
      () => this.doll,
      () => this.paused,
      (point) => this.flash(point),
      () => this.posture.interact(),
    );
    window.addEventListener("blur", this.blur, { signal: this.abort.signal });
    document.addEventListener("visibilitychange", this.visibility, {
      signal: this.abort.signal,
    });
    this.events.once("shutdown", () => {
      this.pointer.destroy();
      this.abort.abort();
    });
    this.onReady();
    this.publishStats();
  }

  private blur = () => {
    this.setPaused(true);
  };
  private visibility = () => {
    if (document.hidden) this.setPaused(true);
  };

  setTool(tool: Tool) {
    this.pointer.cancel();
    this.pointer.tool = tool;
    this.game.canvas.dataset.tool = tool;
  }

  setPaused(value: boolean) {
    this.pointer.cancel();
    this.paused = value;
    this.accumulator = 0;
    this.publishStats();
  }

  reset() {
    this.pointer.cancel();
    this.doll.destroy();
    // Clear obsolete collision pairs before repeatedly recreating the doll.
    Matter.Engine.clear(this.matter.world.engine);
    this.doll = new Ragdoll(this.matter.world, this.settings.bounce);
    this.posture = new PostureController(this.doll);
    this.accumulator = 0;
    this.publishStats();
  }

  configure(settings: LabSettings) {
    this.settings = { ...settings };
    this.matter.world.setGravity(0, settings.gravity);
    this.doll.setBounce(settings.bounce);
    this.doll.configureLag(settings.lag);
    this.pointer.strength = settings.strength;
    this.pointer.throwScale = settings.throwScale;
  }

  update(_time: number, delta: number) {
    if (!this.doll) return;
    if (!this.paused) {
      // Drop excess elapsed time after a stall rather than run an unbounded catch-up.
      this.accumulator += Math.min(delta, 50);
      while (this.accumulator >= FIXED_STEP) {
        const speed = Math.max(
          ...this.doll.parts.map((part) =>
            part.body.isStatic
              ? 0
              : Math.hypot(part.body.velocity.x, part.body.velocity.y),
          ),
        );
        const slices = this.pointer.grip
          ? 1
          : Math.min(
              MAX_SUBSTEPS,
              Math.max(
                1,
                Math.ceil(
                  (speed * FIXED_STEP) /
                    REFERENCE_STEP /
                    MAX_TRAVEL_PER_SUBSTEP,
                ),
              ),
            );
        const step = FIXED_STEP / slices;
        for (let slice = 0; slice < slices; slice++) {
          this.posture.beforeStep(
            step,
            Boolean(this.pointer.grip),
            this.settings,
          );
          this.pointer.step();
          if (!this.posture.controlsPose) {
            this.doll.limitAngularSpeed();
            const previous = this.doll.capturePose();
            this.matter.world.step(step);
            this.doll.finishStep(previous);
            this.posture.afterStep(step);
            this.doll.limitAngularSpeed();
          }
        }
        this.accumulator -= FIXED_STEP;
      }
      if (this.doll.unstable) {
        this.recoveries++;
        this.reset();
        this.onNotice("불안정한 물리 상태를 감지해 인형을 재배치했습니다.");
      }
    }
    drawDoll(this.graphics, this.doll, this.pointer, this.settings.debug);
    this.statsElapsed += delta;
    if (this.statsElapsed >= 150) {
      this.publishStats();
      this.statsElapsed = 0;
    }
  }

  private flash(point: MatterJS.Vector) {
    const effect = this.add
      .circle(point.x, point.y, 10)
      .setStrokeStyle(4, 0xec9b62);
    this.tweens.add({
      targets: effect,
      radius: 42,
      alpha: 0,
      duration: 220,
      onComplete: () => effect.destroy(),
    });
  }

  snapshot(): LabStats {
    const { Composite } = Matter;
    const world = this.matter.world
      .localWorld as unknown as MatterJS.CompositeType;
    return {
      fps: Math.round(this.game.loop.actualFps),
      speed: Math.round(
        Math.max(...this.doll.parts.map((part) => part.body.speed)) * 60,
      ),
      bodies: Composite.allBodies(world).length,
      joints: Composite.allConstraints(world).length,
      grabbed: this.pointer.grabbed,
      paused: this.paused,
      recoveries: this.recoveries,
      maxJointGap: this.doll.maxJointGap,
      maxOverlap: this.doll.maxOverlap,
      posture: this.posture.state,
      selfCollision: this.doll.selfCollisionEnabled,
      idleRemaining: Math.max(
        0,
        this.settings.idleSeconds - this.posture.quietMs / 1000,
      ),
    };
  }

  private publishStats() {
    this.onStats(this.snapshot());
  }
}
