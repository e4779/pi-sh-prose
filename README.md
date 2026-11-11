# pi-sh-tool

Shell-контур для ванильного pi **без pi-fabric**: один тул `shell`, prose-контракт
исполнения (four-backtick `sh` блок последним в сообщении), auto-detach долгих
команд в фон, session-owner gate. Порт `pi-fabric-sh-tool`, из которого вырезана
движковая зависимость.

## Отличия от pi-fabric-sh-tool

- Ноль зависимости от pi-fabric: тул регистрируется через `pi.registerTool`
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
(`pi.sendMessage` + `deliverAs:"steer"`), вычисление — одноразовый `pi -p`.
Каждый сервис несёт свой CLI, эргономика plain shell commands сохраняется:

| Нужно | Тул (in-guest) | Из шелла |
|---|---|---|
| memory recall/expand | `memory_recall` / `memory_expand` (pi-transcript-recall) | `pi-recall '...'` (standalone, lazy-индекс) |
| субагент | `Agent` (pi-subagents) | `pit call Agent '{...}'` (через sh-bridge; `background:true` = job + wake-card) |
| steer субагента | `steer_subagent` | — |
| peers presence | тула pi-messenger | `peer ls` (тонкий клиент поверх его файлов) |
| peer steer | тула pi-messenger | `peer send` → inbox-файл → получатель просыпается через `deliverAs:"steer"` |
| MCP | — | mcporter (без изменений) |

`pit call <tool> [--key=value ...] ['<json>']` — универсальный вызов ЛЮБОГО тула
расширения из шелла. Мост самопрогревается: пока холоден, первый ход сессии
несёт единственный якорь (`tools_call` + строка инструкции в промпте) — модель
вызывает его внутри своего первого ответа, и поверхность возвращается к строгому
нулю. `/pit-warm` — ручной прогрев по команде; футер показывает связь:
`⇅ pit` (вооружён) / `· pit` (холоден). По умолчанию контур bare — ни одного
тулового хода с первого хода (мост холоден навсегда, `/pit-warm` объясняет);
память — шелл-командой `pi-recall`. Режимы: `PI_SH_WARM=1` — прогревочный
якорь на первом ходу + мост для pit; `PI_SH_PIT_ARM=1` — якорь на каждом ходу;
`PI_SH_TOOL_KEEP_SURFACE=1` — смешанная поверхность без редукции.
шелла (per-session сокет `PI_TOOLS_SOCK`, 0600; внутри хоста это
`ctx.executeTool` — включая tools с exposure `callable`, которых нет на
модельной поверхности). Дети (`pi -p`, субагентные шеллы) наследуют env и
могут делегировать так же. `pi -p` сам по себе — one-shot «новый сеанс с
нуля», субагентом он не является.

## picmd — extension commands from sh blocks

Первая строка блока `picmd /<command> <args>` не попадает в bash: остаток уходит в
`pi.sendUserMessage(..., { expandPromptTemplates: true, deliverAs: 'followUp' })` —
единственный API-путь, где pi исполняет extension-команды. Дверь к pi-subagents
(`picmd /run reviewer <task>`, `--bg`, форк, персоны) без тулов и без моста,
 bare-совместимо. Эффекты и дети приходят сообщениями (E2E: oracle, 29с).

## pi-run — unix-дверь к субагентам

`bin/pi-run` — пайпабельная команда: глагол `{"method","params"}` в сокет
моста (`PI_TOOLS_SOCK`) → официальный event-bus RPC pi-subagents
(`subagents:rpc:v1:*`: spawn/steer/status/stop/resume/cost). Arming не нужен —
шина отвечает с session_start. Блокирующий режим опрашивает
`asyncDir/status.json` и печатает ответ ребёнка из summary-лога прогона.

```sh
pi-run researcher < charter.md       # блокирующе: ответ ребёнка в stdout
pi-run oracle 'скажи: жив'           # задача аргументом
pi-run -b oracle 'задача'            # фон: JSON-хендл (runId, asyncDir) сразу
pi-run status|steer|stop|resume <id> # управление прогоном
pi-run ping                          # capabilities-проба шины
```

Выходы: 0 complete · 1 failed/stopped · 2 usage/client · 3 timeout.
E2E (хост `pi --mode rpc`): ping, -b, блокирующий argv+stdin оракл (8–13с),
status — чисто; регресс pit чист.

## Установка

```sh
pi install -l ../pi-sh-tool        # проектно (после grant trust)
# или разово:
pi -ne -e ../pi-sh-tool -p '...'
```

Требуются peer-зависимости хоста: `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`. Built-ins отключаются через
`defaultTools: []` (user-level settings).

## Проверка

```sh
pi -ne -e . -p 'Run exactly this single command: echo probe-ok'
```
