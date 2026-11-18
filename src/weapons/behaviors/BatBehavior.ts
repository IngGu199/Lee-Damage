import type { MeleeWeaponBehavior, StrikeSample } from "./WeaponBehavior";

export const BAT_BEHAVIOR: MeleeWeaponBehavior = {
  kind: "melee", grip: "locked", headOnly: false, knockbackTiming: "afterTick", finisher: "launch",
  frame: ({ shape: s }) => [
    { x: 0, y: -s.width / 2 }, { x: s.length, y: -s.width / 2 },
    { x: s.length, y: s.width / 2 }, { x: 0, y: s.width / 2 },
  ],
  samples: ({ shape: s }) => {
    const samples: StrikeSample[] = [], count = Math.ceil(s.length / (s.width * 0.75));
    for (let i = 0; i <= count; i++)
      samples.push({ local: { x: s.length * i / count, y: 0 }, radius: s.width / 2, tip: i / count });
    return samples;
  },
  hint: definition => `누를 때마다 방망이 생성 · 좌클릭을 누른 채 잡기 · 우클릭마다 ${definition.handling.rotateStepDegrees}° 회전 · 잡은 무기 삭제 X`,
};
