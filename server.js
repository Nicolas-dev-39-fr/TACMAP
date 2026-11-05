/* TACMAP – serveur : (1) envoie les 3 fichiers du site, (2) relaie les positions entre joueurs. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const FILES = {                       // seuls ces fichiers sont accessibles
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'text/javascript; charset=utf-8']
};

/* ---------- Partie 1 : le site ---------- */
const server = http.createServer((req, res) => {
  const entry = FILES[req.url.split('?')[0]];
  if (!entry) { res.writeHead(404); return res.end('Introuvable'); }
  fs.readFile(path.join(PUBLIC, entry[0]), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erreur serveur'); }
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Referrer-Policy': 'strict-origin-when-cross-origin'   // requis par les tuiles OpenStreetMap
    });
    res.end(data);
  });
});

/* ---------- Partie 2 : les positions en temps réel ---------- */
const TEAMS = ['blue', 'red'];
const ROLES = ['rifleman', 'medic', 'support', 'sniper', 'leader'];
const rooms = new Map();              // code de groupe -> Set des joueurs connectés
const text = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function leave(ws) {
  if (!ws.u) return;
  const set = rooms.get(ws.u.room);
  if (set) { set.delete(ws.u); if (!set.size) rooms.delete(ws.u.room); }
  ws.u = null;
}

const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {                               // « je rejoins le groupe X »
      leave(ws);
      const room = String(m.room || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
      if (!room || !m.id) return;
      ws.u = {
        id: text(m.id, 24), room, ws, lat: null, lng: null, acc: null, ts: 0,
        name: text(m.name, 24) || 'ANONYME',
        team: TEAMS.includes(m.team) ? m.team : 'blue',
        role: ROLES.includes(m.role) ? m.role : 'rifleman'
      };
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws.u);
    } else if (m.t === 'pos' && ws.u) {                  // « voici ma position »
      if (Number.isFinite(m.lat) && Number.isFinite(m.lng) && Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180) {
        ws.u.lat = m.lat; ws.u.lng = m.lng;
        ws.u.acc = Number.isFinite(m.acc) ? m.acc : null;
        ws.u.ts = Date.now();
      }
    }
  });

  ws.on('close', () => leave(ws));
});

// Toutes les 1,5 s : chaque joueur reçoit les positions de SON équipe (jamais celles de l'adversaire).
setInterval(() => {
  const now = Date.now();
  for (const set of rooms.values()) {
    for (const me of set) {
      if (me.ws.readyState !== 1) continue;
      const units = [];
      for (const u of set) {
        if (u !== me && u.team === me.team && u.lat !== null) {
          units.push({ id: u.id, name: u.name, team: u.team, role: u.role,
                       lat: u.lat, lng: u.lng, acc: u.acc, age: Math.round((now - u.ts) / 1000) });
        }
      }
      me.ws.send(JSON.stringify({ t: 'units', units }));
    }
  }
}, 1500);

// Toutes les 25 s : on coupe les connexions mortes (et on garde les autres éveillées).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('TACMAP prêt : http://localhost:' + PORT));
