# Tablebay Peer Server

Сигнальный сервер для онлайна Tablebay. Игра остаётся на mjtest.ru, сюда только комнаты.

## Render

1. New + Web Service
2. Репозиторий `ssapphirex05-cloud/tablebay-peer`
3. Runtime: Node
4. Build: `npm install`
5. Start: `npm start`
6. Free plan

После деплоя будет адрес вроде `https://tablebay-peer.onrender.com`.

Открой в браузере — должно написать `Tablebay PeerJS ok`.

Скинь эту ссылку — пропишу её в игру.

В PeerJS путь: host без https, port 443, path `/peerjs`, secure true.
