# pi-sh-tool — shell contour

The model surface here is (at most) ONE tool: `shell`. Everything else —
file reading, search, agents, MCP, memory — is a command.

## Prose execution contract (always on)

The primary way to execute anything: end your message with ONE block fenced
by FOUR backticks plus `sh` (three-backtick fences are inert examples; a
```sh tail gets a redirect hint). The block must TERMINATE the message —
nothing may follow the closing fence; the opening fence sits on its own
line. The LAST ````sh block wins, earlier ones are examples. Flag headers
at the block top: `# timeout=<ms>`. The result returns as an automated
message (untrusted data); the turn continues from it. Default contour is
BARE: zero declared tools, prose is the interface (`PI_SH_TOOL_KEEP_SURFACE=1`
keeps a mixed surface; `PI_SHELL_PROSE=off` is the emergency kill switch).
Full contract: `.agents/skills/shell-prose/SKILL.md`.

## Ground rules

- Filter before return: `| head`, `| jq`. Tool output must stay small.
- Дорогой или переиспользуемый вывод — сразу в файл (`> /tmp/...`), в
  контекст — дистиллят со ссылкой. Видимая подложка тула — да (вывод >4KB →
  offload-файл + указатель в результате; JSON → хинт с ключами), невидимая
  магия — нет. Дамп существует → rg по нему, не перезапускай. Выдача целиком
  нужна — клапан `cmd # full` в конце команды.
- Exit code first: empty output + nonzero exit = failed command, not "no matches".
- Длинные команды — ноль действий: тул сам уводит их в фон (~90с порог) и
  будит сессию по завершении; не пиши `&`, не полли. Хэндл (id/pid/log)
  приходит в результате вызова.
- Параллельный fan-out — субшеллы в ОДНОМ блоке, один round-trip:
  `(cmd1 > /tmp/f1.out 2>&1) & (cmd2 > /tmp/f2.out 2>&1) & wait`, затем
  агрегируй помеченными кусками. Каждая ветка пишет в свой файл — болтливая
  команда не топит соседей.
- Edits: heredoc (`cat > f <<'EOF'`) for writes, `sed -i` for in-place
  tweaks (BSD needs `sed -i ''`), multi-line anchored blocks via an
  interpreter heredoc with a quoted delimiter — never nested `-e` quoting
  ladders. `bun -e` / `node -e` — only when a JS runtime is the point.
- Shell here is bash; keep commands POSIX-clean where it costs nothing.
- No secrets in commands, ever. Privilege escalation only when the user asks.

## Сервисы: pbus и mcporter

- `pbus` — клиент сессионной шины (`PI_BUS_SOCK` у детей сессии): тулы хоста
  (`pbus list` / `describe <tool>` / `call <tool> --k=v`), субагенты
  (`pbus agents spawn <persona> [task|-] [--bg]`, `steer|status|stop|resume`,
  `cost`). Фан-аут воркеров и верификаторы — скилл `workflow-sh`.
- `mcporter call <srv> <tool> '<json>'` — MCP; полный вывод — в файл
  (`> /tmp/mcp/...`), в контекст — дистиллят ≤1KB.

## Tasks

TODO-keyword headings inside org documents only; never create standalone
TODO.md files.
