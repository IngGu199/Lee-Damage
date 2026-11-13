export interface SoundEventConfig {
  files: string[];
  volume: number;
  rateRange: [number, number];
  cooldownMs: number;
  maxVoices: number;
  priority: number;
  speedRange?: [number, number | null];
}
export interface SoundConfig {
  version: 1;
  basePath: string;
  masterVolume: number;
  maxConcurrentSounds: number;
  defaults: Omit<SoundEventConfig, "files" | "speedRange">;
  events: Record<string, SoundEventConfig>;
  debris: { volumeScale: number };
}

const defaults = { volume: 0.6, rateRange: [0.96, 1.04] as [number, number], cooldownMs: 80, maxVoices: 2, priority: 1 };
const pack = "sfx/kenney_impact-sounds/";
/** Used only when the user-authored sounds.json is absent or invalid. No JSON is generated. */
export const DEFAULT_SOUND_CONFIG = parseSoundConfig({
  version: 1, basePath: "assets/audio/", masterVolume: 0.8, maxConcurrentSounds: 8, defaults,
  events: {
    "collision.light": { files: [0, 1, 2].map(i => `${pack}impactGeneric_light_00${i}.ogg`), speedRange: [120, 600], volume: 0.25 },
    "collision.medium": { files: [0, 1, 2].map(i => `${pack}impactPunch_medium_00${i}.ogg`), speedRange: [600, 1400], volume: 0.5, priority: 2 },
    "collision.heavy": { files: [0, 1, 2].map(i => `${pack}impactPunch_heavy_00${i}.ogg`), speedRange: [1400, null], volume: 0.8, priority: 3 },
    "death.burst": { files: [`${pack}impactSoft_heavy_000.ogg`, `${pack}impactSoft_heavy_001.ogg`], volume: 0.85, cooldownMs: 100, priority: 4 },
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
function range(value: unknown, path: string, speed = false): [number, number | null] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path}: [최솟값, 최댓값] 형식이 필요합니다.`);
  const min = number(value[0], `${path}[0]`, speed ? 0 : 0.25, speed ? Infinity : 4);
  const max = value[1] === null && speed ? null : number(value[1], `${path}[1]`, min, speed ? Infinity : 4);
  if (speed && max !== null && max <= min) throw new Error(`${path}: 최댓값은 최솟값보다 커야 합니다.`);
  return [min, max];
}
function playback(value: Record<string, unknown>, fallback: typeof defaults, path: string) {
  return {
    volume: number(value.volume ?? fallback.volume, `${path}.volume`, 0, 1),
    rateRange: range(value.rateRange ?? fallback.rateRange, `${path}.rateRange`) as [number, number],
    cooldownMs: number(value.cooldownMs ?? fallback.cooldownMs, `${path}.cooldownMs`, 0, 60000),
    maxVoices: number(value.maxVoices ?? fallback.maxVoices, `${path}.maxVoices`, 1, 32, true),
    priority: number(value.priority ?? fallback.priority, `${path}.priority`, 0, 100, true),
  };
}

/** Validate the agreed format before any audio download; gaps in speed bands mean silence. */
export function parseSoundConfig(input: unknown): SoundConfig {
  const root = object(input, "sounds");
  if (root.version !== 1) throw new Error("version: 지원하는 버전은 1입니다.");
  const basePath = relativePath(root.basePath, "basePath");
  const shared = playback(object(root.defaults ?? {}, "defaults"), defaults, "defaults");
  const definitions = object(root.events, "events"), events: Record<string, SoundEventConfig> = Object.create(null);
  for (const [name, inputEvent] of Object.entries(definitions)) {
    if (!(name.startsWith("collision.") && name.length > 10) && name !== "death.burst")
      throw new Error(`events.${name}: collision.* 또는 death.burst 이벤트가 필요합니다.`);
    const event = object(inputEvent, `events.${name}`);
    if (!Array.isArray(event.files) || !event.files.length) throw new Error(`events.${name}.files: 음원 목록이 필요합니다.`);
    events[name] = { ...playback(event, shared, `events.${name}`),
      files: [...new Set(event.files.map((file, index) => relativePath(file, `events.${name}.files[${index}]`)))],
      ...(name.startsWith("collision.") ? { speedRange: range(event.speedRange, `events.${name}.speedRange`, true) } : {}),
    };
  }
  const bands = Object.entries(events).filter(([, event]) => event.speedRange)
    .sort((a, b) => a[1].speedRange![0] - b[1].speedRange![0]);
  for (let i = 1; i < bands.length; i++) if ((bands[i - 1][1].speedRange![1] ?? Infinity) > bands[i][1].speedRange![0])
    throw new Error(`events.${bands[i][0]}.speedRange: 다른 충돌 속도 범위와 겹칩니다.`);
  return {
    version: 1, basePath: `${basePath.replace(/\/$/, "")}/`,
    masterVolume: number(root.masterVolume ?? 0.8, "masterVolume", 0, 1),
    maxConcurrentSounds: number(root.maxConcurrentSounds ?? 8, "maxConcurrentSounds", 1, 32, true),
    defaults: shared, events,
    debris: { volumeScale: number(object(root.debris ?? {}, "debris").volumeScale ?? 0.35, "debris.volumeScale", 0, 1) },
  };
}

export function collisionEvent(config: SoundConfig, speed: number) {
  if (!Number.isFinite(speed) || speed < 0) return undefined;
  return Object.entries(config.events).find(([, event]) => event.speedRange &&
    speed >= event.speedRange[0] && (event.speedRange[1] === null || speed < event.speedRange[1]))?.[0];
}
