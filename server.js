'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 9000;
const MAX_PLAYERS = 8;
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const STALE_MS = 90_000;
const EMPTY_MS = 20 * 60_000;

const app = express();
app.use(express.json({ limit: '200kb' }));
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

const DATA_FILE = process.env.TB_DATA || path.join(__dirname, 'tb-accounts.json');
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_BOT_NAME = process.env.TG_BOT_NAME || '';

const accounts = new Map();
const tgIndex = new Map();
const bindTokens = new Map();

function loadAccounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (raw.accounts || []).forEach((a) => {
      accounts.set(a.uid, {
        uid: a.uid,
        name: a.name || 'Игрок',
        avatar: a.avatar || '',
        tgId: a.tgId || '',
        tgName: a.tgName || '',
        friends: new Set(a.friends || []),
        incoming: a.incoming || []
      });
      if (a.tgId) tgIndex.set(String(a.tgId), a.uid);
    });
  } catch (_) {}
}
function saveAccounts() {
  try {
    const list = [...accounts.values()].map((a) => ({
      uid: a.uid, name: a.name, avatar: a.avatar, tgId: a.tgId, tgName: a.tgName,
      friends: [...a.friends], incoming: a.incoming || []
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts: list }));
  } catch (e) { console.warn('save accounts', e.message); }
}
loadAccounts();

function ensureAcc(uid, extra) {
  uid = String(uid || '').slice(0, 40);
  if (!uid) return null;
  if (!accounts.has(uid)) accounts.set(uid, { uid, name: 'Игрок', avatar: '', tgId: '', tgName: '', friends: new Set(), incoming: [] });
  const a = accounts.get(uid);
  if (extra) {
    if (extra.name) a.name = String(extra.name).slice(0, 24);
    if (extra.avatar != null) a.avatar = String(extra.avatar).slice(0, 8000);
  }
  return a;
}
function publicAcc(a) {
  if (!a) return null;
  return { uid: a.uid, name: a.name, tg: !!a.tgId, tgName: a.tgName || '' };
}

app.post('/account', (req, res) => {
  const a = ensureAcc(req.body && req.body.uid, req.body || {});
  if (!a) return res.status(400).json({ error: 'uid' });
  saveAccounts();
  res.json({ ok: true, me: publicAcc(a), friends: [...a.friends].map((id) => publicAcc(accounts.get(id))).filter(Boolean), incoming: a.incoming || [] });
});
app.get('/friends', (req, res) => {
  const a = ensureAcc(req.query.uid);
  if (!a) return res.status(400).json({ error: 'uid' });
  res.json({
    me: publicAcc(a),
    friends: [...a.friends].map((id) => publicAcc(accounts.get(id))).filter(Boolean),
    incoming: a.incoming || []
  });
});
app.post('/friends/add', (req, res) => {
  const from = ensureAcc(req.body && req.body.uid, req.body || {});
  const toUid = String((req.body && req.body.to) || '');
  const to = ensureAcc(toUid);
  if (!from || !to || from.uid === to.uid) return res.status(400).json({ error: 'bad' });
  from.friends.add(to.uid);
  if (!to.friends.has(from.uid)) {
    to.incoming = to.incoming || [];
    if (!to.incoming.some((x) => x.uid === from.uid)) {
      to.incoming.push({ uid: from.uid, name: from.name, at: Date.now() });
    }
  }
  saveAccounts();
  res.json({ ok: true });
});
app.post('/friends/accept', (req, res) => {
  const me = ensureAcc(req.body && req.body.uid);
  const other = ensureAcc(req.body && req.body.from);
  if (!me || !other) return res.status(400).json({ error: 'bad' });
  me.friends.add(other.uid);
  other.friends.add(me.uid);
  me.incoming = (me.incoming || []).filter((x) => x.uid !== other.uid);
  saveAccounts();
  res.json({ ok: true });
});

app.get('/tg/link', (req, res) => {
  const uid = String(req.query.uid || '');
  if (!ensureAcc(uid)) return res.status(400).json({ error: 'uid' });
  if (!TG_BOT_NAME) return res.json({ ok: false, needBot: true, hint: 'Задай TG_BOT_NAME и TG_BOT_TOKEN на Render' });
  const token = crypto.randomBytes(6).toString('hex');
  bindTokens.set(token, { uid, exp: Date.now() + 12 * 60 * 1000 });
  res.json({ ok: true, url: 'https://t.me/' + TG_BOT_NAME + '?start=bind' + token });
});

async function tgSend(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (_) {}
}

app.post('/tg', (req, res) => {
  res.json({ ok: true });
  const msg = req.body && req.body.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat && msg.chat.id;
  const text = String(msg.text || '');
  const from = msg.from || {};
  if (text.startsWith('/start')) {
    const payload = text.replace('/start', '').trim();
    if (payload.startsWith('bind')) {
      const token = payload.slice(4);
      const rec = bindTokens.get(token);
      if (!rec || rec.exp < Date.now()) {
        tgSend(chatId, 'Код устарел. Нажми «Привязать Telegram» ещё раз в игре.');
        return;
      }
      bindTokens.delete(token);
      const acc = ensureAcc(rec.uid);
      acc.tgId = String(from.id);
      acc.tgName = from.username ? ('@' + from.username) : String(from.first_name || '').slice(0, 24);
      tgIndex.set(acc.tgId, acc.uid);
      saveAccounts();
      tgSend(chatId, 'Tablebay: аккаунт привязан как ' + acc.name);
      return;
    }
    tgSend(chatId, 'Это бот Tablebay. Привязка: кнопка в профиле игры.');
  }
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
      if (inner.typ === 'wantState' && ws.room) {
        const hostWs = [...ws.room.clients].find((c) => c.isHost);
        if (hostWs) send(hostWs, { typ: 'wantState', from: ws.playerKey });
        if (ws.room.world) send(ws, { typ: 'world', state: ws.room.world, roster: rosterOf(ws.room) });
        return;
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
