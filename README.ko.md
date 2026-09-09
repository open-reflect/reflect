*[English](README.md) · 한국어*

# reflect

코딩 에이전트가 **실제로 무엇을 했는지** 트랜스크립트에서 긁어 SQLite 에 적재하고, 그 집계만 근거로
주 1회 개선 제안을 만든다. 추측이 아니라 `GROUP BY` 가 근거다.

[Claude Code](https://claude.com/claude-code) 용. [bun](https://bun.sh) 으로 돌고 런타임 의존성이
없다(`bun:sqlite`, `Bun.spawn`). macOS·Linux·Windows.

## 무엇을 기록하나

수집원은 `~/.claude/projects/**/*.jsonl` 하나다. 파일별 바이트 오프셋으로 증분 수집하고 자연키
`INSERT OR IGNORE` 가 멱등성을 보증한다.

| 테이블 | 한 행 = | 담기는 것 |
|---|---|---|
| `sessions` | 세션 1개 | cwd·git 브랜치·버전·기간 |
| `tool_calls` | 툴 호출 1회 | 툴명·입력 JSON·에러 여부·스킬/플러그인/MCP 귀속 |
| `model_turns` | 모델 호출 1회 | 모델·input·cache_read·cache_create·output·**thinking**·service_tier |
| `hook_events` | 훅 실행 1회 | 훅명·이벤트·종료코드·소요 ms |
| `permission_events` | 차단 1회 | denial kind·대상 툴 |
| `corrections` | 정정 발화 후보 1개 | 매칭 키워드와 앞 300자 |
| `io_refs` (뷰) | 참조 1회 | 파일·URL·스킬·MCP 리소스·메모리 파일 |

`io_refs` 는 `tool_calls.input_json` 을 꺼내는 뷰다 — 같은 사실을 두 곳에 저장하지 않는다.

⚠️ **승인 횟수는 원리적으로 못 잰다.** 승인된 권한 프롬프트는 트랜스크립트에 흔적이 없다.
`permission_events` 는 마찰(차단)만 센다.

## 토큰 최적화

```sh
reflect stats tokens                     # 모델별 누적
reflect stats tokens --since 2026-09-01  # 기간 한정
reflect stats mcp                        # MCP 서버·툴 실패율
reflect stats io                         # 무엇을 반복해서 여나
```

두 칸이 진단의 핵심이다 — **`avg_cache_read`**(턴마다 다시 읽는 상주 컨텍스트. 크면 대화가 아니라
**설정**이 비용이다), **`thinking_pct`**(출력 중 추론 비율. `effortLevel` 이 그대로 드러난다).

## 제안 파이프라인

```sh
reflect collect   # 증분 수집
reflect verify    # 커버리지·행 감소 확인
reflect propose   # 마이닝 -> 초안 -> 판정 -> 적용
reflect queue     # 승인 대기 목록
reflect weekly    # 위 전부 — 스케줄러가 부르는 한 명령
```

마이너 12종이 SQL 로 신호를 뽑는다 — 훅 마찰, 사람이 거절한 툴, 실패한 훅, 미사용 스킬, 높은 에러율 툴,
반복 정정 발화, 반복 툴콜 시퀀스, `CLAUDE.md` 드리프트, 메모리 위생, 정정 클러스터, 세션 마찰, 휴면
워크스페이스. 근거는 최근 30일(`window_days`)이고 서브에이전트 호출은 뺀다.

정성 제안 2종은 무인 판정을 거친다 — 관점 3개로 초안, 초안마다 반박 3표, **만장일치만** 생존.

🔴 **적용은 append-only 다.** 모델에 파일 재출력을 시키지 않는다 — 못 본 부분을 재현할 방법이 없다.
새 섹션 하나만 받아 이어 붙이고, 제목 줄로 시작하지 않는 응답은 「덧붙일 것 없음」으로 본다.
적용 전 원본은 `~/.claude-reflect/rollback/` 에 남는다.

## 설정과 provider

```sh
reflect                          # 설정 화면(TUI) — 모든 줄이 Enter 로 피커를 연다
reflect config                   # 현재 값과 출처
reflect config provider codex
reflect config language ko       # 제안·규칙을 쓰는 언어 (기본 en)
reflect providers                # 설치·로그인 상태
reflect login                    # provider 를 골라 그 CLI 의 로그인 명령 실행
reflect login codex --api-key    # 브라우저 대신 $OPENAI_API_KEY 를 stdin 으로
reflect logout claude
```

우선순위는 **환경변수 > `~/.claude-reflect/config.json` > 기본값**
(`REFLECT_PROVIDER`·`REFLECT_JUDGE_MODEL`·`REFLECT_WINDOW_DAYS`·`REFLECT_LANGUAGE`).

| 설정 | 기본 | 뜻 |
|---|---|---|
| `provider` | `claude` | 판정·합성을 보낼 헤드리스 CLI (`claude`·`codex`) |
| `judge_model` | claude 면 `sonnet` | 초안·투표용 모델 — 버리는 작업이라 기본 모델을 안 쓴다 |
| `window_days` | `30` | 제안 근거 기간 |
| `language` | `en` | 생성되는 제안·규칙의 언어 |
| `auto_apply` | `false` | 판정 통과 제안을 확인 없이 `learned-rules.md`·메모리에 쓸지 |

`auto_apply` 가 꺼져 있으면(기본) 판정 결과를 제안 파일 옆 `<이름>.apply.md` 로 저장하고 큐에 남긴다 —
`reflect apply <대상> <그 파일>` 로 사람이 반영한다. 에이전트 프롬프트의 일부인 파일을 매주 무인으로
바꾸는 것을 받아들일 때만 켠다.

reflect 는 자격증명을 저장하지 않는다. 각 CLI 의 로그인 명령(`claude auth login`·`codex login`)을
대신 실행하고 자격증명은 그 CLI 저장소에 남는다. API 키는 인자로 받지 않는다(`ps` 에 보인다) —
`--api-key` 는 환경변수에서 읽어 stdin 으로만 넘긴다.

## 설치

```sh
bun install.ts            # 어느 OS 든 — 코드 배치 + `reflect` 진입점 + 훅 등록
bun install.ts --check    # 훅 등록 상태
bun install.ts --remove   # 해제
```

훅 명령은 **bash·jq 없이** `bun <cli.ts> <명령>` 을 직접 부른다 — 윈도우에도 그대로 걸리고 cron 처럼
PATH 가 얇은 자리에서도 깨지지 않는다. `settings.json` 은 백업 후 원자적으로 교체하며 중복 등록되지 않는다.

| 이벤트 | 명령 | 하는 일 |
|---|---|---|
| Stop | `_stop-hook` | 그 턴 트랜스크립트만 증분 수집 |
| SessionStart · Stop | `memory-sync` | 프로젝트 메모리(`feedback`·`user`) → `learned-rules.md` |
| SessionStart | `friction-check` | 최근 마찰·대기 제안 알림 |

주간 실행은 `reflect weekly` 하나다. macOS·Linux 는 cron 에 `reflect_weekly.sh`(cron 에 없는
PATH·USER 를 채운다)를, Windows 는 작업 스케줄러에 `bun <cli.ts> weekly` 를 건다.

## 데이터는 나가지 않는다

전부 로컬 SQLite(`~/.claude-reflect/reflect.db`). 시크릿은 적재 전 정규식으로 마스킹하고, 사용자 발화
전문은 저장하지 않는다(정정 키워드에 걸린 앞 300자만). 단 툴 입력 — 셸 명령·편집한 파일 내용 — 은
4,000자까지 그대로 들어간다. 셸 히스토리 파일처럼 다룰 것.

판정 호출은 툴·MCP·사용자 설정·훅 없이 뜬다(`--tools "" --strict-mcp-config --setting-sources ""`).
프롬프트에 트랜스크립트에서 온 텍스트가 들어가므로 지시문이 섞여도 실행할 도구가 없어야 한다.
상주 프롬프트가 빠져 호출당 컨텍스트가 약 86k → 3k 토큰으로 줄어드는 효과도 있다.

## 한계

- `input_json` 은 4,000자에서 잘린다. Bash 명령문 속 경로는 뽑지 않는다.
- TUI 는 raw 모드에 `stty` 를 쓴다 — bun 의 `setRawMode` 가 pty 에서 멈춘다(bun 1.3.14). 윈도우는
  `setRawMode` → 번호 입력 순으로 내려간다.
- macOS 에서만 실기기 검증했다. Linux·Windows 경로는 처리했지만 확인하지 않았다.

## 라이선스

MIT
