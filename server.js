const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const PORT = process.env.PORT || 9000;

app.get('/', (_req, res) => {
  res.type('text/plain').send('Tablebay PeerJS ok');
});
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log('Tablebay peer listening on ' + PORT);
});

const peerServer = ExpressPeerServer(httpServer, {
  path: '/',
  allow_discovery: false,
  proxied: true
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log('peer in', client.getId && client.getId());
});
peerServer.on('disconnect', (client) => {
  console.log('peer out', client.getId && client.getId());
});
