import type { BombWeaponBehavior } from "./WeaponBehavior";

export const BOMB_BEHAVIOR: BombWeaponBehavior = {
  kind: "bomb", finisher: "burst", knockbackTiming: "immediate",
  frame: ({ shape }) => {
    const r = shape.width / 2;
    return [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }];
  },
  hint: () => "폭탄 모드 선택 · 게임 화면 우클릭으로 폭탄 생성 · 좌클릭으로 기존 폭탄 잡기",
};
