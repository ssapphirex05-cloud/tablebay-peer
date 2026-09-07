# Tablebay rooms

WebSocket-комнаты для Tablebay. Игра остаётся на статике, этот сервис только лобби и релей стола.

## Эндпоинты

- `GET /health` — жив ли инстанс
- `GET /lobbies` — открытые столы
- `WS /ws` — комнаты

## Протокол WS

Клиент:

- `{ typ: "create", name, preset, player }` → `{ typ: "created", you, lobby, roster }`
- `{ typ: "join", code, player }` → `{ typ: "joined", you, lobby, roster, world }`
- `{ typ: "relay", msg }` — рассылка события стола, сервер ставит `from`
- `{ typ: "relay", to, msg }` — только одному игроку
- `{ typ: "presence", player }`
- `{ typ: "admin", key, admin }` (только хост)
- `{ typ: "ping", t }`

`you` — стабильный id игрока на этом соединении. Не использовать PeerJS-id.

Render free засыпает: клиент будит `GET /health` перед коннектом.
