# pi-sh-tool

Shell-контур для ванильного pi **без pi-fabric**: prose-контракт исполнения
(four-backtick `sh` блок последним в сообщении), auto-detach долгих команд в
фон, session-owner gate, сессионная шина `pbus`. Порт `pi-fabric-sh-tool`,
из которого вырезана движковая зависимость.

## Отличия от pi-fabric-sh-tool

- Ноль зависимости от pi-fabric: тулы регистрируются через `pi.registerTool`
  на ванильном хосте; `pi-fabric/highlight` заменён на plain-text стаб
  (`extensions/highlight-stub.ts`).
- Gate — минимальный fallback (`bash --norc -n` parse check + pass-through
  postProcess): shell-policy фасад фабрики не подключён. Каналы
  (`pi-fabric:shell-policy:*:v1`) оставлены как есть — на ванильном хосте
  отвечают unavailable и ветка fallback срабатывает by design.
- Мост `FABRIC_SOCK`/`ai`/`fab` сюда не входит — peers/memory решаются
  отдельными пакетами (pi-messenger, pi-transcript-recall — см. PLAN.md
  в `~/projects/pi-fresh`).

## Вызов сервисов из шелл-контура

FABRIC_SOCK был RPC к сервисам движка. Ванильная сборка инвертирует транспорт:
состояние — файлы в проекте (fs = транспорт), доставка — хостовый extension API
(`pi.sendMessage` + `deliverAs:"steer"`), вычисление — шина сессии. Каждый
сервис несёт свой CLI, эргономика plain shell commands сохраняется:

| Нужно | Тул (in-guest) | Из шелла |
|---|---|---|
| memory recall/expand | `memory_recall` / `memory_expand` (pi-transcript-recall) | `pi-recall '...'` (standalone, lazy-индекс) |
| субагент | `Agent` (pi-subagents) | `pbus agents spawn <agent> '<task>'` (`--bg` = хендл + wake) |
| steer субагента | `steer_subagent` | `pbus agents steer <id> '<msg>'` |
| peers presence | тула pi-messenger | `peer ls` (тонкий клиент поверх его файлов) |
| peer steer | тула pi-messenger | `peer send` → inbox-файл → получатель просыпается через `deliverAs:"steer"` |
| MCP | — | mcporter (без изменений) |

Сервис tools шины вооружается первым `tools_call` (ограничение API хоста):
до него `pbus call` отвечает actionable-ошибкой, а `pbus list/describe`
работают всегда. Дети наследуют env и ездят той же шиной. По умолчанию контур
bare — ноль туловых ходов с первого хода; режимы: `PI_SH_WARM=1` —
прогревочный якорь + мост; `PI_SH_BUS_ARM=1` — якорь на каждом ходу;
`PI_SH_TOOL_KEEP_SURFACE=1` — смешанная поверхность. `/bus-warm` — ручной
прогрев; футер: `⇅ pbus` (вооружён) / `· pbus` (холоден). Память — `pi-recall`.
`pi -p` — антипаттерн-зонд, не механизм.

## pbus — единый клиент шины

`bin/pbus` — один клиент, одна шина (`PI_BUS_SOCK`), два сервиса:
tools (`{"tool","args"}` → executeTool) и agents (`{"method","params"}` →
event-bus RPC pi-subagents, без arming). Плюс generic-люк `rpc` на любой
метод и computed help из живого реестра.

```sh
pbus                                 # живой help: N tools + methods
pbus list | describe <tool>          # реестр тулов (динамично)
pbus call bash --command='echo hi'
pbus rpc ping                        # generic: любой метод шины
pbus agents list                     # персоны (fs-проекция discovery-корней)
pbus agents spawn oracle 'скажи: жив'          # блокинг: ответ в stdout
cat charter.md | pbus agents spawn researcher -
pbus agents spawn oracle 'задача' --bg         # фон: хендл (runId, asyncDir)
pbus agents steer|status|stop|resume <id>      # жизненный цикл прогона
pbus agents cost
```

Выходы: 0 ok/complete · 1 failed/ok:false · 2 usage/client · 3 timeout.
E2E (хост `pi --mode rpc`): computed help, list, rpc ping, spawn argv+stdin
(10–24с), проектные персоны в листинге — чисто.

## Установка

```sh
pi install -l ../pi-sh-tool        # проектно (после grant trust)
# или разово:
pi -ne -e ../pi-sh-tool -p '...'
```

Требуются peer-зависимости хоста: `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`. Built-ins отключаются через
`defaultTools: []` (user-level settings).

## Документация и скиллы

- `AGENTS.md` — рабочий контракт модели в контуре (prose-договор, ground rules).
- `.agents/skills/shell-prose/SKILL.md` — полный контракт prose-исполнения.
- `.agents/skills/workflow-sh/SKILL.md` — фан-аут воркеров (`pbus agents spawn`)
  одним проверенным sh-скриптом + adversarial verify.
- `.agents/skills/rlm-sh/SKILL.md` — рекурсивная декомпозиция больших корпусов.
- `.pi/agent-env.sh` — per-project `BASH_ENV`: PATH-контекст для каждого
  спавна шелла (подхватывается `extensions/shell-exec.ts`, телеметрия —
  `.pi/calls.jsonl`, gitignored).

## Разработка

```sh
bun test                 # 206 тестов (порт лабораторного сьюта)
bin/verify-then-commit -- <git-args>   # зелёный сьют как гейт коммита
```

## Проверка

```sh
pi -ne -e . -p 'Run exactly this single command: echo probe-ok'
```
