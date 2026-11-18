import Phaser from "phaser";
import { loadSettings, mergeSettings } from "../weapons/WeaponConfig";
import type { Point } from "../weapons/geometry";

interface EffectDefinition { type: string; durationMs: number; size: number; count: number; color: number; lineWidth: number; cooldownMs: number }
interface DamageNumberDefinition {
  enabled: boolean; maxActive: number; durationMs: number; fadeDelayMs: number; riseSpeed: number;
  color: number; fontSize: number; fontFamily: string; strokeColor: number; strokeThickness: number;
}
export interface EffectConfig { version: 1; maxActive: number; defaults: EffectDefinition; events: Record<string, EffectDefinition>;
  damageNumbers: DamageNumberDefinition }
const shared: EffectDefinition = { type: "sparks", durationMs: 260, size: 55, count: 10, color: 0xf4c765, lineWidth: 3, cooldownMs: 0 };
const numberDefaults: DamageNumberDefinition = { enabled: true, maxActive: 96, durationMs: 1000, fadeDelayMs: 150,
  riseSpeed: 75, color: 0xffcf66, fontSize: 30, fontFamily: '"Noto Sans KR Variable", sans-serif', strokeColor: 0x542b21, strokeThickness: 4 };
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
  const damageNumbers = mergeSettings(numberDefaults, root.damageNumbers, "effects.damageNumbers");
  if (!Number.isInteger(damageNumbers.maxActive) || damageNumbers.maxActive < 1 || damageNumbers.maxActive > 256 ||
    damageNumbers.durationMs <= 0 || damageNumbers.durationMs > 10000 || damageNumbers.fadeDelayMs >= damageNumbers.durationMs ||
    damageNumbers.riseSpeed > 2000 || damageNumbers.fontSize < 8 || damageNumbers.fontSize > 160 || damageNumbers.strokeThickness > 20 ||
    [damageNumbers.color, damageNumbers.strokeColor].some(color => !Number.isInteger(color) || color > 0xffffff))
    throw new Error("effects.damageNumbers: 개수·시간·상승 속도·글자 크기·색상·외곽선을 확인하세요.");
  return { version: 1, maxActive, defaults, damageNumbers, events: Object.fromEntries(Object.entries(root.events ?? {})
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

/** Bounded shapes and damage labels, advanced only by simulation time. */
export class ImpactEffects {
  config = DEFAULT_EFFECT_CONFIG;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly active: { key: string; position: Point; direction: Point; time: number; definition: EffectDefinition }[] = [];
  private readonly last = new Map<string, number>();
  private readonly numbers: { text: Phaser.GameObjects.Text; position: Point; amount: number; time: number; definition: DamageNumberDefinition }[] = [];
  constructor(private readonly scene: Phaser.Scene) { this.graphics = scene.add.graphics().setDepth(60); }
  async load(signal: AbortSignal) { this.config = await loadSettings("config/effects.json", DEFAULT_EFFECT_CONFIG, parseEffectConfig, signal); }
  showDamage(position: Point, amount: number, time: number) {
    const d = this.config.damageNumbers;
    if (!d.enabled || !Number.isFinite(amount) || amount <= 0) return;
    if (this.numbers.length >= d.maxActive) this.numbers.shift()!.text.destroy();
    const cssColor = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
    const label = amount < 0.01 ? "<0.01" : amount.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    const text = this.scene.add.text(position.x, position.y, label, {
      fontFamily: d.fontFamily, fontSize: d.fontSize, fontStyle: "bold", color: cssColor(d.color),
      stroke: cssColor(d.strokeColor), strokeThickness: d.strokeThickness,
    }).setOrigin(0.5, 1).setDepth(70).setName("damage-number");
    this.numbers.push({ text, position: { ...position }, amount, time, definition: { ...d } });
  }
  emit(key: string, position: Point, direction: Point, time: number) {
    const definition = this.config.events[key]; if (!definition) return;
    if (time - (this.last.get(key) ?? -Infinity) < definition.cooldownMs) return;
    this.last.set(key, time);
    if (this.active.length >= this.config.maxActive) this.active.shift();
    this.active.push({ key, position: { ...position }, direction: { ...direction }, time, definition });
  }
  render(time: number) {
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const item = this.numbers[i], d = item.definition, elapsed = Math.max(0, time - item.time);
      if (elapsed >= d.durationMs) { item.text.destroy(); this.numbers.splice(i, 1); continue; }
      item.text.y = item.position.y - d.riseSpeed * elapsed / 1000;
      item.text.setAlpha(1 - Math.max(0, elapsed - d.fadeDelayMs) / (d.durationMs - d.fadeDelayMs));
    }
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
  snapshot() { return { active: this.active.length, events: this.active.map(effect => effect.key),
    damageNumbers: this.numbers.map(item => ({ amount: item.amount, position: { ...item.position },
      x: item.text.x, y: item.text.y, alpha: item.text.alpha, text: item.text.text })) }; }
  reset() {
    this.numbers.forEach(item => item.text.destroy()); this.numbers.length = 0;
    this.active.length = 0; this.last.clear(); this.graphics.clear();
  }
  destroy() { this.reset(); this.graphics.destroy(); }
}
