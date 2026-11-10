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
