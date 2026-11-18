# JSON 설정 안내

이 폴더에서 기본 이미지·무기·탄알·타격 이펙트·사운드를 설정한다. 파일을 저장한 뒤 브라우저를 새로고침하면 적용된다. 게임 실행 중 파일을 다시 읽거나 자동 수정하지 않는다.

| 파일 | 조절하는 항목 |
| --- | --- |
| [images.json](images.json) | 시작할 때 사용하는 랙돌 얼굴·방망이·망치·총·탄알 이미지 |
| [weapons.json](weapons.json) | 무기·충돌별 데미지 상한, 무기 모양·질량·회전·피해량·밀쳐짐·탄알·마지막 타격 연출·신호 |
| [effects.json](effects.json) | 신호별 화면 이펙트와 피격 위치에 떠오르는 데미지 숫자 |
| [sounds.json](sounds.json) | 신호별 음원·음량·속도 구간·재생 간격·동시 재생 수 |
| [SOUNDS.md](SOUNDS.md) | 기존 사운드 안내를 옮긴 상세 설명서. 충돌음 규칙과 무기 타격음 추가 예시 |

## 먼저 찾을 항목

| 바꾸고 싶은 것 | JSON 경로 | 현재 설정 |
| --- | --- | --- |
| 총알 속도 | `weapons.json` → `defaults.projectile.speed` | `1100`px/s. 총은 현재 이 값을 상속한다 |
| 총알 고정 데미지 | `weapons.json` → `defaults.projectile.damage` | `120`. 총 몸체의 `damage.amount`와 다름 |
| 총별 발사 간격 | `weapons.json` → `defaults.projectile.fireIntervalMs` | `180`ms |
| 방망이 밀쳐짐 | `weapons.json` → `weapons.bat.damage.knockback` | `2200`px/s |
| 망치 추가 밀쳐짐 | `weapons.json` → `weapons.hammer.damage.knockback` | `60`px/s. 물리 엔진의 충돌 반응은 별도로 더해짐 |
| 망치 반발 | `weapons.json` → `weapons.hammer.physics.restitution` | `0.02`. 랙돌 접촉의 반발 상한에도 사용 |
| 잡은 방망이 우클릭 회전량 | `weapons.json` → `defaults.handling.rotateStepDegrees` | `15`도 |
| 총의 벽 고정 후 폭발 대기 | `weapons.json` → `defaults.finisher.pinDelayMs` | `2000`ms |
| 무기 타격음 | `sounds.json` → `events["weapon.bat.hit"]` 등 | 전용 항목이 없으면 기존 충돌음을 임시 재사용 |
| 타격 이펙트 | `effects.json` → `events["weapon.bat.hit"]` 등 | 신호마다 별도 설정 |
| 무기별 데미지 상한 | `weapons.json` → `weapons.bat/hammer/gun.damage.maxDamage` | 공통 `defaults.damage.maxDamage`는 `350`. 총은 탄알 한 발마다 적용 |
| 벽·바닥·인형·시체 충돌 상한 | `weapons.json` → `collision.<조건>.maxDamage` | 방·생체 충돌 `180`, 시체 충돌 `12` |
| 데미지 숫자 | `effects.json` → `damageNumbers` | 지속 `1000`ms, 상승 `75`px/s, 글자 크기 `30`px |

위 수치는 문서 작성 시의 파일 기준이며 사용자 변경 후에는 실제 JSON 값이 우선한다.

## images.json: 기본 이미지

`version`은 `1`이며 경로는 `public/`를 제외한 앱 시작 경로 기준으로 작성한다. 한글 파일명도 그대로 사용할 수 있다. PNG·JPEG·WebP를 지원한다.

```json
{
  "version": 1,
  "face": "images/face-노망.png",
  "bat": "images/bat-테러단.png",
  "hammer": "images/hammer-코스피5000시대돌입.png",
  "gun": "images/gun-젠슨황의크고우람한총.png",
  "bullet": "images/bullet-5090.png"
}
```

얼굴을 바꾸려면 `face` 경로를 다른 사진으로 바꾼다. 예를 들어 `images/face-드럼통.png`를 사용할 수 있다. 특정 대상을 `null`로 지정하거나 생략하면 기본 도형을 사용한다. `bullet`이 `null`인 경우 기존 `weapons.json`의 `projectile.image` 설정이 있으면 그 이미지를 사용하며, 둘 다 없으면 원형 탄알이다. `images.json`의 탄알 이미지가 있으면 우선한다.

기본 이미지는 시작·새로고침 때 불러온다. 투명도와 원본 비율을 유지하고 무기·탄알의 보이는 윤곽을 충돌에 사용한다. 얼굴의 물리 머리는 기존 원형이다. 기본 얼굴은 위치·크기·윤곽을 유지하면서 기준점만 검출하고, 한 얼굴이 검출되면 피격 변형 사진도 생성한다. 여러 얼굴이 검출되면 편집창에서 사용할 얼굴을 선택한다. 분석에 실패해도 원래 사진을 유지한다. 무기·탄알에는 얼굴 분석을 실행하지 않는다.

플레이 중 사진 편집으로 교체할 수 있고, 재배치·새 인형·새 무기에도 적용한 사진을 유지한다. **기본 얼굴로 / 기본 이미지로**는 이 파일의 이미지로 복원한다. 설정이 없는 무기는 **기본 도형으로**를 표시한다. 사용자 사진은 새로고침하면 해제하고 설정한 기본 이미지를 다시 읽는다.

파일이 없거나 사진을 읽지 못하면 해당 대상만 도형으로 표시한다. 설정 JSON 자체가 없거나 잘못되면 모든 대상을 도형으로 시작한다. 정적 배포에 변경 사항을 반영하려면 다시 빌드해야 한다.

## weapons.json: 공통값과 무기별 값

`version`은 `1`이다. `defaults`는 모든 무기의 공통값이며 `weapons.bat`, `weapons.hammer`, `weapons.gun`의 같은 필드가 이를 덮어쓴다. 그룹 안의 일부 필드만 작성해도 다른 필드는 상속한다. 같은 JSON 키를 두 번 작성하지 않는다.

총알 속도가 `weapons.gun` 안에 보이지 않는 이유는 **`defaults.projectile.speed`를 상속하기 때문**이다. 총에만 속도를 명시하려면 기존 `weapons.gun` 객체 안에 다음 항목을 추가한다. 아래는 전체 파일을 교체하는 예시가 아닌 추가할 항목이다.

```json
"projectile": {
  "speed": 700
}
```

이 경우 총은 `700`px/s로 발사하고 탄알 크기·데미지·수명 등은 기존 공통값을 따른다. `projectile.speed`는 화면 속도를 바꾸며 **총알 데미지는 `projectile.damage`의 고정값**을 사용한다. 근접 무기의 `damage.minSpeed`는 탄알 고정 데미지의 발생 조건이 아니다. 화면의 최대 데미지 입력은 한 발마다 적용하며, 총알은 충돌·근접 타격의 300ms 무적시간과 관계없이 한 발당 한 번 피해를 준다. 총알은 충돌용 무적시간을 만들거나 연장하지 않는다.

### 데미지 상한과 우선순위

상단 **최대 데미지**는 정수 입력이다. 시작값은 기존과 같은 `180`이며 다음 순서로 상한 하나만 선택한다. 상한은 피해를 늘리는 고정 데미지가 아니라 계산된 피해를 제한하는 값이다.

1. 화면 입력이 `0` 이상이면 그 값이 모든 충돌·무기·탄알의 최우선 상한이다. JSON 상한과 비교해 작은 값을 선택하지 않는다. `0`은 무적이며 속도 계산식·물리·사운드는 유지한다.
2. 화면 입력이 `-1`이면 화면 공통 상한만 해제하고 아래 JSON의 해당 조건별 상한을 적용한다.
3. JSON 상한도 `-1`이면 해당 조건은 상한 없이 원래 데미지 식을 따른다. 실제 체력 차감은 남은 HP를 넘지 않는다.

예를 들어 총알 피해가 `120`, `weapons.gun.damage.maxDamage`가 `50`이라면 화면 입력 `100`일 때 한 발당 `100`, `-1`일 때 `50`이다. JSON 상한을 `200`으로 바꿔도 원래 피해가 `120`이면 `120`만 차감한다. 입력란을 비우거나 `-2` 같은 잘못된 값을 쓰는 동안에는 마지막 유효값을 유지하고, 포커스를 벗어나면 그 값으로 복원한다.

| `weapons.json` 경로 | 대상 |
| --- | --- |
| `collision.left.maxDamage` | 왼쪽 벽 |
| `collision.right.maxDamage` | 오른쪽 벽 |
| `collision.ceiling.maxDamage` | 천장 |
| `collision.floor.maxDamage` | 바닥 |
| `collision.body.maxDamage` | 살아 있는 다른 랙돌과의 충돌 |
| `collision.debris.maxDamage` | 시체·분리 잔해와의 충돌. 원래 충돌식의 15%로 계산한 뒤 상한 적용 |
| `collision.room.maxDamage` | 면 정보가 없는 방 충돌의 예비값. 위 네 면의 설정을 일괄 변경하는 항목은 아님 |
| `weapons.bat.damage.maxDamage` | 야구방망이 타격 |
| `weapons.hammer.damage.maxDamage` | 망치 타격 |
| `weapons.gun.damage.maxDamage` | 총알 한 발. 총 몸체에는 타격 피해가 없음 |

JSON의 `maxDamage`는 `-1` 또는 `0`~`1000000`의 유한한 숫자다. 무기별 값을 생략하면 `defaults.damage.maxDamage`를 상속한다. `collision`은 무기 `defaults`와 별도이며 생략한 조건은 코드 기본값을 사용한다. 변경은 저장 후 새로고침하면 적용된다. 충돌 최소 속도·무적시간·근접 무기 접촉 간격은 상한 해제와 별개로 유지한다.

### 이름·조작·모양

| 필드 | 의미·단위·범위 |
| --- | --- |
| `label` | 무기 버튼에 표시할 이름 |
| `handling.rotateStepDegrees` | 잡은 방망이를 우클릭 한 번에 회전시킬 각도. 도 단위, `0` 초과~`180` 이하. 벽을 넘는 회전은 적용하지 않음 |
| `shape.length` | 방망이/망치 손잡이/총 몸체 길이. 게임 좌표 px, `20`~`400` |
| `shape.width` | 몸체 두께. px, `4`~`100` |
| `shape.headWidth`, `shape.headHeight` | 망치 머리 크기. 각각 px, `10`~`200` |
| `shape.angle` | 최초 생성 각도. 라디안. `0`은 오른쪽으로 수평, 양수는 화면에서 시계 방향 |
| `shape.color`, `shape.headColor` | 몸체·망치 머리 색. `"#a9794b"` 같은 6자리 RGB 문자열 또는 `0`~`16777215` 정수 |

화면의 실제 표시 px는 방의 확대·축소에 따라 달라지며, 속도·크기 설정은 게임 좌표 기준이다.

### 물리

| 필드 | 의미·단위·범위 |
| --- | --- |
| `physics.handleMass` | 방망이 전체 또는 망치 손잡이 질량. `0`보다 큰 값 |
| `physics.headMass` | 망치 머리 질량. `0`보다 큰 값. 무게중심과 회전 반응에 영향을 주며 데미지 배수로 직접 곱하지 않음 |
| `physics.frictionAir` | 공기 저항. `0`~`0.2`, 클수록 움직임이 빨리 감쇠 |
| `physics.maxAngularSpeed` | 자유 회전 각속도 상한. rad/s, `0`~`60` |
| `physics.restitution` | 반발 계수. `0`~`1`. 랙돌 접촉에서는 이 값과 기존 접촉 반발 제한 중 작은 값을 상한으로 사용 |
| `physics.friction` | 동마찰 계수. `0`~`1` |
| `physics.frictionStatic` | 정마찰 계수. `0`~`10` |

망치는 실제 클릭 지점을 잡고 무게에 따라 회전한다. 방망이는 잡는 동안 각도를 유지하며 우클릭으로만 방향을 조절한다. 놓으면 두 물건 모두 자유 낙하·회전한다. 물리 반응은 상대 신체의 질량과 재질에도 영향을 받는다.

### 근접 타격과 밀쳐짐

| 필드 | 의미·단위·범위 |
| --- | --- |
| `damage.amount` | 기준 속도에서의 근접 기본 데미지. 총 몸체는 사용하지 않음 |
| `damage.minSpeed` | 근접 타격 최소 속도. px/s. 현재 공통값 `800`, 미만이면 무기 피해가 없음 |
| `damage.referenceSpeed` | 기본 데미지의 기준 속도. px/s, `0`보다 큰 값 |
| `damage.speedExponent` | 속도 증가에 따른 데미지 곡선의 지수. `0`~`4` |
| `damage.maxDamage` | 화면 입력이 `-1`일 때 사용할 무기별 상한. 총은 탄알에도 적용. `-1`이면 해당 무기 상한 해제 |
| `damage.handleMultiplier`, `damage.tipMultiplier` | 손잡이 쪽·끝부분 피해 배수. 방망이는 접촉 위치에 따라 보간하며 망치는 기본 `1`/`1` |
| `damage.hitCooldownMs` | 같은 근접 무기가 같은 인형을 다시 타격할 수 있는 최소 간격. ms. 지속 접촉의 반복 타격은 막고 분리 후 재접촉해야 함. 탄알에는 적용하지 않음 |
| `damage.knockback` | 타격 방향에 더할 속도. px/s. 근접 무기에서 `0`이면 랙돌과의 물리적 밀어냄도 끄고 타격 판정만 수행. 양수이면 물리 충돌 반응에 추가 밀쳐짐을 더함 |
| `damage.hitDebris` | 분리된 잔해도 무기 타격 대상으로 삼을지. `true`/`false` |

기본 근접 식은 `amount × (타격 속도 / referenceSpeed)^speedExponent × 위치 배수`이며 화면 또는 JSON에서 선택된 상한으로 마지막에 한 번 제한한다. 방망이는 접촉 속력을 사용하고, 망치는 접촉 지점의 상대 속도에서 랙돌을 향해 부딪히는 방향의 성분만 사용한다. 망치는 직선 이동·내려찍기·던지기도 타격이 된다.

### 탄알: projectile

| 필드 | 의미·단위·범위 |
| --- | --- |
| `projectile.speed` | 탄알 이동 속도. px/s, `0` 초과~`10000` 이하 |
| `projectile.radius` | 원형 탄알 반지름. px, `1`~`40` |
| `projectile.damage` | 탄알 한 발의 고정 데미지. `0` 이상 |
| `projectile.lifetimeMs` | 발사 후 최대 비행 시간. ms, `0`~`30000` |
| `projectile.fireIntervalMs` | 같은 총의 발사 간격. ms, `0` 이상 |
| `projectile.maxCount` | 총 하나가 발사해 동시에 비행 중일 수 있는 탄알 수. `1`~`128` 정수. 여러 총은 각각 별도의 상한을 가짐 |
| `projectile.color` | 기본 원형 색상. 6자리 RGB 문자열 또는 RGB 정수 |
| `projectile.image` | 원형 위에 표시할 선택적 이미지 경로. 예: `"assets/skins/bullet.png"`는 `public/assets/skins/bullet.png`. `null`이면 기본 원형. 충돌 모양은 계속 원형 |

여러 총은 각 위치에서 마우스를 조준하고 좌클릭 시 발사 가능한 총이 함께 발사한다. 새 총을 만들어도 기존 총의 발사 간격은 초기화되지 않는다. 다른 도구를 고르면 고정 총은 모두 삭제하지만 이미 발사한 탄알은 계속 움직인다. C는 비행 중 탄알도 함께 삭제한다.

탄알 세 발이 동시에 맞으면 세 발을 모두 계산한다. 예를 들어 한 발 피해가 120이면 세 발은 총 360이며, 최대 데미지 입력이 50이면 각각 50씩 총 150이다. 입력이 0이면 체력은 줄지 않는다. 각 탄알은 최초 명중 부위에서 한 번만 처리한 뒤 소멸하며, 이미 죽은 인형에 중복 사망 처리를 하지 않는다.

### 마지막 타격 연출: finisher

| 필드 | 의미·단위·범위 |
| --- | --- |
| `finisher.speed` | 방망이 홈런 또는 총의 벽 이동 연출 속도. px/s |
| `finisher.upwardSpeed` | 방망이 홈런에 더하는 상승 속도. px/s |
| `finisher.flightMs` | 화면 이탈/벽 도달까지의 최대 연출 시간. ms, `0`~`10000` |
| `finisher.scatterSpeed` | 망치 사망·총 고정 후 폭발에서 조각에 더하는 비산 속도. px/s |
| `finisher.spin` | 비산 조각에 적용하는 회전 속도. rad/s |
| `finisher.pinDelayMs` | 총의 마지막 타격에서 벽 도착 후 폭발까지 대기. ms, `0`~`30000` |

일반 타격의 `damage.knockback`과 마지막 타격의 비산·홈런은 독립적이다. 실제 HP가 0이 된 경우에만 마지막 타격 연출을 실행한다.

### 신호: signals

`signals.hit/finish/fire/pin/burst`는 사운드·화면 이펙트에 전달할 이벤트 이름이다. `weapon.무기ID.신호` 형식이며, 기본 예시는 `weapon.bat.hit`, `weapon.hammer.finish`, `weapon.gun.fire`다.

이름을 바꾸면 `sounds.json`과 `effects.json`의 `events` 키도 같은 이름으로 맞춘다. 이름만 새로 추가한다고 새로운 타격 동작이 생기지는 않으며 코드에서 해당 신호를 발생시키는 시점이 있어야 한다. 지원 시점과 음원 추가 절차는 [사운드 안내](SOUNDS.md#무기-타격-사운드-추가)를 참고한다.

## effects.json: 타격 이펙트

`version`은 `1`이다. `defaults`는 공통 이펙트 값이며 `events["weapon.bat.hit"]`처럼 신호별 객체가 덮어쓴다. 사운드와 동일한 신호를 사용하되 화면 효과와 소리의 설정·쿨다운은 서로 독립적이다.

| 필드 | 의미·단위·범위 |
| --- | --- |
| `maxActive` | 동시에 유지할 이펙트 수. `1`~`256` 정수, 기본 `96`. 넘으면 오래된 것부터 교체 |
| `type` | `star`: 별 모양 선, `ring`: 퍼지는 원, `sparks`: 퍼지는 선 조각 |
| `durationMs` | 이펙트 지속 시간. ms, `0` 초과~`10000` 이하 |
| `size` | 확산 크기. 게임 좌표 px, `0`~`600` |
| `count` | 선 조각 수. `0`~`64` 정수. `ring`에는 사용하지 않음 |
| `color` | 6자리 RGB 문자열 또는 RGB 정수 |
| `lineWidth` | 선 두께. px, `0`~`30` |
| `cooldownMs` | 같은 신호의 이펙트 생성 간격. ms, `0` 이상. `0`이면 간격 제한 없음 |

현재 이펙트는 기본 도형이며 이미지 경로 필드는 없다. 일시정지 중에는 지속 시간도 정지한다.

### 피격 데미지 숫자: damageNumbers

최상위 `damageNumbers` 객체에서 설정한다. 무기 신호의 `events`와 독립적이며 방·인형·시체·모든 무기의 **실제 HP 손실**이 발생한 좌표에 표시한다. 상한·무적·남은 HP를 적용한 값이며, 피해가 없거나 같은 타격이 중복 보고되면 숫자를 만들지 않는다. 처음에는 진한 굵은 글씨이고 위로 이동하며 사라진다. 표시는 소수 둘째 자리까지 반올림하고, 양수 `0.01` 미만은 `<0.01`로 표시한다.

| 필드 | 의미·단위·범위 |
| --- | --- |
| `enabled` | 숫자 표시 여부. `true`/`false`. 데미지 계산에는 영향 없음 |
| `maxActive` | 숫자 동시 표시 상한. `1`~`256` 정수. 기본 `96`, 넘으면 오래된 숫자부터 제거 |
| `durationMs` | 생성부터 완전히 사라질 때까지. `0` 초과~`10000`ms, 기본 `1000` |
| `fadeDelayMs` | 처음 불투명하게 유지할 시간. `0` 이상이며 `durationMs`보다 작아야 함. 기본 `150` |
| `riseSpeed` | 위로 올라가는 속도. `0`~`2000`px/s, 기본 `75`. `0`이면 제자리에서 소멸 |
| `color` | 글씨 색. 6자리 RGB 문자열 또는 RGB 정수. 기본 `"#ffcf66"` |
| `fontSize` | 글씨 크기. `8`~`160`px, 기본 `30` |
| `fontFamily` | 브라우저 글꼴 이름. 기본 `"\"Noto Sans KR Variable\", sans-serif"`. 굵은 글씨로 표시 |
| `strokeColor` | 글씨 외곽선 색. 기본 `"#542b21"` |
| `strokeThickness` | 외곽선 두께. `0`~`20`px, 기본 `4`. `0`이면 외곽선 없음 |

시간·좌표는 게임 시뮬레이션 기준이다. 일시정지·사진 편집 중에는 이동과 소멸도 멈추고, 재배치 R은 모든 숫자를 제거한다. 도형 이펙트의 `cooldownMs`는 데미지 숫자에 적용하지 않는다.

## sounds.json: 음원과 경로

설정은 `public/config/sounds.json`, 음원은 `public/assets/audio/`에 둔다. 기존 음원·사용자 설정은 이동 과정에서 바꾸지 않았다.

```text
public/
  config/
    README.md
    SOUNDS.md
    weapons.json
    effects.json
    sounds.json
  assets/audio/sfx/
    kenney-impact/
    others/
```

`basePath: "assets/audio/"`는 배포 앱의 시작 경로를 기준으로 하므로 설정 파일을 옮겨도 바꾸지 않는다. `files: ["sfx/others/hard-punch.mp3"]`는 그 뒤에 붙는 음원 경로다. `public/`, 맨 앞 `/`, `../`는 넣지 않는다.

`sounds.json`에서는 `masterVolume`, `maxConcurrentSounds`, 공통 `defaults`, 신호별 `events`, `debris.volumeScale`을 설정한다. 충돌음은 `speed`와 `sound-size`가 필수이며, 무기 소리는 두 필드를 생략한 고정 음량도 가능하다. 음원·속도 구간·무기 타격음·쿨다운·동시 재생 수의 전체 규칙과 예시는 [SOUNDS.md](SOUNDS.md)에 정리했다.

## 오류와 적용 범위

- JSON에서는 주석·마지막 항목의 불필요한 쉼표를 사용할 수 없다. 설정 키는 대소문자를 구분한다.
- 크기·물리·신호·타입 등이 잘못되면 콘솔에 원인을 알리고 해당 파일 전체를 코드의 기본 설정으로 대체한다. 음원 하나가 없으면 해당 음원을 제외하고 사용 가능한 후보를 재생한다.
- 무기·이펙트는 지원하는 필드만 허용한다. 임의의 이름을 추가해도 기능이 자동으로 생기지 않는다.
- HP 최대값, 회복량, 충돌·근접 타격의 `300ms` 무적은 현재 이 폴더의 JSON 설정 항목이 아니다. 탄알은 이 무적시간을 적용받지 않는다. 무기의 `hitCooldownMs`나 사운드의 `cooldownMs`를 바꿔도 충돌용 무적시간은 바뀌지 않는다.
