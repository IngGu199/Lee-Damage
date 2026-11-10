import Phaser from "phaser";
import { Matter } from "./matter";
import {
  DEFAULT_SETTINGS,
  FIXED_SETTINGS,
  FIXED_STEP,
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
import { FaceRenderer } from "./FaceRenderer";
import { InjuryRenderer } from "./InjuryRenderer";
import { ImpactAppearance, type AppearanceImpact } from "./ImpactAppearance";
import { ImpactCollector } from "./ImpactCollector";
import { DamageSystem, type DamageHit } from "./DamageSystem";
import { RagdollLifecycle } from "./RagdollLifecycle";
import { DAMAGE_RULES } from "./damageConfig";
import { separateBodies } from "./SelfCollision";
import type { AppliedPhoto } from "../photo/PhotoSession";

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
  private overlay!: Phaser.GameObjects.Graphics;
  face!: FaceRenderer;
  readonly appearance = new ImpactAppearance();
  readonly damage = new DamageSystem();
  readonly lifecycle = new RagdollLifecycle();
  private burstOrigin = { x: 600, y: 350 };
  private effects!: Phaser.GameObjects.Graphics;
  private injuries!: InjuryRenderer;
  private readonly impacts = new ImpactCollector();
  private simulationTime = 0;
  private photoEditing = false;
  private resumeAfterPhoto = false;
  private readonly abort = new AbortController();
  onStats: (stats: LabStats) => void = () => {};
  onReady: () => void = () => {};
  onNotice: (message: string) => void = () => {};

  constructor() {
    super("PhysicsLab");
  }

  preload() {
    for (const kind of ["bruise", "scratch", "bandage"])
      this.load.svg(`injury-${kind}`, `${import.meta.env.BASE_URL}assets/injuries/${kind}.svg`, { width: 128, height: 128 });
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
    this.overlay = this.add.graphics().setDepth(30);
    this.effects = this.add.graphics().setDepth(25);
    this.face = new FaceRenderer(this);
    this.injuries = new InjuryRenderer(this, this.face);
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
      () => this.paused || !this.lifecycle.interactive,
      () => {
        if (!this.lifecycle.interactive) return;
        this.lifecycle.interact();
        this.posture.interact();
      },
    );
    this.pointer.experiment = this.settings.experiment;
    Matter.Events.on(this.matter.world.engine, "beforeSolve", this.impacts.beforeSolve);
    Matter.Events.on(this.matter.world.engine, "collisionStart collisionActive", this.impacts.collisions);
    window.addEventListener("blur", this.blur, { signal: this.abort.signal });
    document.addEventListener("visibilitychange", this.visibility, {
      signal: this.abort.signal,
    });
    this.events.once("shutdown", () => {
      this.pointer.destroy();
      Matter.Events.off(this.matter.world.engine, "beforeSolve", this.impacts.beforeSolve);
      Matter.Events.off(this.matter.world.engine, "collisionStart collisionActive", this.impacts.collisions);
      this.face.clear(); this.injuries.clear(); this.impacts.clear(); this.appearance.reset();
      this.abort.abort();
    });
    this.onReady();
    this.publishStats();
  }

  private blur = () => {
    this.resumeAfterPhoto = false;
    this.setPaused(true);
  };
  private visibility = () => {
    if (document.hidden) this.blur();
  };

  setPaused(value: boolean) {
    if (this.photoEditing && !value) return;
    this.pointer.cancel();
    this.paused = value;
    this.accumulator = 0;
    this.publishStats();
  }

  beginPhotoEdit() {
    this.resumeAfterPhoto = !this.paused;
    this.photoEditing = true;
    this.setPaused(true);
  }

  endPhotoEdit() {
    this.photoEditing = false;
    this.setPaused(!this.resumeAfterPhoto);
  }

  applyPhoto(photo: AppliedPhoto) {
    this.face.apply(photo.frames, photo.mask.kind === "contour");
    this.resetAppearance();
    this.face.update(this.doll.parts[0]);
    this.face.setAlpha(this.lifecycle.alpha(this.simulationTime));
    this.onNotice(photo.frames.length > 1
      ? "사진을 적용했어요. 체력을 30%·65% 잃으면 변형 사진으로 바뀝니다."
      : "사진을 적용했어요. 얼굴 기준점이 없어 사진 변형은 생략합니다.");
  }

  clearPhoto() { this.face.clear(); this.resetAppearance(); this.onNotice("기본 얼굴로 돌아왔습니다."); }

  resetAppearance() {
    this.appearance.reset(); this.injuries.clear(); this.face.showVariant(this.damage.variant);
  }

  private applyImpact(impact: AppearanceImpact, preview = false) {
    const part = this.doll.parts[impact.part];
    if (!part) return;
    const injury = this.appearance.accept(impact, part.body, preview);
    if (!injury) return;
    this.injuries.add(injury, part);
    this.face.showVariant(this.appearance.variant);
  }

  /** Internal prototype check, no physical impulse and no score/weapon behavior. */
  previewImpact(partIndex = 0) {
    if (this.photoEditing || !this.lifecycle.interactive) return;
    const part = this.doll.parts[partIndex];
    if (!part) return;
    this.applyImpact({ part: partIndex, position: { ...part.body.position }, strength: 600, time: this.simulationTime }, true);
  }

  /** Common synchronous path for room and future weapon hits. */
  receiveHit(hit: DamageHit) {
    if (this.paused || this.photoEditing || !this.lifecycle.interactive || hit.lifeId !== this.lifecycle.lifeId ||
      hit.time > this.simulationTime + 0.000001) return null;
    if (hit.source === "room" && this.lifecycle.protected(this.simulationTime)) return null;
    const result = this.damage.apply(hit);
    if (!result) return null;
    if (hit.source === "weapon") { this.lifecycle.interact(); this.posture.interact(); }
    const part = this.doll.parts[hit.part];
    for (let index = 0; index < result.injuries; index++) {
      const injury = this.appearance.addInjury(hit, part.body);
      this.injuries.add(injury, part);
    }
    this.face.showVariant(result.variant);
    if (result.lethal && this.lifecycle.kill(hit.lifeId)) this.pointer.cancel();
    return result;
  }

  reset() { this.replaceDoll(false); this.accumulator = 0; this.publishStats(); }

  private replaceDoll(airborne: boolean, preserveHealth = false) {
    this.pointer.cancel();
    this.doll.destroy();
    // This foundation contains only the doll and static room. No pending weapon bodies.
    Matter.Engine.clear(this.matter.world.engine);
    this.impacts.clear();
    this.doll = new Ragdoll(this.matter.world, this.settings.bounce);
    this.posture = new PostureController(this.doll, this.settings.experiment);
    this.lifecycle.spawn(this.simulationTime, airborne);
    this.damage.reset(this.lifecycle.lifeId, preserveHealth);
    if (airborne) {
      this.doll.startAirborne(DAMAGE_RULES.spawnOffsetY);
      this.posture.interact();
    }
    if (!preserveHealth) this.resetAppearance();
    this.face.showVariant(this.damage.variant);
    this.face.setAlpha(1);
    this.face.update(this.doll.parts[0]);
    this.effects.clear();
  }

  private finishLifecycle() {
    if (this.lifecycle.state === "dying") {
      this.burstOrigin = this.doll.centerOfMass;
      this.doll.burst();
      this.lifecycle.burst(this.simulationTime);
      this.impacts.clear();
    } else if (this.lifecycle.burstFinished(this.simulationTime)) {
      this.doll.destroy();
      Matter.Engine.clear(this.matter.world.engine);
      this.impacts.clear();
      this.appearance.reset(); this.injuries.clear();
      this.face.setAlpha(0);
      this.lifecycle.wait(this.simulationTime);
    } else if (this.lifecycle.readyToSpawn(this.simulationTime)) {
      this.replaceDoll(true);
    }
  }

  private drawBurst() {
    this.effects.clear();
    if (this.lifecycle.state !== "bursting") return;
    const alpha = this.lifecycle.alpha(this.simulationTime), progress = 1 - alpha;
    const { x, y } = this.burstOrigin;
    this.effects.lineStyle(4 * alpha, 0xdf9660, alpha).strokeCircle(x, y, 20 + progress * 130);
    for (let index = 0; index < 12; index++) {
      const angle = index * Math.PI / 6;
      const radius = 25 + progress * (95 + index % 3 * 20);
      const px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
      this.effects.lineStyle(3, index % 2 ? 0xe8bd8b : 0x94ae58, alpha);
      this.effects.lineBetween(px - 5 * alpha, py, px + 5 * alpha, py)
        .lineBetween(px, py - 5 * alpha, px, py + 5 * alpha);
    }
  }

  configure(settings: LabSettings) {
    if (this.settings.experiment !== settings.experiment) this.pointer.cancel();
    // Fixed stage-one values also apply to configuration calls outside the UI.
    this.settings = { ...settings, ...FIXED_SETTINGS };
    this.pointer.experiment = settings.experiment;
    this.posture.setExperiment(settings.experiment);
    this.matter.world.setGravity(0, this.settings.gravity);
    this.doll.setBounce(this.settings.bounce);
    this.doll.configureLag(this.settings.lag);
    this.pointer.throwScale = this.settings.throwScale;
  }

  update(_time: number, delta: number) {
    if (!this.doll) return;
    if (!this.paused) {
      // Drop excess elapsed time after a stall rather than run an unbounded catch-up.
      this.accumulator += Math.min(delta, 50);
      while (this.accumulator >= FIXED_STEP) {
        // Include rotational edge travel when subdividing faster angular motion.
        const speed = this.doll.motionSpeed;
        const slices = Math.min(
          MAX_SUBSTEPS,
          Math.max(
            1,
            Math.ceil(
              Math.max(
                (speed * FIXED_STEP) / 1000,
                this.pointer.travelDistance,
              ) / MAX_TRAVEL_PER_SUBSTEP,
            ),
          ),
        );
        const step = FIXED_STEP / slices;
        for (let slice = 0; slice < slices; slice++) {
          this.simulationTime += step;
          this.lifecycle.update(this.simulationTime);
          if (!this.lifecycle.interactive) {
            if (this.lifecycle.state === "bursting") {
              this.matter.world.step(step);
              separateBodies(this.doll.bodies, 2, { selfCollision: false });
            }
            this.finishLifecycle();
            continue;
          }
          // During protected entry, natural falling takes priority over posture timers.
          if (this.lifecycle.state !== "spawning") this.posture.beforeStep(
            step, Boolean(this.pointer.grip), this.settings,
          );
          this.pointer.step(slices - slice);
          if (!this.posture.controlsPose) {
            this.doll.limitAngularSpeed();
            const previous = this.doll.capturePose();
            this.impacts.beginStep(this.doll, true, this.simulationTime, this.lifecycle.lifeId, step);
            this.matter.world.step(step);
            this.pointer.afterStep();
            this.impacts.boundaries();
            if (this.impacts.touchedFloor) this.lifecycle.landed(this.simulationTime);
            for (const hit of this.impacts.flush()) this.receiveHit(hit);
            // Death is resolved only after Matter has finished the step; no normal pose solver on fragments.
            if (!this.lifecycle.interactive) { this.finishLifecycle(); continue; }
            this.doll.finishStep(previous, this.pointer.held);
            if (this.lifecycle.state !== "spawning") this.posture.afterStep(step);
            this.doll.limitAngularSpeed();
          }
        }
        this.accumulator -= FIXED_STEP;
      }
      if (this.lifecycle.interactive && this.doll.unstable) {
        this.recoveries++;
        this.replaceDoll(false, true);
        this.onNotice("불안정한 물리 상태를 감지해 인형을 재배치했습니다.");
      }
    }
    drawDoll(this.graphics, this.doll, this.pointer, this.settings.debug, this.face.active, this.overlay, this.face.customOutline);
    const alpha = this.lifecycle.alpha(this.simulationTime);
    this.graphics.setAlpha(alpha); this.overlay.setAlpha(alpha);
    this.face.update(this.doll.parts[0]); this.face.setAlpha(alpha);
    this.injuries.update(this.doll, this.appearance.injuries, alpha);
    this.drawBurst();
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
      lifeId: this.lifecycle.lifeId,
      lifeState: this.lifecycle.state,
      hp: this.damage.health.hp,
      maxHp: this.damage.health.maxHp,
      lostHp: this.damage.health.lostHp,
      simulationTime: this.simulationTime,
      spawnProtected: this.lifecycle.protected(this.simulationTime),
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
