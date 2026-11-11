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
`⇅ pit` (вооружён) / `· pit` (холоден). Режимы: `PI_SH_PIT_ARM=1` — якорь на
каждом ходу; `PI_SH_TOOL_KEEP_SURFACE=1` — смешанная поверхность без редукции.
шелла (per-session сокет `PI_TOOLS_SOCK`, 0600; внутри хоста это
`ctx.executeTool` — включая tools с exposure `callable`, которых нет на
модельной поверхности). Дети (`pi -p`, субагентные шеллы) наследуют env и
могут делегировать так же. `pi -p` сам по себе — one-shot «новый сеанс с
нуля», субагентом он не является.

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
