# Ember: Lean-трекер задач для командной агентной разработки

Закрытый MCP-сервер, через который люди и их агенты (Claude Code, Claude Desktop, боты) ведут задачи по Lean-потоку: сырая обратная связь попадает в inbox, разработчик с доступом к коду анализирует и дополняет конкретикой, тот же или другой разработчик реализует, кто-то другой проверяет.

Принципы:

- **Только MCP и REST.** Никакого фронта. Любое взаимодействие идёт через 16 инструментов, доступных и как MCP tools, и как `POST /api/tools/<name>`.
- **Идентичность из токена.** Кто вызывает, определяется только bearer-токеном. Агент не может представиться кем-то другим; каждое действие в журнале подписано.
- **Pull-система с лизами.** Задачи не назначаются сверху, а забираются (`claim`) на ограниченное время. Лиза истекла или отпущена: задача вернулась в пул. Лимит WIP на актора и опционально на статус.
- **Минимум зависимостей.** Node 22 + встроенный `node:sqlite`, Hono, официальный MCP SDK, Zod. Один процесс, один файл базы.

## Поток

```
inbox ──claim(analysis)──> analysis ──transition──> ready ──claim(implementation)──> in_progress ──transition──> review ──transition──> done
  ^                            |  release/expire       ^                                  |  release/expire        |
  └────────────────────────────┘                       └──────────────────────────────────┘                        └──> ready (rework, с заметкой)
любой открытый статус ──> dropped ──> inbox (reopen)
```

| Статус | Кто и что делает |
|---|---|
| `inbox` | Сырая задача: сообщение из Telegram (бот), описание от менеджера через Claude, отчёт CI. Поле `raw` неизменяемо. Менеджер уточняет `problem`, `priority`, `acceptance`. |
| `analysis` | Разработчик забрал задачу `ember_claim_task purpose=analysis`, изучает код, пишет `analysis` (причина, файлы, план, риски) и `refs`. Затем `ember_transition_task to=ready`. Без текста анализа перевод в `ready` не пройдёт. |
| `ready` | Готово к реализации. `ember_claim_task purpose=implementation` ставит исполнителя (assignee). Заблокированные `blocked_by` задачи забрать нельзя. |
| `in_progress` | Работа идёт. Ссылки на ветку и MR добавляются через `add_refs`. `ember_transition_task to=review`. |
| `review` | Другой разработчик или менеджер проверяет (`purpose=review`, опционально) и переводит в `done` либо в `ready` с заметкой. Свою задачу ревьюить нельзя. |
| `done`, `dropped` | Закрыто. Reopen через `to=ready` или `to=inbox` с заметкой. |

Вопросы между контекстами (код против продукта) задаются прямо в задаче: `ember_comment_task kind=question to=@masha-claude` или `to=role:manager`. Открытые вопросы появляются у адресата в `ember_whoami` и `ember_my_work`; ответ `kind=answer reply_to=<id>` закрывает вопрос.

## Кто есть кто: модель идентичности

Проблема, которую нужно снять: агенты с разным контекстом не должны выяснять друг у друга, кто они и кто над чем работает. Решение:

1. **Токен = актор.** Каждый человек, агент и бот регистрируется как отдельный актор со своим токеном. Токен хранится только как SHA-256 хэш, показывается один раз при создании. Соглашение об именах: `@petya` (человек), `@petya-claude` (его агент), `@tg-bot` (бот).
2. **Тип и владелец.** У актора есть `kind` (`human` / `agent` / `bot`) и `owner`: за какого человека действует агент. В журнале видно "сделал @petya-claude (агент @petya)".
3. **Роль определяет права.** `admin`, `manager` (продуктовый контекст, без кода), `developer` (доступ к коду), `reporter` (боты-инжесторы). Права проверяются на сервере, на уровне инструментов, полей и переходов.
4. **Контекст.** Свободное поле `context`: "Claude Code с репозиторием backend", "Claude Desktop, читает фидбек из Telegram". Другие агенты видят его в `ember_list_actors` и понимают, кого о чём спрашивать.
5. **`ember_whoami` первым вызовом.** Возвращает handle, роль, возможности, активные лизы, назначенные задачи, открытые вопросы и шпаргалку по процессу. Инструкции сервера (MCP `instructions`) говорят агенту сделать это в начале сессии.
6. **`ember_list_actors` показывает, кто что делает сейчас:** активные лизы с целью и сроком, число назначенных задач, когда актора видели последний раз.
7. **Лизы вместо молчаливого захвата.** Попытка забрать занятую задачу возвращает конфликт с именем держателя и временем истечения. Повторный claim своей задачи продлевает лизу (heartbeat). Сессия агента умерла: лиза истечёт, задача вернётся в пул, событие запишется.
8. **Журнал событий.** Каждое изменение подписано актором: `ember_activity since=<время>` даёт ответ на вопрос "что произошло, пока меня не было".

## Быстрый старт

```bash
npm install
npm run build

# первый админ создаётся напрямую в базе (токен печатается один раз)
npm run admin -- create-actor --handle admin --name "Admin" --kind human --role admin

# люди без своих токенов (действуют через агентов) и их агенты
npm run admin -- create-actor --handle masha --name "Masha (PM)" --kind human --role manager --no-token
npm run admin -- create-actor --handle masha-claude --name "Claude for Masha" --kind agent --role manager \
    --owner masha --context "Claude Desktop, без доступа к коду, читает фидбек"
npm run admin -- create-actor --handle petya --name "Petya" --kind human --role developer --no-token
npm run admin -- create-actor --handle petya-claude --name "Claude Code for Petya" --kind agent --role developer \
    --owner petya --context "Claude Code, репозиторий backend"
npm run admin -- create-actor --handle tg-bot --name "Telegram ingest" --kind bot --role reporter --owner masha

npm start          # http://127.0.0.1:8787, MCP на POST /mcp
```

Дальше акторов создаёт админ через MCP (`ember_create_actor`), CLI нужен только для бутстрапа и аварийных случаев (`rotate-token`, `deactivate`, `set-role`).

Подключение клиента (Claude Code):

```bash
claude mcp add --transport http ember http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer ember_..."
```

Другие варианты (`.mcp.json` с `${EMBER_TOKEN}`, stdio-мост `mcp-remote` для Claude Desktop, curl) собраны в [examples/mcp-config.md](examples/mcp-config.md).

Docker:

```bash
docker compose up -d --build
docker compose exec ember node dist/cli.js create-actor --handle admin --name Admin --kind human --role admin
```

## Инструменты

| Инструмент | Роли | Назначение |
|---|---|---|
| `ember_whoami` | все | Кто я, что у меня в работе, какие вопросы ждут ответа, шпаргалка по процессу |
| `ember_list_actors` | все | Справочник акторов с ролями, владельцами, контекстом и текущими лизами |
| `ember_create_actor` | admin | Регистрация актора, выдача токена |
| `ember_update_actor` | admin | Роль, владелец, контекст, деактивация |
| `ember_rotate_actor_token` | все (свой), admin (любой) | Перевыпуск токена |
| `ember_create_task` | все | Создание задачи в inbox; идемпотентно по `source_ref` |
| `ember_get_task` | все | Полная карточка: raw, problem, analysis, acceptance, refs, комментарии, журнал |
| `ember_list_tasks` | все | Фильтры, поиск, пагинация |
| `ember_update_task` | manager, developer | Правка полей с пополевыми правами (`analysis` и `refs` только для developer) |
| `ember_claim_task` | developer (manager для review) | Взять лизу: analysis / implementation / review |
| `ember_release_task` | держатель, manager, admin | Отпустить лизу, статус откатывается в пул |
| `ember_transition_task` | по матрице | Переходы статусов с проверками и подсказками |
| `ember_comment_task` | все | Комментарий, вопрос адресату, ответ, решение |
| `ember_my_work` | все | Очереди на вытягивание под роль, мои лизы, вопросы ко мне |
| `ember_board` | все | Счётчики по статусам, WIP, активные лизы, застрявшие задачи, срочное |
| `ember_activity` | все | Журнал событий: по задаче, по актору, с момента времени |

Каждый инструмент возвращает и текст (Markdown), и `structuredContent` (JSON). Ошибки содержат код (`forbidden`, `conflict`, `wip_limit`, `not_found`, `invalid`) и подсказку со следующим шагом. REST-зеркало: `GET /api/tools` (каталог с JSON Schema), `POST /api/tools/<name>` с теми же аргументами.

## Безопасность

Сервис закрытый, не публичный. Что сделано в коде:

- Bearer-токены с высокой энтропией, в базе только SHA-256 хэши, показ один раз, ротация и деактивация без перезапуска.
- Все маршруты кроме `/healthz` требуют токен; MCP `initialize` тоже.
- Проверки прав на трёх уровнях: инструмент, поле, переход. Идентичность не принимается из аргументов.
- Привязка к `127.0.0.1` по умолчанию. Проверка заголовка `Host` против списка (защита от DNS rebinding); при выносе за loopback список задаётся через `EMBER_ALLOWED_HOSTS`.
- Лимит размера тела запроса, stateless MCP без сессий (нечего угонять), внутренние ошибки не утекают клиенту.
- Полный журнал действий с актором.

Что делать при развёртывании:

- Доступ по сети только через VPN (Tailscale, WireGuard) или reverse proxy с TLS и, при желании, дополнительным rate limiting. Порт наружу не публиковать.
- Один токен на одного агента. Токен человека, который сам не ходит в сервис, не выпускать (`--no-token`).
- Регулярно смотреть `ember_list_actors include_inactive=true` и деактивировать лишнее.

OAuth намеренно не реализован: для закрытого командного сервиса статические токены проще и не требуют внешнего провайдера. При необходимости добавляется поверх того же слоя `authenticate()`.

## Конфигурация

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `EMBER_HOST` | `127.0.0.1` | Адрес прослушивания |
| `EMBER_PORT` | `8787` | Порт |
| `EMBER_DB_PATH` | `./data/ember.db` | Файл SQLite |
| `EMBER_ALLOWED_HOSTS` | пусто | Дополнительные допустимые значения `Host` |
| `EMBER_MAX_CLAIMS_PER_ACTOR` | `3` | Лимит одновременных лиз на актора |
| `EMBER_CLAIM_TTL_MINUTES` | `90` | Длина лизы по умолчанию |
| `EMBER_MAX_CLAIM_TTL_MINUTES` | `1440` | Максимальная длина лизы |
| `EMBER_WIP_LIMITS` | пусто | Лимиты на статус, например `analysis=4,in_progress=6` |
| `EMBER_BODY_LIMIT_BYTES` | `1048576` | Лимит тела запроса |

## Интеграция с Telegram

[examples/telegram_ingest.py](examples/telegram_ingest.py): скрипт на stdlib, который long-poll'ит чат бота и создаёт задачу на каждое сообщение через REST. `source_ref = tg:<chat>:<message>` делает повторный запуск безопасным, хэштеги `#bug #feature #urgent #low` превращаются в `kind` и `priority`. Запускается под токеном актора с ролью `reporter`.

## Разработка

```bash
npm run dev        # tsx watch
npm test           # node:test: доменная логика + HTTP/MCP сквозные тесты
npm run typecheck
```

Структура: `src/domain` (акторы, задачи, правила потока), `src/tools` (реестр инструментов, один на MCP и REST), `src/server` (McpServer и Hono-приложение), `src/cli.ts` (админ-CLI), `src/db.ts` (схема SQLite).

Требуется Node 22.13+ (встроенный `node:sqlite`). Флаг `--disable-warning=ExperimentalWarning` в скриптах гасит предупреждение о статусе модуля.
