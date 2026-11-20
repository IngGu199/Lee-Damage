import type { MeleeWeaponBehavior } from "./WeaponBehavior";

export const HAMMER_BEHAVIOR: MeleeWeaponBehavior = {
  kind: "melee", grip: "pivot", headOnly: true, knockbackTiming: "immediate", finisher: "burst",
  frame: ({ shape: s }) => {
    const left = s.length - s.headWidth / 2, right = s.length + s.headWidth / 2;
    return [
      { x: 0, y: -s.width / 2 }, { x: left, y: -s.width / 2 }, { x: left, y: -s.headHeight / 2 },
      { x: right, y: -s.headHeight / 2 }, { x: right, y: s.headHeight / 2 }, { x: left, y: s.headHeight / 2 },
      { x: left, y: s.width / 2 }, { x: 0, y: s.width / 2 },
    ];
  },
  samples: ({ shape: s }) => {
    const radius = Math.min(s.headWidth, s.headHeight) / 2, span = s.headHeight / 2 - radius;
    return [-span, 0, span].map(y => ({ local: { x: s.length, y }, radius, tip: 1 }));
  },
  hint: () => "사진 목록을 연 뒤 다시 눌러 망치 소환 · 원하는 지점을 클릭해 잡기 · 잡은 무기 삭제 X",
};
