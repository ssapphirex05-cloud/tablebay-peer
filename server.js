'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 9000;
const MAX_PLAYERS = 8;
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const STALE_MS = 90_000;
const EMPTY_MS = 20 * 60_000;

const app = express();
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});

const rooms = new Map();

function uid(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex');
}

function makeCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)];
  return rooms.has(code) ? makeCode() : code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function publicPlayer(p) {
  return {
    key: p.key,
    name: p.name || 'Игрок',
    color: p.color || '#f5d0fe',
    avatar: p.avatar || '',
    seated: !!p.seated,
    seat: p.seat || null,
    admin: !!p.admin,
    host: !!p.host
  };
}

function rosterOf(room) {
  const r = {};
  room.players.forEach((p, i) => {
    r[p.key] = Object.assign(publicPlayer(p), { order: i });
  });
  return r;
}

function lobbyPublic(room) {
  return {
    code: room.code,
    name: room.name,
    hostName: room.hostName,
    preset: room.preset || 'empty',
    players: room.players.length,
    max: room.max,
    age: Date.now() - room.created
  };
}

function broadcast(room, obj, exceptWs) {
  room.clients.forEach((c) => {
    if (c !== exceptWs) send(c, obj);
  });
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  broadcast(room, { typ: 'lobbyClosed', reason: reason || 'Хост вышел' });
  room.clients.forEach((c) => {
    try { c.close(); } catch (_) {}
  });
  rooms.delete(code);
}

function dropClient(ws, reason) {
  const room = ws.room;
  if (!room) return;
  const gone = room.players.find((p) => p.key === ws.playerKey);
  room.clients.delete(ws);
  room.players = room.players.filter((p) => p.key !== ws.playerKey);
  ws.room = null;
  if (ws.isHost || (gone && gone.host)) {
    closeRoom(room.code, reason || 'Хост вышел');
    return;
  }
  broadcast(room, {
    typ: 'peerLeft',
    key: ws.playerKey,
    name: (gone && gone.name) || 'Игрок',
    roster: rosterOf(room)
  });
}

app.get('/', (_req, res) => {
  res.type('text/plain').send('Tablebay rooms ok');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, ts: Date.now() });
});
app.get('/lobbies', (_req, res) => {
  res.json({ lobbies: [...rooms.values()].map(lobbyPublic) });
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('Tablebay rooms on ' + PORT);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws.room = null;
  ws.playerKey = null;
  ws.isHost = false;
  ws.alive = true;
  send(ws, { typ: 'helloOkNet', you: null, lobbies: [...rooms.values()].map(lobbyPublic) });

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (!msg || typeof msg !== 'object' || !msg.typ) return;
    ws.alive = true;

    if (msg.typ === 'ping') {
      send(ws, { typ: 'pong', t: msg.t || Date.now() });
      return;
    }

    if (msg.typ === 'list') {
      send(ws, { typ: 'lobbies', lobbies: [...rooms.values()].map(lobbyPublic) });
      return;
    }

    if (msg.typ === 'create') {
      if (ws.room) dropClient(ws);
      let code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length < 4) code = makeCode();
      if (rooms.has(code)) {
        send(ws, { typ: 'error', text: 'Код занят, создай ещё раз' });
        return;
      }
      const key = uid('h');
      const incoming = msg.player && typeof msg.player === 'object' ? msg.player : {};
      const player = {
        key,
        name: incoming.name || msg.name || 'Хост',
        color: incoming.color || '#f5d0fe',
        avatar: incoming.avatar || '',
        seated: !!incoming.seated,
        seat: incoming.seat || null,
        admin: true,
        host: true,
        joinAt: Date.now()
      };
      const room = {
        code,
        name: msg.name || ('Стол ' + code),
        hostName: player.name,
        preset: msg.preset || 'empty',
        max: MAX_PLAYERS,
        created: Date.now(),
        lastTouch: Date.now(),
        hostKey: key,
        clients: new Set([ws]),
        players: [player],
        world: null
      };
      rooms.set(code, room);
      ws.room = room;
      ws.playerKey = key;
      ws.isHost = true;
      send(ws, {
        typ: 'created',
        you: key,
        lobby: lobbyPublic(room),
        roster: rosterOf(room)
      });
      return;
    }

    if (msg.typ === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { typ: 'error', text: 'Лобби не найдено. Хост вышел или код неверный.' });
        return;
      }
      if (room.players.length >= room.max) {
        send(ws, { typ: 'error', text: 'Лобби полное' });
        return;
      }
      if (ws.room === room) return;
      if (ws.room) dropClient(ws);
      const incoming = msg.player && typeof msg.player === 'object' ? msg.player : {};
      const key = uid('g');
      const player = {
        key,
        name: incoming.name || 'Гость',
        color: incoming.color || '#f5d0fe',
        avatar: incoming.avatar || '',
        seated: !!incoming.seated,
        seat: incoming.seat || null,
        admin: false,
        host: false,
        joinAt: Date.now()
      };
      room.players.push(player);
      room.clients.add(ws);
      room.lastTouch = Date.now();
      ws.room = room;
      ws.playerKey = key;
      ws.isHost = false;
      send(ws, {
        typ: 'joined',
        you: key,
        lobby: lobbyPublic(room),
        roster: rosterOf(room),
        world: room.world,
        preset: room.preset
      });
      broadcast(room, {
        typ: 'peerJoin',
        player: publicPlayer(player),
        roster: rosterOf(room)
      }, ws);
      const hostWs = [...room.clients].find((c) => c.isHost);
      if (hostWs) send(hostWs, { typ: 'wantState', from: key });
      return;
    }

    if (msg.typ === 'leave') {
      dropClient(ws);
      return;
    }

    if (msg.typ === 'presence' && ws.room && ws.playerKey) {
      const p = ws.room.players.find((x) => x.key === ws.playerKey);
      const incoming = msg.player && typeof msg.player === 'object' ? msg.player : msg;
      if (p) {
        if (incoming.name != null) p.name = String(incoming.name).slice(0, 24);
        if (incoming.color != null) p.color = incoming.color;
        if (incoming.avatar != null) p.avatar = incoming.avatar;
        if (incoming.seat !== undefined) p.seat = incoming.seat;
        if (incoming.seated !== undefined) p.seated = !!incoming.seated;
        if (ws.isHost) ws.room.hostName = p.name;
      }
      const roster = rosterOf(ws.room);
      broadcast(ws.room, { typ: 'presence', player: p ? publicPlayer(p) : null, roster });
      return;
    }

    if (msg.typ === 'admin' && ws.room && ws.isHost) {
      const key = msg.key;
      const p = ws.room.players.find((x) => x.key === key);
      if (p && !p.host) p.admin = !!msg.admin;
      const roster = rosterOf(ws.room);
      broadcast(ws.room, { typ: 'admin', key, admin: !!(p && p.admin), roster });
      return;
    }

    if ((msg.typ === 'world' || msg.typ === 'worldDone' || msg.typ === 'helloOk') && ws.room && ws.isHost) {
      if (msg.state) ws.room.world = msg.state;
      else if (msg.typ === 'worldDone' && msg.world) {
        ws.room.world = { world: msg.world, objects: (ws.room.world && ws.room.world.objects) || [] };
      }
      ws.room.lastTouch = Date.now();
    }

    if (msg.typ === 'relay' && ws.room) {
      const inner = msg.msg || msg.payload;
      if (!inner || typeof inner !== 'object') return;
      inner.from = ws.playerKey;
      if (ws.isHost && (inner.typ === 'world' || inner.typ === 'worldDone' || inner.typ === 'helloOk')) {
        if (inner.state) ws.room.world = inner.state;
        ws.room.lastTouch = Date.now();
      }
      if (msg.to) {
        const target = [...ws.room.clients].find((c) => c.playerKey === msg.to);
        if (target) send(target, inner);
        return;
      }
      broadcast(ws.room, inner, ws);
      return;
    }

    if (ws.room && msg.typ && !['create', 'join', 'list', 'leave', 'ping', 'presence', 'admin'].includes(msg.typ)) {
      msg.from = ws.playerKey;
      if (ws.isHost && (msg.typ === 'world' || msg.typ === 'worldDone' || msg.typ === 'helloOk') && msg.state) {
        ws.room.world = msg.state;
      }
      broadcast(ws.room, msg, ws);
    }
  });

  ws.on('close', () => dropClient(ws));
  ws.on('error', () => dropClient(ws));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    ws.alive = false;
    try { ws.ping(); } catch (_) {}
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created > EMPTY_MS && room.players.length <= 1 && now - room.lastTouch > STALE_MS) {
      closeRoom(code, 'Стол затих');
    }
  }
}, 25000);
