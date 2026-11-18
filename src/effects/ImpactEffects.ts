import Phaser from "phaser";
import { loadSettings, mergeSettings } from "../weapons/WeaponConfig";
import type { Point } from "../weapons/geometry";

interface EffectDefinition { type: string; durationMs: number; size: number; count: number; color: number; lineWidth: number; cooldownMs: number }
export interface EffectConfig { version: 1; maxActive: number; defaults: EffectDefinition; events: Record<string, EffectDefinition> }
const shared: EffectDefinition = { type: "sparks", durationMs: 260, size: 55, count: 10, color: 0xf4c765, lineWidth: 3, cooldownMs: 0 };
export function parseEffectConfig(input: unknown): EffectConfig {
  const root = input as Partial<EffectConfig>;
  if (!root || root.version !== 1 || (root.events !== undefined && (!root.events || typeof root.events !== "object" || Array.isArray(root.events))))
    throw new Error("effects: version 1과 events 객체가 필요합니다.");
  const defaults = mergeSettings(shared, root.defaults, "effects.defaults");
  const validate = (definition: EffectDefinition) => {
    if (!["ring", "sparks", "star"].includes(definition.type) || definition.durationMs <= 0 || definition.durationMs > 10000 ||
      definition.size > 600 || !Number.isInteger(definition.count) || definition.count > 64 || definition.lineWidth > 30 ||
      !Number.isInteger(definition.color) || definition.color > 0xffffff) throw new Error("effects: 종류·크기·개수·시간·색상을 확인하세요.");
    return definition;
  };
  validate(defaults);
  const maxActive = root.maxActive ?? 96;
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 256) throw new Error("effects.maxActive: 1~256 정수가 필요합니다.");
  return { version: 1, maxActive, defaults, events: Object.fromEntries(Object.entries(root.events ?? {})
    .map(([key, value]) => [key, validate(mergeSettings(defaults, value, `effects.events.${key}`))])) };
}
export const DEFAULT_EFFECT_CONFIG = parseEffectConfig({ version: 1, events: {
  "weapon.bat.hit": { type: "star", color: 0xf0ca6b },
  "weapon.bat.finish": { type: "star", size: 180, durationMs: 700, count: 16 },
  "weapon.hammer.hit": { type: "ring", color: 0x9ac9ed, size: 90 },
  "weapon.hammer.finish": { type: "sparks", color: 0x8fcef4, size: 240, count: 28, durationMs: 700 },
  "weapon.gun.fire": { type: "star", size: 25, durationMs: 90 },
  "weapon.gun.hit": { type: "sparks", size: 38, count: 6 },
  "weapon.gun.pin": { type: "ring", size: 80, color: 0xf2936a },
  "weapon.gun.finish": { type: "star", size: 80, color: 0xf2936a },
  "weapon.gun.burst": { type: "sparks", size: 220, count: 24, durationMs: 600, color: 0xf2936a },
} });

/** One bounded graphics layer, advanced only by simulation time. */
export class ImpactEffects {
  config = DEFAULT_EFFECT_CONFIG;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly active: { key: string; position: Point; direction: Point; time: number; definition: EffectDefinition }[] = [];
  private readonly last = new Map<string, number>();
  constructor(scene: Phaser.Scene) { this.graphics = scene.add.graphics().setDepth(60); }
  async load(signal: AbortSignal) { this.config = await loadSettings("config/effects.json", DEFAULT_EFFECT_CONFIG, parseEffectConfig, signal); }
  emit(key: string, position: Point, direction: Point, time: number) {
    const definition = this.config.events[key]; if (!definition) return;
    if (time - (this.last.get(key) ?? -Infinity) < definition.cooldownMs) return;
    this.last.set(key, time);
    if (this.active.length >= this.config.maxActive) this.active.shift();
    this.active.push({ key, position: { ...position }, direction: { ...direction }, time, definition });
  }
  render(time: number) {
    this.graphics.clear();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i], d = item.definition, progress = (time - item.time) / d.durationMs;
      if (progress >= 1) { this.active.splice(i, 1); continue; }
      const radius = d.size * (0.15 + 0.85 * progress), alpha = 1 - progress, origin = item.position;
      this.graphics.lineStyle(d.lineWidth * alpha, d.color, alpha);
      if (d.type === "ring") this.graphics.strokeCircle(origin.x, origin.y, radius);
      else for (let ray = 0; ray < d.count; ray++) {
        const angle = Math.atan2(item.direction.y, item.direction.x) + ray * Math.PI * 2 / d.count;
        const inner = d.type === "star" ? radius * 0.2 : radius * 0.7;
        this.graphics.lineBetween(origin.x + Math.cos(angle) * inner, origin.y + Math.sin(angle) * inner,
          origin.x + Math.cos(angle) * radius, origin.y + Math.sin(angle) * radius);
      }
    }
  }
  snapshot() { return { active: this.active.length, events: this.active.map(effect => effect.key) }; }
  reset() { this.active.length = 0; this.last.clear(); this.graphics.clear(); }
  destroy() { this.reset(); this.graphics.destroy(); }
}
