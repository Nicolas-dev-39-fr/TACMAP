/* TACMAP – logique côté navigateur : carte, GPS, affichage des unités, liaison avec le serveur. */
(function () {
  'use strict';

  var SYMBOLS = { rifleman: '●', medic: '✚', support: '■', sniper: '◎', leader: '★' };
  var ROLES = { rifleman: 'Rifleman', medic: 'Medic', support: 'Support', sniper: 'Sniper', leader: 'Squad Leader' };
  var TEAMS = { blue: 'BLEUE', red: 'ROUGE' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dist(a, b) { // distance en mètres (formule de haversine)
    var r = Math.PI / 180, R = 6371000;
    var dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
    var x = Math.sin(dl / 2) * Math.sin(dl / 2) +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) * Math.sin(dn / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fmt(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'; }

  /* ---------- 1. Carte ---------- */
  var map = L.map('map', { zoomControl: false }).setView([46.6, 2.5], 6);
  // URL officielle OSM (HTTPS, sans sous-domaine {s}) + attribution visible
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  /* ---------- 2. État ---------- */
  var me = { id: Math.random().toString(36).slice(2, 10), name: '', room: '', team: 'blue', role: 'rifleman',
             lat: null, lng: null, acc: null, marker: null };
  var others = {};            // id -> { u: données serveur, marker }
  var ws = null, online = false, lastSend = 0, watchId = null, firstFix = true;
  var gpsText = 'GPS EN ATTENTE';

  try {
    var saved = JSON.parse(localStorage.getItem('tacmap') || '{}');
    ['name', 'room', 'team', 'role'].forEach(function (k) {
      if (saved[k]) $('player' + k.charAt(0).toUpperCase() + k.slice(1)).value = saved[k];
    });
  } catch (e) { /* stockage indisponible : on ignore */ }

  /* ---------- 3. Affichage ---------- */
  function msg(t) { $('gpsMessage').textContent = t; }

  function status() {
    $('gpsStatus').textContent = gpsText + (me.name ? (online ? ' · EN LIGNE' : ' · HORS LIGNE') : '');
  }

  function icon(u) {
    return L.divIcon({
      className: '',
      html: '<div class="mk ' + u.team + '"><b>' + SYMBOLS[u.role] + '</b><span>' + esc(u.name) + '</span></div>',
      iconSize: [80, 40],
      iconAnchor: [40, 12]
    });
  }

  function row(u, self) {
    var d = !self && me.lat != null ? ' · ' + fmt(dist(me, u)) : '';
    var old = u.age > 20 ? ' · il y a ' + u.age + ' s' : '';
    return '<div class="unit"><i class="legend-icon ' + u.team + '"></i><b>' + esc(u.name) + (self ? ' (moi)' : '') +
      '</b><small>' + SYMBOLS[u.role] + ' ' + ROLES[u.role] + d + old + '</small></div>';
  }

  function render() {
    var rows = me.name ? [row(me, true)] : [];
    Object.keys(others).forEach(function (id) { rows.push(row(others[id].u)); });
    $('unitCount').textContent = rows.length;
    $('unitList').innerHTML = rows.join('') || '<div class="unit muted">Aucune unité</div>';
    $('unitInfo').innerHTML = me.name
      ? '<div><span>Indicatif</span><b>' + esc(me.name) + '</b></div>' +
        '<div><span>Groupe</span><b>' + esc(me.room) + '</b></div>' +
        '<div><span>Équipe</span><b>' + TEAMS[me.team] + '</b></div>' +
        '<div><span>Rôle</span><b>' + ROLES[me.role] + '</b></div>' +
        '<div><span>Précision</span><b>' + (me.acc == null ? '--' : '±' + Math.round(me.acc) + ' m') + '</b></div>'
      : '<div class="unit muted">En attente de configuration</div>';
  }

  /* ---------- 4. Coéquipiers reçus du serveur ---------- */
  function onUnits(list) {
    var seen = {};
    list.forEach(function (u) {
      seen[u.id] = true;
      var o = others[u.id];
      if (!o) others[u.id] = { u: u, marker: L.marker([u.lat, u.lng], { icon: icon(u) }).addTo(map) };
      else { o.u = u; o.marker.setLatLng([u.lat, u.lng]); }
    });
    Object.keys(others).forEach(function (id) {
      if (!seen[id]) { map.removeLayer(others[id].marker); delete others[id]; }
    });
    render();
  }

  /* ---------- 5. Liaison serveur (WebSocket) ---------- */
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function join() { send({ t: 'join', id: me.id, room: me.room, name: me.name, team: me.team, role: me.role }); }
  function sendPos(force) {
    if (me.lat == null) return;
    var now = Date.now();
    if (!force && now - lastSend < 2000) return;   // au plus 1 envoi toutes les 2 s
    lastSend = now;
    send({ t: 'pos', lat: me.lat, lng: me.lng, acc: me.acc });
  }
  function connect() {
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    } catch (e) { online = false; status(); return; }   // ex. page ouverte en file:// : pas de serveur
    ws.onopen = function () { online = true; join(); sendPos(true); status(); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'units') onUnits(m.units);
    };
    ws.onclose = function () {
      online = false; status();
      setTimeout(connect, 3000);                          // reconnexion automatique
    };
  }

  /* ---------- 6. GPS ---------- */
  function onFix(pos) {
    var c = pos.coords;
    me.lat = c.latitude; me.lng = c.longitude; me.acc = c.accuracy;
    var ll = [me.lat, me.lng];
    if (!me.marker) me.marker = L.marker(ll, { icon: icon(me) }).addTo(map);
    else me.marker.setLatLng(ll);
    if (firstFix) { firstFix = false; $('setup').classList.add('hidden'); map.setView(ll, 17); }
    gpsText = 'GPS ACTIF ±' + Math.round(me.acc) + ' m';
    status();
    document.querySelector('.status-dot').classList.add('on');
    $('coordinates').textContent = 'GPS : ' + me.lat.toFixed(5) + ', ' + me.lng.toFixed(5);
    sendPos(false);
    render();
  }

  function onError(err) {
    var texts = {
      1: 'Accès à la position refusé : autorise-le dans les réglages du navigateur.',
      2: 'Position introuvable : essaie à découvert.',
      3: 'Délai dépassé : nouvelle tentative en cours…'
    };
    msg(texts[err.code] || 'Erreur GPS.');
    gpsText = err.code === 1 ? 'GPS REFUSÉ' : 'GPS INDISPONIBLE';
    status();
    if (err.code === 1) $('startButton').disabled = false;
  }

  /* ---------- 7. Bouton « Activer ma position » ---------- */
  $('startButton').onclick = function () {
    var name = $('playerName').value.trim();
    var room = $('playerRoom').value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!name) { msg('Indique ton nom ou ton indicatif.'); return; }
    if (!room) { msg('Indique le code de groupe (lettres, chiffres, - et _).'); return; }
    if (!navigator.geolocation) { msg('GPS indisponible sur cet appareil.'); return; }
    if (!window.isSecureContext) { msg('Le GPS exige une page en HTTPS.'); return; }

    me.name = name; me.room = room;
    me.team = $('playerTeam').value; me.role = $('playerRole').value;
    try { localStorage.setItem('tacmap', JSON.stringify({ name: me.name, room: me.room, team: me.team, role: me.role })); } catch (e) {}

    if (me.marker) me.marker.setIcon(icon(me));
    msg('Recherche du signal GPS…');
    $('startButton').disabled = true;
    if (ws) join(); else connect();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000
    });
    render();
  };

  /* ---------- 8. Horloge et panneaux repliables ---------- */
  function tick() { $('clock').textContent = new Date().toLocaleTimeString('fr-FR'); }
  tick();
  setInterval(tick, 1000);

  var small = window.matchMedia('(max-width: 760px)').matches;   // repliés par défaut sur mobile
  Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
    if (small) p.classList.add('collapsed');
    p.querySelector('.panel-title').onclick = function () { p.classList.toggle('collapsed'); };
  });

  render();
})();
