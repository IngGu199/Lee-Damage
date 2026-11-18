# 프로젝트 구조

2026-11-18 기준. 3·4단계 완료, 5단계 착수 전 정리 상태입니다. 실행·조작은 [README](README.md), 공식·단위·처리 순서는 [계산 규칙](docs/PHYSICS_AND_DAMAGE.md)에 정리합니다.

## 실행 흐름

`index.html` → `src/main.ts` → `PhysicsScene`이 게임과 UI를 연결합니다. `main.ts`는 사진 편집창·설정·단축키·화면 크기·음량을 담당합니다. `PhysicsScene`은 하나의 Matter 월드에서 모든 인형·잔해·무기를 계산하고 피해·오디오·렌더링을 연결합니다.

한 인형의 상태는 `RagdollActor`에 모입니다. `Ragdoll`은 물리 신체, `PostureController`는 정렬·기립, `RagdollLifecycle`은 생성·생존·사망·잔해 상태, `DamageSystem`은 체력·무적·상처 임계값을 관리합니다. 다른 인형과 상태를 공유하지 않습니다.

## 주요 파일

| 위치 | 역할 |
| --- | --- |
| `src/game/config.ts` | 방 크기·물리 스텝·고정 조작 수치·설정·진단 타입 |
| `src/game/matter.ts` | Phaser 내장 Matter 접근·타입 보완·삭제한 물체의 접촉 캐시 정리 |
| `src/game/PhysicsScene.ts` | 월드 스텝·하위 스텝·생성·사망 교체·피해 수신·화면 변경·진단 |
| `src/game/Ragdoll.ts`, `SelfCollision.ts` | 부위·질량·관절·좌표·몸통 연결·경계/겹침 보정 |
| `src/game/PostureController.ts`, `TorsoAlignment.ts`, `PoseRecovery.ts` | 입력 종료 대기·몸통 기준 정렬·안정 대기·기립 |
| `src/game/PointerController.ts`, `PointerVelocity.ts` | 클릭 지점 잡기·포인터 캡처·타임스탬프 기반 던지기 |
| `src/game/ContactMotion.ts`, `ImpactCollector.ts` | 접촉점 속도·단위 변환·충돌 회차·우선순위·사운드 접촉 수집 |
| `src/game/DamageSystem.ts`, `HealthState.ts`, `damageConfig.ts` | 피해식·상한·중복/무적 검사·실제 손실·회복·체력 상수 |
| `src/game/InjuryProgression.ts`, `ImpactAppearance.ts`, `appearanceConfig.ts` | 누적 실제 손실·사진 단계·상처 부착 정보·외형 고정값 |
| `src/game/RagdollActor.ts`, `RagdollLifecycle.ts`, `SpawnLanding.ts`, `DebrisPhysics.ts` | 개별 생명·낙하·생성 보호·회복·잔해 물리·소멸 |
| `src/game/draw.ts`, `FaceRenderer.ts`, `InjuryRenderer.ts` | 신체·얼굴·상처·선택 상태 표시 |
| `src/weapons/WeaponSystem.ts` | 다중 무기·잡기/회전·근접 명중·탄알·크기 변경·삭제 |
| `src/weapons/WeaponConfig.ts`, `geometry.ts` | JSON 상속·검증·피해 상한 선택·근접 피해식·연속 충돌 |
| `src/weapons/WeaponSkins.ts`, `WeaponFinishers.ts` | 사진 텍스처·충돌 조각·무기별 마지막 타격 연출 |
| `src/effects/ImpactEffects.ts` | JSON 타격 효과·실제 손실 숫자·동시 표시 상한·리소스 정리 |
| `src/audio/ImpactAudio.ts`, `SoundConfig.ts`, `SoundMixer.ts` | 음량/음소거·파일 버퍼·신호·속도 구간·쿨다운·오디오 재생 |
| `src/photo/PhotoEditor.ts`, `PhotoSession.ts`, `PhotoLibrary.ts` | 편집 UI·임시 사진 수명·저장된 사진 목록 |
| `src/photo/FaceAnalyzer.ts`, `PhotoVariants.ts` | 지연 로딩 얼굴 분석·미리 만든 변형 사진 |
| `src/photo/PhotoTransform.ts`, `PhotoContour.ts`, `PhotoGeometry.ts`, `PhotoAlpha.ts` | 좌표 변환·윤곽 편집·다각형 자르기/볼록 분해·알파 윤곽 |
| `tools/photoLibrary.ts` | 개발 서버 사진 목록·빌드의 `images/catalog.json` 생성 |
| `vite.config.ts` | 사진 목록 플러그인·개발 서버에서만 선택적 로컬 저장 확장 로딩 |
| `public/config/` | 사용자 무기·이펙트·사운드 JSON과 설정 설명서 |
| `public/images/`, `public/assets/`, `public/models/` | 배포에 포함되는 사진·음원·상처·얼굴 모델 |
| `tests/` | 현재 물리·피해·다중 인형·사진·사운드·무기·UI 회귀 검사 |
| `docs/` | 계산 규칙·Sites 가능성·이번 정리 결과·과거 기록 |

## 경계와 수정 원칙

피해 상한은 `WeaponConfig.damageLimit()`에서 하나를 고르고 `DamageSystem.capDamage()`에서 적용합니다. 근접 타격도 원래 피해를 계산한 뒤 화면/JSON 우선순위를 적용합니다. 중간 단계에서 JSON 상한을 먼저 적용하지 않습니다.

속도 단위는 `ContactMotion`으로 모았습니다. 충돌 전 피해는 하위 스텝 속도, 충돌 후 음량은 60Hz 정규화 속도를 사용합니다. 두 측정 시점을 합치거나 자세 보정 이동을 실제 충돌 속도로 사용하지 않습니다.

다각형 자르기·오목한 윤곽 분해는 `PhotoGeometry`, 빠른 무기·탄알 연속 충돌은 `weapons/geometry`가 담당합니다. 사진 표시와 충돌 조각은 같은 편집 윤곽에서 생성합니다.

5단계의 점수 연결 지점은 `PhysicsScene.receiveHit()`의 실제 손실 결과입니다. 저장은 별도 진행 데이터로 만들고 사진 세션과 분리합니다. 현재 구현에는 점수·콤보·해금 시스템이 없습니다.

## 개발 진단과 로컬 확장

`/?diagnostics`에서만 `window.__physicsLab`를 노출합니다. 회귀 검사는 이 진단 인터페이스로 게임 루프를 멈추고 실제 프로덕션 스텝을 결정적으로 진행합니다. 일반 접속에는 전역 진단 객체를 만들지 않습니다.

`.local/image-save/`는 Git 제외 확장이며 정적 빌드와 독립적입니다. 사진 목록·업로드·편집에는 필요하지 않습니다. `dist/`와 테스트 산출물도 Git에서 제외합니다. Sites용 `.openai/hosting.json`은 실제 사이트 등록 때 반환된 ID로 만들며 이번 가능성 확인에서는 생성하지 않았습니다.

과거 비교용 실험 1, 관절 지연 모터, `JointRepair`는 제거했습니다. 채택된 몸통 정렬 경로와 잔해의 자기 충돌 해제만 유지합니다. 이전 구현 이력은 [보관 문서](docs/archive/README.md)에 남겼습니다.
