# app-monitor

내가 만든 웹앱들이 살아 있는지 하루 2번(07:00 / 16:00 KST) 자동 점검하고, 대시보드에 녹/황/적으로 표시하는 저장소.

- `apps.json` — 점검할 앱 목록 (여기만 고치면 됨)
- `check.js` — 점검 스크립트 (Node 20, 의존성 없음)
- `.github/workflows/check.yml` — 스케줄 실행 + 결과 커밋
- `index.html` — 대시보드 (GitHub Pages, 빌드 없음)
- `status.json` / `history.json` — 자동 생성되는 결과 파일 (직접 수정 X)
- `gas-ping-snippet.gs` — 각 앱 GAS에 붙일 ping 코드

## 점검 단계

| 단계 | 방법 | 실패 시 |
|---|---|---|
| Pages | GitHub Pages URL GET → 200 + HTML | 적색 |
| GAS | `{exec}?action=ping` → 200 + JSON | 적색 (로그인 리다이렉트면 배포 권한 문제) |
| 데이터 | ping 응답의 `ok:true` (GAS가 시트를 실제로 읽었는지) | 적색 |
| 응답 5초 초과 | — | 황색 |

## 알림

상태가 정상→이상으로 바뀔 때, 복구될 때, 그리고 이상이 4회(2일) 연속될 때마다 Solapi로 문자(LMS) 발송.
Secrets가 없으면 알림 없이 로그만 남김.

## 설정 순서

1. 이 저장소를 GitHub에 올린다 (public 또는 private 모두 가능. private이면 Pages는 Pro 필요).
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `/ (root)`.
3. Settings → Actions → General → Workflow permissions: `Read and write permissions` 체크.
4. Settings → Secrets and variables → Actions → New repository secret:
   - `SOLAPI_API_KEY`, `SOLAPI_API_SECRET` — 기존 알림톡 앱에서 쓰던 값
   - `SOLAPI_FROM` — 발신번호 (등록된 번호, 숫자만)
   - `SOLAPI_TO` — 수신번호 (여러 명이면 쉼표로)
5. `apps.json`의 `PASTE_GAS_EXEC_URL`을 각 앱의 `/exec` URL로 바꾼다. GAS가 없는 앱은 `""`.
6. 각 앱 GAS에 `gas-ping-snippet.gs`의 `ping_` 함수를 붙이고 `doGet` 첫 줄에 분기 추가 → 기존 배포 관리 → 새 버전.
7. Actions 탭 → `App health check` → `Run workflow`로 첫 실행. 1~2분 뒤 `https://<계정>.github.io/app-monitor/` 확인.

## 참고

- 스케줄 cron은 UTC 기준 (`0 22` = 07:00 KST, `0 7` = 16:00 KST). 무료 러너는 수 분~수십 분 늦게 돌 수 있음.
- 매 실행마다 결과를 커밋하므로 저장소가 계속 활성 상태로 유지됨 (GitHub는 60일간 커밋이 없으면 스케줄을 끄는데, 이 구조에선 해당 없음).
- 대시보드는 마지막 검사 후 14시간(`staleHours`)이 지나면 "모니터 자체 이상" 배너를 띄움.
- 검사 시각을 바꾸려면 `check.yml`의 cron만 수정. 느림 기준은 `apps.json`의 `slowMs`.
