const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const PORT = process.env.PORT || 9000;
const lobbies = new Map();

function lobbyPublic(L) {
  return {
    code: L.code,
    name: L.name,
    hostName: L.hostName,
    preset: L.preset || 'empty',
    players: L.players.length,
    max: L.max,
    age: Date.now() - L.created
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function rosterOf(L) {
  const r = {};
  L.players.forEach((p, i) => {
    r[p.key] = Object.assign({}, p, { order: i, admin: i === 0 || !!p.admin });
  });
  return r;
}

function broadcast(L, obj, except) {
  L.clients.forEach((c) => {
    if (c !== except) send(c, obj);
  });
}

function closeLobby(code, reason) {
  const L = lobbies.get(code);
  if (!L) return;
  broadcast(L, { typ: 'lobbyClosed', reason: reason || 'Хост вышел' });
  lobbies.delete(code);
}

function dropClient(ws) {
  const L = ws.lobby;
  if (!L) return;
  const gone = L.players.find((p) => p.key === ws.playerKey);
  L.clients.delete(ws);
  L.players = L.players.filter((p) => p.key !== ws.playerKey);
  if (ws === L.hostWs) {
    closeLobby(L.code, 'Хост вышел');
    return;
  }
  broadcast(L, {
    typ: 'peerLeft',
    key: ws.playerKey,
    name: (gone && gone.name) || 'Игрок',
    roster: rosterOf(L)
  });
}

app.get('/', (_req, res) => {
  res.type('text/plain').send('Tablebay lobby ok');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, lobbies: lobbies.size });
});
app.get('/lobbies', (_req, res) => {
  res.json({ lobbies: [...lobbies.values()].map(lobbyPublic) });
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('Tablebay lobby on ' + PORT);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.lobby = null;
  ws.playerKey = null;
  ws.isHost = false;
  send(ws, { typ: 'helloOkNet', lobbies: [...lobbies.values()].map(lobbyPublic) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (!msg || !msg.typ) return;

    if (msg.typ === 'list') {
      send(ws, { typ: 'lobbies', lobbies: [...lobbies.values()].map(lobbyPublic) });
      return;
    }

    if (msg.typ === 'create') {
      let code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length < 4) {
        const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
        code = '';
        for (let i = 0; i < 4; i++) code += abc[Math.floor(Math.random() * abc.length)];
      }
      if (lobbies.has(code)) {
        send(ws, { typ: 'error', text: 'Код занят, попробуй ещё раз' });
        return;
      }
      const player = Object.assign({ key: 'host', name: msg.name || 'Хост' }, msg.player || {});
      player.admin = true;
      player.joinAt = Date.now();
      player.order = 0;
      const L = {
        code,
        name: msg.name || ('Стол ' + code),
        hostName: player.name || 'Хост',
        preset: msg.preset || 'empty',
        max: 8,
        created: Date.now(),
        hostWs: ws,
        clients: new Set([ws]),
        players: [player],
        lastWorld: null
      };
      lobbies.set(code, L);
      ws.lobby = L;
      ws.playerKey = player.key;
      ws.isHost = true;
      send(ws, { typ: 'created', lobby: lobbyPublic(L), roster: rosterOf(L) });
      return;
    }

    if (msg.typ === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const L = lobbies.get(code);
      if (!L) {
        send(ws, { typ: 'error', text: 'Лобби не найдено. Хост вышел или код неверный.' });
        return;
      }
      if (L.players.length >= L.max) {
        send(ws, { typ: 'error', text: 'Лобби полное' });
        return;
      }
      const player = Object.assign({ key: 'g' + Date.now(), name: 'Гость' }, msg.player || {});
      player.admin = false;
      player.joinAt = Date.now();
      player.order = L.players.length;
      L.players = L.players.filter((p) => p.key !== player.key);
      L.players.push(player);
      L.clients.add(ws);
      ws.lobby = L;
      ws.playerKey = player.key;
      ws.isHost = false;
      send(ws, {
        typ: 'joined',
        lobby: lobbyPublic(L),
        roster: rosterOf(L),
        world: L.lastWorld,
        preset: L.preset
      });
      broadcast(L, { typ: 'peerJoin', player: player, roster: rosterOf(L) }, ws);
      return;
    }

    if (msg.typ === 'leave') {
      dropClient(ws);
      ws.lobby = null;
      return;
    }

    if (msg.typ === 'relay' && ws.lobby) {
      const inner = msg.msg || msg.payload;
      if (!inner) return;
      if (ws.isHost && (inner.typ === 'world' || inner.typ === 'worldDone' || inner.typ === 'helloOk')) {
        if (inner.state) ws.lobby.lastWorld = inner.state;
      }
      broadcast(ws.lobby, inner, ws);
      return;
    }
  });

  ws.on('close', () => dropClient(ws));
  ws.on('error', () => dropClient(ws));
});
