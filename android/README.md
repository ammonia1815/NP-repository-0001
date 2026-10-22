# 엔피 안드로이드 동반 앱

`엔피_안드로이드_동반앱_계획.md`(플랜 파일)의 Phase 2 구현. 데스크톱 엔피 백엔드(`src/main/http-server.ts`)와 통신하는 최소 채팅 클라이언트.

## 열기/빌드 (이 저장소에는 Android SDK가 없어 직접 빌드/실행은 못 해봤습니다 - Android Studio에서 열면 됩니다)

1. Android Studio에서 이 `android/` 폴더를 "Open" (Gradle sync 시 필요한 SDK 플랫폼/빌드툴을 자동으로 설치 제안함)
2. 최초 sync 시 Gradle wrapper jar가 없다는 경고가 뜨면 Android Studio가 자동으로 다시 생성해줍니다 (또는 시스템에 Gradle이 있다면 `gradle wrapper` 한 번 실행)
3. 에뮬레이터 또는 실기기로 Run

## 먼저 확인할 것 (Phase 2: 같은 와이파이로 테스트)

1. 데스크톱 엔피 앱을 실행한 상태에서, 설정 창(트레이 메뉴 → "아바타 크기 조절")에 추가될 "서버 연결" 섹션에서 API 토큰을 확인 (또는 `%APPDATA%\ai-npc-assistant\settings.json`의 `apiToken` 필드를 직접 확인)
2. 데스크톱 PC의 LAN IP 확인 (예: `ipconfig`로 확인한 `192.168.x.x`)
3. 폰이 같은 와이파이에 연결된 상태에서 앱 최초 실행 → 설정 화면에 서버 주소로 `http://192.168.x.x:8787` 입력, 토큰 붙여넣기 → "저장 및 연결 확인"
4. 정상 연결되면 채팅 화면으로 넘어가고, 이전 대화 기록이 보이고, 메시지를 보내면 엔피가 답하고 음성도 재생됩니다

## Phase 3 (외부 노출) 이후

DDNS + Caddy 설정이 끝나면, 설정 화면에서 서버 주소를 `https://your-name.duckdns.org`로 바꾸기만 하면 됩니다.
