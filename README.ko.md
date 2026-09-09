*[English](README.md) · 한국어*

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img alt="" src="docs/logo.svg" width="88">
</picture>

# reflect

reflect 는 코딩 에이전트가 **실제로 무엇을 했는지**를 트랜스크립트에서 읽어 SQLite 에 넣고, 주 1회 그
집계를 바탕으로 구체적인 개선 제안을 만든다. 모든 주장은 `GROUP BY` 결과이고, 추측은 없다.

[Claude Code](https://claude.com/claude-code) 용으로 만들었다. [bun](https://bun.sh) 으로 실행하고
런타임 의존성은 없다(`bun:sqlite`, `Bun.spawn`). macOS·Linux·Windows 에서 동작한다.

## 동작 방식

![reflect 동작 방식](docs/architecture.svg)

루프 두 개가 데이터베이스 하나를 공유한다.

**매 턴.** Claude Code 턴이 끝나면 Stop 훅이 그 세션 트랜스크립트에서 지난 실행 이후 추가된 바이트만
읽어, 시크릿을 가리고 SQLite 에 넣는다. `reflect stats` 와 TUI 는 이 테이블을 그대로 읽는다. 훅 안에서
계산하는 것은 없다.

**매주.** `reflect weekly` 가 마이너 12개를 최근 30일 데이터에 돌린다. 결과가 나온 마이너마다 제안 파일
하나가 `~/.claude-reflect/proposals/` 에 생기는데, 집계 숫자를 넘겨 모델 호출 한 번으로 쓴다. 열 종류는
사람이 `reflect queue` 에서 읽는 제안이다. 나머지 두 종류(`CLAUDE.md` 드리프트, 정정 클러스터)는
에이전트 프롬프트를 바꿀 수 있는 문장이라 판정을 거친다 — 초안 3개, 초안마다 반박 투표 3표, 만장일치가
아니면 버린다. 살아남은 초안은 롤백 사본을 남긴 뒤 `learned-rules.md` 나 프로젝트 메모리 파일 끝에
붙는다. `~/.claude/CLAUDE.md` 가 그 파일을 `@` 로 import 하므로 다음 세션은 그 규칙이 프롬프트에 든
상태로 시작한다. 그림의 되돌아가는 화살표가 이것이다.

## 무엇을 기록하나

수집원은 `~/.claude/projects/**/*.jsonl` 하나다. 파일마다 바이트 오프셋을 기억해 증분으로 읽고, 자연키
`INSERT OR IGNORE` 로 넣기 때문에 다시 돌려도 행이 중복되지 않는다.

| 테이블 | 한 행 = | 담는 것 |
|---|---|---|
| `sessions` | 세션 1개 | cwd·git 브랜치·버전·시작과 끝 시각 |
| `tool_calls` | 툴 호출 1회 | 툴 이름·입력 JSON·에러 여부·스킬/플러그인/MCP 출처 |
| `model_turns` | 모델 호출 1회 | 모델·입력·캐시 read/create·출력·**thinking**·service tier |
| `hook_events` | 훅 실행 1회 | 훅 이름·이벤트·종료 코드·소요 시간 |
| `permission_events` | 차단 1회 | 차단 종류·대상 툴 |
| `corrections` | 정정 후보 1건 | 걸린 키워드와 앞 300자 |
| `io_refs` (뷰) | 참조 1회 | 파일·URL·스킬·MCP 리소스·메모리 파일 |

`io_refs` 는 테이블이 아니라 `tool_calls.input_json` 과 `path_refs`(Bash 명령에 적힌 메모리 파일)를
풀어 보는 뷰다. 같은 사실을 두 곳에 저장하지 않는다. `memory_snapshot`/`memory_changes` 는 Stop 훅
사이에 생기고 바뀌고 지워진 메모리 파일을 기록한다 — 셸 변수로 쓴 파일은 트랜스크립트에 경로가 남지
않기 때문이다.

⚠️ **승인 횟수는 셀 수 없다.** 권한 프롬프트를 승인하면 트랜스크립트에 아무 흔적이 남지 않는다.
`permission_events` 는 마찰만 잰다 — 무엇이 무엇에게 막혔는가.

## 토큰 최적화

```sh
reflect stats tokens                     # 모델별 누적
reflect stats tokens --since 2026-09-01  # 기간 지정
reflect stats mcp                        # MCP 서버·툴과 실패율
reflect stats io                         # 반복해서 참조하는 것
```

진단은 두 컬럼으로 한다.

- **`avg_cache_read`** — 턴마다 다시 읽는 상주 컨텍스트: 시스템 프롬프트, `CLAUDE.md`, 스킬, 툴 정의.
  이 값이 크면 비용은 대화가 아니라 **설정**에서 나온다.
- **`thinking_pct`** — 출력 토큰 중 추론에 쓴 비율. `effortLevel` 설정이 숫자로 드러난다.

## 제안 루프

```sh
reflect collect   # 증분 수집
reflect verify    # 커버리지와 행 손실 확인
reflect propose   # 마이닝 -> 초안 -> 판정 -> 적용
reflect queue     # 검토 대기 중인 제안
reflect weekly    # 위 전부 — 스케줄러가 부르는 명령 하나
```

마이너 12개가 SQL 로 신호를 뽑는다: 훅 마찰, 거절한 툴, 실패한 훅, 안 쓰는 스킬, 에러율 높은 툴,
반복되는 정정, 반복되는 툴 시퀀스, `CLAUDE.md` 드리프트, 메모리 위생, 정정 클러스터, 마찰 많은 세션,
휴면 워크스페이스.

근거는 최근 30일(`window_days`)이고, 서브에이전트 호출은 빼서 제안이 메인 루프의 행동을 겨눈다.
마이너 셋은 기간을 무시한다 — 「한 번도 안 씀」, 파일 나이, 마지막 활동처럼 시간 자체가 판단 기준이기
때문이다.

12개 중 둘은 숫자가 아니라 문장을 만들기 때문에 무인 판정을 거친다. 관점 셋(최소 수정·근본 원인·명료성)으로
초안 셋을 만들고, 초안마다 반박 투표 셋을 받아 **만장일치**만 남긴다. 2표 기준은 재현되지 않았다 —
같은 입력이 주마다 적용과 기각 사이를 오갔다.

🔴 **적용은 append-only 다.** 모델에 파일 전체를 다시 쓰게 하지 않는다 — 보여주지 않은 부분을 재현할
수 없기 때문이다. 모델은 새 섹션 하나만 쓰고 reflect 가 이어 붙인다. 제목 줄로 시작하지 않는 응답은
「덧붙일 것 없음」으로 보고 어디에도 쓰지 않는다. 대상 파일은 적용 전에 `~/.claude-reflect/rollback/`
에 백업한다.

## 설정과 provider

```sh
reflect                          # 설정 화면(TUI) — 모든 줄이 Enter 로 피커를 연다
reflect config                   # 현재 값과 출처
reflect config provider codex    # 값 저장
reflect config language ko       # 모델이 제안을 쓰는 언어 (기본 en)
reflect providers                # 설치됐나? 로그인됐나?
reflect login                    # provider 를 고르고 그 CLI 의 로그인 명령 실행
reflect login codex --api-key    # 브라우저 대신 $OPENAI_API_KEY 를 넘긴다
reflect logout claude
```

우선순위는 **환경변수 > `~/.claude-reflect/config.json` > 기본값**
(`REFLECT_PROVIDER`, `REFLECT_JUDGE_MODEL`, `REFLECT_WINDOW_DAYS`, `REFLECT_LANGUAGE`).

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `provider` | `claude` | 판정과 합성을 돌리는 헤드리스 CLI (`claude`, `codex`) |
| `judge_model` | claude 에서 `sonnet` | 초안과 투표에 쓰는 모델 — 버리는 작업이라 기본 모델을 쓰지 않는다 |
| `window_days` | `30` | 제안이 보는 기간(일) |
| `language` | `en` | 생성되는 제안과 규칙의 언어 |
| `auto_apply` | `false` | 판정을 통과한 제안을 검토 없이 `learned-rules.md`·메모리에 쓸지 |

`auto_apply` 가 꺼져 있으면(기본값) 판정 결과를 제안 파일 옆에 `<이름>.apply.md` 로 저장하고 큐에
남긴다. `reflect apply <대상> <그 파일>` 로 반영한다. 에이전트 프롬프트의 일부인 파일이 매주 무인으로
바뀌는 것을 받아들일 때만 켠다.

reflect 는 자격증명을 저장하지 않는다. 각 CLI 의 로그인 명령(`claude auth login`, `codex login`)을
대신 실행하고, 자격증명은 그 CLI 의 저장소에 남는다. 로그인은 브라우저 승인이 필요해 터미널에서 직접
해야 한다. API 키는 인자로 받지 않는다(`ps` 에 보인다). `--api-key` 는 provider 환경변수에서 읽어
stdin 으로 넘긴다.

## 설치

```sh
bun install.ts            # 어느 OS 든: 코드 배치, `reflect` 진입점 생성, 훅 등록
bun install.ts --check    # 훅 등록 상태
bun install.ts --remove   # 훅 해제
```

훅 명령은 bash·jq 없이 `bun <cli.ts> <명령>` 을 직접 부른다. 그래서 Windows 에서도 돌고, cron 처럼
PATH 가 얇은 환경에서도 깨지지 않는다. `settings.json` 은 백업 뒤 원자적으로 교체하고, 다시 실행해도
훅이 두 번 등록되지 않는다.

| 이벤트 | 명령 | 하는 일 |
|---|---|---|
| Stop | `_stop-hook` | 그 턴의 트랜스크립트만 수집 |
| SessionStart, Stop | `memory-sync` | 프로젝트 메모리(`type: feedback`/`user`) → `learned-rules.md` |
| SessionStart | `friction-check` | 최근 마찰과 대기 중인 제안 알림 |

훅은 항상 0 으로 끝난다. 기록 때문에 세션이 막히는 일은 없어야 한다.

두 단계가 남는다.

1. 규칙 파일을 `~/.claude/CLAUDE.md` 에서 import 한다. 이 줄이 없으면 판정을 통과한 규칙이 세션에
   들어가지 않는다.
   ```
   @~/.claude-reflect/learned-rules.md
   ```
2. `reflect weekly` 를 스케줄러에 건다.
   ```
   # macOS/Linux — cron (래퍼가 cron 에 없는 PATH 와 USER 를 채운다)
   0 9 * * 1 $HOME/.claude/tools/reflect/reflect_weekly.sh >> $HOME/.claude/tools/reflect/weekly.log 2>&1
   # Windows — 작업 스케줄러, 주 1회
   bun C:\Users\<you>\.claude\tools\reflect\src\cli.ts weekly
   ```

Claude Code 스킬(`~/.claude/skills/reflect/`)도 함께 설치된다. 「토큰이 어디로 나가나」, 「provider 를
codex 로 바꿔」처럼 말로 물으면 에이전트가 맞는 명령을 실행한다.

## 데이터는 밖으로 나가지 않는다

- 전부 로컬 SQLite(`~/.claude-reflect/reflect.db`)에 있다. 업로드 경로는 없다.
- 데이터베이스에는 툴 입력 — 셸 명령, 편집한 파일 내용 — 이 건당 4,000자까지 들어간다. 셸 히스토리
  파일처럼 다룬다.
- 헤드리스 판정 호출은 툴·MCP 서버·사용자 설정·훅 없이 뜬다
  (`--tools "" --strict-mcp-config --setting-sources ""`). 프롬프트에 트랜스크립트에서 온 텍스트가
  들어가므로, 지시문이 섞여 들어와도 실행할 도구가 없다. 호출당 컨텍스트도 약 86k 토큰에서 3k 로 줄어든다.
- 시크릿은 적재 전에 정규식으로 가린다: API 키, 토큰, JWT, `Bearer`, `password=`.
- 사용자 메시지는 저장하지 않는다. 정정 키워드에 걸린 문장의 앞 300자만 남긴다.
- 모델을 부르는 것은 판정과 합성만이고, 넘기는 것은 집계 숫자와 제안 본문이다.

## 한계

- `tool_calls.input_json` 은 4,000자에서 잘린다. 잘린 행은 `io_refs` 에서 빠진다.
- Bash 명령 문자열 안의 경로는 뽑지 않는다. 메모리 파일(`~/.claude/projects/*/memory/*.md`)만 예외다.
- 시퀀스 마이너는 한 세션 안의 반복만 세고, 핵심 로컬 툴 쌍(`Bash`, `Read`, `Write`, `Edit`…)은
  건너뛴다. 그건 코딩의 리듬이지 자동화할 대상이 아니다.
- 훅 명령 문자열은 200자까지 저장한다. 식별은 `hook_name` 이 맡는다.
- TUI 는 raw 모드에 `stty` 를 쓴다. bun 의 `setRawMode` 가 pty 아래에서 멈추기 때문이다(bun 1.3.14).
  `stty` 가 없는 Windows 에서는 `setRawMode`, 그다음 번호 입력으로 내려간다.
- macOS 에서 테스트했다. Linux·Windows 경로는 처리했지만 실제 기기에서는 확인하지 않았다.

## 개발

```sh
bun test              # 동작 검사, 모델 호출 없음
bunx tsc --noEmit     # 타입 검사 (devDependencies 만)
```

## 라이선스

MIT
