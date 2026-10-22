# AI NPC 0901 — 데스크톱 오버레이 AI 아바타 비서

항상 화면 위에 떠 있는 작은 아바타가 AI와 대화하는 개인용 데스크톱 비서입니다. Claude API와 Gemini API 중 하나를 골라 쓸 수 있습니다.

## 설치 및 실행

1. 의존성 설치
   ```
   npm install
   ```
2. `.env.example`을 `.env`로 복사하고 사용할 provider의 키를 채워넣기
   ```
   copy .env.example .env
   ```
   - Claude를 쓰려면 `ANTHROPIC_API_KEY` (`console.anthropic.com`에서 발급, 종량제 — Claude Pro 구독과는 별개)
   - Gemini를 쓰려면 `GEMINI_API_KEY` (`aistudio.google.com/apikey`에서 무료로 발급, 무료 등급 모델은 토큰 비용이 들지 않음)
3. `config.json`의 `"provider"` 값을 `"anthropic"` 또는 `"gemini"`로 설정 (기본값은 `"gemini"` — 무료로 테스트하기 위함)
4. 실행
   ```
   npm start
   ```

## 사용법

- 화면 우하단에 아바타가 항상 떠 있습니다. 드래그로 위치를 옮길 수 있습니다.
- 아바타의 💬 버튼을 클릭하거나 `Alt+Space`를 누르면 대화창이 열립니다.
- 트레이 아이콘(작업 표시줄 우측 하단)을 우클릭하면 대화창 토글, 클릭 통과 모드, 종료 메뉴가 있습니다.
- `assets/avatar/` 폴더에 직접 만든 GIF를 넣으면 아바타 상태(대기/생각중/기쁨/슬픔/놀람)에 따라 자동으로 바뀝니다. 자세한 파일명 규칙은 `assets/avatar/README.md` 참고. 이미지가 없으면 임시 이모지 아바타가 대신 표시됩니다.
- `config.json`에서 provider, 사용할 모델(Claude/Gemini 각각 따로), 응답 노력 수준(effort, Claude 전용), 비서의 시스템 프롬프트(성격/말투)를 바꿀 수 있습니다.
- 나중에 Claude 크레딧이 충전되면 `config.json`의 `"provider"`를 `"anthropic"`으로 바꾸고 재시작하면 됩니다. 대화 흐름/아바타 동작은 두 provider 모두 동일하게 작동합니다.
- 웹 검색이 연결되어 있어서 날씨, 게임 정보 등 최신 정보가 필요한 질문에도 답할 수 있습니다 (Claude: 내장 web search 툴 / Gemini: Google Search).

## 기억(메모리) 구조

이 앱은 대화를 어느 provider(구글/Anthropic) 서버에도 세션 형태로 저장하지 않습니다. 대신 모든 대화를 로컬(`userData` 폴더의 `history.json`)에만 저장하고, 새 메시지가 오면 그중 **키워드가 겹치는 과거 대화 몇 개만 골라서** 함께 참고하도록 만들어져 있습니다 (`src/main/memory.ts`).

- 무슨 근거로 어떤 기억이 불려오는지 전부 로컬 파일 하나로 확인 가능 (블랙박스 없음)
- 대화가 아무리 쌓여도 매 요청마다 보내는 양은 항상 일정 (오래된 대화를 통째로 다시 보내지 않음)
- 지금은 단순 키워드 겹침 방식이라 "이름", "롤" 같은 명확한 단어는 잘 잡아내지만, 표현이 크게 다르면 놓칠 수 있음 — `memory.ts`의 `findRelevantMemories` 함수만 나중에 더 똑똑한 방식(의미 기반 검색 등)으로 교체하면 나머지 코드는 그대로 두고 업그레이드 가능

## 향후 계획

게임 매크로 제작/감독, 영상 동시 시청, 마인크래프트 동반 플레이 등 대형 기능은 `ROADMAP.md`에 별도로 정리되어 있으며 이번 버전에는 포함되어 있지 않습니다.
