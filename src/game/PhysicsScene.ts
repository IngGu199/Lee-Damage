import Phaser from "phaser";
import { Matter } from "./matter";
import {
  DEFAULT_SETTINGS,
  FIXED_SETTINGS,
  FIXED_STEP,
  REFERENCE_STEP,
  MAX_TRAVEL_PER_SUBSTEP,
  MAX_SUBSTEPS,
  ROOM,
  type LabSettings,
  type LabStats,
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
    this.posture = new PostureController(this.doll, this.settings.experiment);
    const canvas = this.game.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "물리 실험실. 인형을 마우스로 잡고 흔들거나 던지세요. R 재배치, 스페이스 일시정지.",
    );
    this.pointer = new PointerController(
      canvas,
      this.matter.world,
      () => this.doll,
      () => this.paused,
      () => this.posture.interact(),
    );
    this.pointer.experiment = this.settings.experiment;
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
    this.posture = new PostureController(this.doll, this.settings.experiment);
    this.accumulator = 0;
    this.publishStats();
  }

  configure(settings: LabSettings) {
    if (this.settings.experiment !== settings.experiment) this.pointer.cancel();
    // Fixed stage-one values also apply to configuration calls outside the UI.
    this.settings = { ...settings, ...FIXED_SETTINGS };
    this.pointer.experiment = settings.experiment;
    this.posture.setExperiment(settings.experiment);
    this.matter.world.setGravity(0, this.settings.gravity);
    this.doll.setBounce(settings.bounce);
    this.doll.configureLag(this.settings.lag);
    this.pointer.throwScale = this.settings.throwScale;
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
        const slices = Math.min(
          MAX_SUBSTEPS,
          Math.max(
            1,
            Math.ceil(
              Math.max(
                (speed * FIXED_STEP) / REFERENCE_STEP,
                this.pointer.travelDistance,
              ) / MAX_TRAVEL_PER_SUBSTEP,
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
          this.pointer.step(slices - slice);
          if (!this.posture.controlsPose) {
            this.doll.limitAngularSpeed();
            const previous = this.doll.capturePose();
            this.matter.world.step(step);
            this.pointer.afterStep();
            this.doll.finishStep(previous, this.pointer.held);
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

  snapshot(): LabStats {
    const { Composite } = Matter;
    const world = this.matter.world
      .localWorld as unknown as MatterJS.CompositeType;
    return {
      experiment: this.settings.experiment,
      alignmentRemaining: this.posture.alignmentRemaining(this.settings.repairSeconds),
      fps: Math.round(this.game.loop.actualFps),
      speed: Math.round(this.doll.linearSpeed),
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
