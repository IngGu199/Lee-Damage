import type { DamageIntensity } from "../game/DamageSystem";

export interface SoundEventConfig {
  files: string[];
  volume: number;
  rateRange: [number, number];
  maxVoices: number;
  priority: number;
}
export interface SoundConfig {
  version: 1;
  basePath: string;
  masterVolume: number;
  maxConcurrentSounds: number;
  defaults: Omit<SoundEventConfig, "files">;
  events: Record<string, SoundEventConfig>;
  debris: { volumeScale: number };
}

const defaults = { volume: 0.6, rateRange: [0.96, 1.04] as [number, number], maxVoices: 2, priority: 1 };
const pack = "sfx/kenney-impact/";
/** Used only when the user-authored sounds.json is absent or invalid. No JSON is generated. */
export const DEFAULT_SOUND_CONFIG = parseSoundConfig({
  version: 1, basePath: "assets/audio/", masterVolume: 0.8, maxConcurrentSounds: 8, defaults,
  events: {
    "collision.light": { files: [0, 1, 2].map(i => `${pack}impactGeneric_light_00${i}.ogg`), volume: 0.25 },
    "collision.medium": { files: [0, 1, 2].map(i => `${pack}impactPunch_medium_00${i}.ogg`), volume: 0.5, priority: 2 },
    "collision.heavy": { files: [0, 1, 2].map(i => `${pack}impactPunch_heavy_00${i}.ogg`), volume: 0.8, priority: 3 },
    "death.burst": { files: [`${pack}impactSoft_heavy_000.ogg`, `${pack}impactSoft_heavy_001.ogg`], volume: 0.85, priority: 4 },
  },
  debris: { volumeScale: 0.35 },
});

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: 객체가 필요합니다.`);
  return value as Record<string, unknown>;
}
function number(value: unknown, path: string, min: number, max = Infinity, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`${path}: ${min}~${max === Infinity ? "유한한 값" : max} 범위의 ${integer ? "정수" : "숫자"}가 필요합니다.`);
  return value;
}
function relativePath(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim() || /[:\\?#]/.test(value) || value.startsWith("/") ||
    value.split("/").some(part => part === ".." || part === ".")) throw new Error(`${path}: 상대 파일 경로가 필요합니다.`);
  return value;
}
function range(value: unknown, path: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path}: [최솟값, 최댓값] 형식이 필요합니다.`);
  const min = number(value[0], `${path}[0]`, 0.25, 4);
  return [min, number(value[1], `${path}[1]`, min, 4)];
}

function playback(value: Record<string, unknown>, fallback: typeof defaults, path: string) {
  return {
    volume: number(value.volume ?? fallback.volume, `${path}.volume`, 0, 1),
    rateRange: range(value.rateRange ?? fallback.rateRange, `${path}.rateRange`),
    maxVoices: number(value.maxVoices ?? fallback.maxVoices, `${path}.maxVoices`, 1, 32, true),
    priority: number(value.priority ?? fallback.priority, `${path}.priority`, 0, 100, true),
  };
}

/** Events map directly to damage-system intensity. Legacy speed fields are ignored. */
export function parseSoundConfig(input: unknown): SoundConfig {
  const root = object(input, "sounds");
  if (root.version !== 1) throw new Error("version: 지원하는 버전은 1입니다.");
  const basePath = relativePath(root.basePath, "basePath");
  const shared = playback(object(root.defaults ?? {}, "defaults"), defaults, "defaults");
  const definitions = object(root.events, "events"), events: Record<string, SoundEventConfig> = Object.create(null);
  for (const [name, inputEvent] of Object.entries(definitions)) {
    if (!["collision.light", "collision.medium", "collision.heavy", "death.burst"].includes(name))
      throw new Error(`events.${name}: collision.light/medium/heavy 또는 death.burst 이벤트가 필요합니다.`);
    const event = object(inputEvent, `events.${name}`);
    if (!Array.isArray(event.files) || !event.files.length) throw new Error(`events.${name}.files: 음원 목록이 필요합니다.`);
    events[name] = { ...playback(event, shared, `events.${name}`),
      files: [...new Set(event.files.map((file, index) => relativePath(file, `events.${name}.files[${index}]`)))],
    };
  }
  return {
    version: 1, basePath: `${basePath.replace(/\/$/, "")}/`,
    masterVolume: number(root.masterVolume ?? 0.8, "masterVolume", 0, 1),
    maxConcurrentSounds: number(root.maxConcurrentSounds ?? 8, "maxConcurrentSounds", 1, 32, true),
    defaults: shared, events,
    debris: { volumeScale: number(object(root.debris ?? {}, "debris").volumeScale ?? 0.35, "debris.volumeScale", 0, 1) },
  };
}

export function collisionEvent(config: SoundConfig, intensity: DamageIntensity | null) {
  if (!intensity) return undefined;
  const event = `collision.${intensity}`;
  return config.events[event] ? event : undefined;
}
