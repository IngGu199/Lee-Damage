import type { RangedWeaponBehavior } from "./WeaponBehavior";

export const GUN_BEHAVIOR: RangedWeaponBehavior = {
  kind: "ranged", knockbackTiming: "immediate", finisher: "pin",
  frame: ({ shape: s }) => {
    const left = -s.length / 2, right = s.length / 2, grip = left + s.width * 0.65;
    return [
      { x: left, y: -s.width / 2 }, { x: right, y: -s.width / 2 }, { x: right, y: s.width / 2 },
      { x: grip, y: s.width / 2 }, { x: grip, y: s.width * 1.5 }, { x: left, y: s.width * 1.5 },
    ];
  },
  hint: () => "사진 목록을 연 뒤 다시 눌러 마우스 위치에 총 소환 · 좌클릭으로 모든 총 발사 · 다른 도구를 선택하면 총 일괄 삭제",
};
