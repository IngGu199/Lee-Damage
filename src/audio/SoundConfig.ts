export type CollisionSoundTarget = "body" | "wall";

export interface SoundEventConfig {
  files: string[];
  volume: number;
  rateRange: [number, number];
  cooldownMs: number;
  maxVoices: number;
  priority: number;
  speed?: [number, number];
  "sound-size"?: [number, number];
}
export type SoundEventDefinition = SoundEventConfig | SoundEventConfig[];

export function soundVariants(definition: SoundEventDefinition): SoundEventConfig[] {
  return Array.isArray(definition) ? definition : [definition];
}
export interface SoundConfig {
  version: 1;
  basePath: string;
  masterVolume: number;
  maxConcurrentSounds: number;
  defaults: Omit<SoundEventConfig, "files" | "speed" | "sound-size">;
  events: Record<string, SoundEventDefinition>;
  debris: { volumeScale: number };
}

const defaults = { volume: 0.6, rateRange: [0.96, 1.04] as [number, number], cooldownMs: 0, maxVoices: 2, priority: 1 };
const pack = "sfx/kenney-impact/";
/** Used only when the user-authored sounds.json is absent or invalid. No JSON is generated. */
export const DEFAULT_SOUND_CONFIG = parseSoundConfig({
  version: 1, basePath: "assets/audio/", masterVolume: 0.8, maxConcurrentSounds: 8, defaults,
  events: {
    "collision.normal": { files: ["sfx/others/hard-punch-sound.m4a"], speed: [0, 2400], "sound-size": [0, 1] },
    "collision.wall": { files: [0, 1, 2, 3, 4].map(i => `${pack}wall-00${i}.ogg`), speed: [0, 2400], "sound-size": [0, 1] },
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

function interval(value: unknown, path: string, strict = false): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path}: [최솟값, 최댓값] 형식이 필요합니다.`);
  const min = number(value[0], `${path}[0]`, 0), max = number(value[1], `${path}[1]`, min);
  if (strict && max === min) throw new Error(`${path}: 최댓값은 최솟값보다 커야 합니다.`);
  return [min, max];
}

function playback(value: Record<string, unknown>, fallback: typeof defaults, path: string) {
  return {
    volume: number(value.volume ?? fallback.volume, `${path}.volume`, 0, 1),
    rateRange: range(value.rateRange ?? fallback.rateRange, `${path}.rateRange`),
    cooldownMs: number(value.cooldownMs ?? fallback.cooldownMs, `${path}.cooldownMs`, 0),
    maxVoices: number(value.maxVoices ?? fallback.maxVoices, `${path}.maxVoices`, 1, 32, true),
    priority: number(value.priority ?? fallback.priority, `${path}.priority`, 0, 100, true),
  };
}

/** Collision audio uses post-solve speed independently of HP damage. */
export function parseSoundConfig(input: unknown): SoundConfig {
  const root = object(input, "sounds");
  if (root.version !== 1) throw new Error("version: 지원하는 버전은 1입니다.");
  const basePath = relativePath(root.basePath, "basePath");
  const shared = playback(object(root.defaults ?? {}, "defaults"), defaults, "defaults");
  const definitions = object(root.events, "events"), events: Record<string, SoundEventDefinition> = Object.create(null);
  for (const [name, inputEvent] of Object.entries(definitions)) {
    if (!["collision.normal", "collision.wall", "death.burst"].includes(name))
      throw new Error(`events.${name}: collision.normal, collision.wall 또는 death.burst 이벤트가 필요합니다.`);
    const collision = name.startsWith("collision."), multiple = collision && Array.isArray(inputEvent);
    const inputs = multiple ? inputEvent : [inputEvent];
    if (!inputs.length) throw new Error(`events.${name}: 속도 구간 목록은 비어 있을 수 없습니다.`);
    const variants = inputs.map((input, index) => {
      const path = `events.${name}${multiple ? `[${index}]` : ""}`, event = object(input, path);
      if (!Array.isArray(event.files) || !event.files.length) throw new Error(`${path}.files: 음원 목록이 필요합니다.`);
      return { ...playback(event, shared, path),
        files: [...new Set(event.files.map((file, index) => relativePath(file, `${path}.files[${index}]`)))],
        ...(collision ? {
          speed: interval(event.speed, `${path}.speed`, true),
          "sound-size": interval(event["sound-size"], `${path}.sound-size`),
        } : {}),
      };
    });
    if (multiple) {
      const sorted = [...variants].sort((a, b) => a.speed![0] - b.speed![0]);
      for (let index = 1; index < sorted.length; index++)
        if (sorted[index].speed![0] < sorted[index - 1].speed![1])
          throw new Error(`events.${name}: speed 구간이 겹칩니다.`);
    }
    events[name] = multiple ? variants : variants[0];
  }
  return {
    version: 1, basePath: `${basePath.replace(/\/$/, "")}/`,
    masterVolume: number(root.masterVolume ?? 0.8, "masterVolume", 0, 1),
    maxConcurrentSounds: number(root.maxConcurrentSounds ?? 8, "maxConcurrentSounds", 1, 32, true),
    defaults: shared, events,
    debris: { volumeScale: number(object(root.debris ?? {}, "debris").volumeScale ?? 0.35, "debris.volumeScale", 0, 1) },
  };
}

/** Lower bound inclusive, upper bound exclusive; silence outside, linear gain inside. */
export function collisionGain(event: SoundEventConfig, speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0 || !event.speed || !event["sound-size"]) return 0;
  const [min, max] = event.speed, [quiet, loud] = event["sound-size"];
  if (speed < min || speed >= max) return 0;
  return quiet + (loud - quiet) * ((speed - min) / (max - min));
}
