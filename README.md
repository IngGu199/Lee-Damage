# Lee Damage — 물리 실험실

PC 브라우저용 슬랩스틱 게임의 **1단계 내부 물리 시제품**입니다. Phaser 3.90에 내장된 Matter로 방 1개, 도형 인형 1개를 구현합니다. 사진·얼굴 워핑·무기·점수·음향은 후속 단계입니다.

## 실행

Node.js 22.12 이상을 권장합니다. 현재 검증 환경은 Node.js 22.23.1 / npm 12.1.0입니다.

```bash
npm ci
npm run dev
```

터미널에 표시된 주소(기본 `http://localhost:5173`)로 접속합니다. 처음 실행할 때만 의존성 설치가 필요합니다.

```bash
npm run check          # TypeScript 검사
npm run build          # 타입 검사 및 dist/ 정적 빌드
npm run preview        # 빌드 결과 미리 보기
npx playwright install chromium  # 브라우저 테스트 최초 준비
npm test              # 실제 브라우저 입력·물리 안정성 검증
```

## 조작

| 조작 | 동작 |
| --- | --- |
| 잡기 도구 / `1` | 신체를 누른 채 끌기·흔들기. 놓으면 현재 속도로 던지기 |
| 밀치기 도구 / `2` | 신체를 클릭하면 클릭한 쪽의 반대 방향과 위쪽으로 충격 |
| 재배치 / `R` | 신체·관절·속도를 초기화. 설정과 일시정지 상태는 유지 |
| `Space` / 일시정지 버튼 | 물리·입력 일시정지 또는 계속하기 |
| 창 전환 | 잡는 연결 해제 및 자동 일시정지. 계속하기로 수동 재개 |
| 중력·탄성·밀치는 힘 | 실시간 물리 실험용 조절 |
| 관절·물리 표시 | 관절 연결점·충돌 외곽·속도 방향 표시 |

입력 요소나 버튼에 포커스가 있으면 해당 요소의 기본 키 동작을 우선합니다. 단축키를 사용하려면 게임 화면 또는 빈 곳에 포커스를 둡니다. PC용이며 모바일 터치는 별도 검증하지 않았습니다.

## 문서

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md): 전체 파일 구조, 역할, 데이터 흐름, 수정 위치
- [PROTOTYPE_REPORT.md](PROTOTYPE_REPORT.md): 구현 범위, 검증 결과, 한계, 다음 단계 결정 사항
- [DEV_PLAN.md](DEV_PLAN.md): 단계별 개발 계획 및 현재 상태
- [GAME_PLAN.md](GAME_PLAN.md): 게임 기획 및 기술 설계

## 기술 선택

TypeScript + Vite + HTML/CSS, Phaser 3.90.0의 단일 Matter 엔진을 사용합니다. 기존 계획의 Phaser 3 API와의 호환성을 위해 3.90.0을 고정했습니다. 별도 `matter-js` 패키지, 서버 API, 사진 업로드, 로컬 저장 기능은 없습니다. 실행 중 외부 이미지나 글꼴도 요청하지 않습니다.

물리는 120Hz 고정 간격이며 렌더링 주기와 분리됩니다. 강한 입력은 포인터 연결점 이동 제한과 속도 제한으로 조절합니다. 이상 좌표·방 이탈·과도한 관절 벌어짐은 자동 재배치하고 복구 횟수를 표시합니다. 이 방어 기능은 실제 조작 튜닝을 대신하지 않습니다.

공식 참고: [Phaser Matter](https://docs.phaser.io/phaser/concepts/physics/matter), [Vite](https://vite.dev/guide/).
