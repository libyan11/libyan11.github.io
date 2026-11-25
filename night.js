/* Game Night mode: one code, a playlist of games, and everyone moves on together.
   Each game page loads this file only when its address has ?night=…  The host keeps the night
   (playlist, scores, votes) and shares it over the same public relays the games use as a backup link.
   Games call: GN.code(), GN.name(), GN.isHost(), and the host calls GN.report(rank or null) whenever its state changes. */
(function () {
  'use strict';
  var CATALOG = {
    spade: { name: 'Spade & Speak', path: '/spade-and-speak/' },
    president: { name: 'President & Peasant', path: '/president-and-peasant/' },
    ludo: { name: 'Ludo', path: '/ludo/' },
    dominoes: { name: 'Dominoes', path: '/dominoes/' },
    liars: { name: "Liar's Dice", path: '/liars-dice/' },
    four: { name: 'Four in a Row', path: '/four-in-a-row/' },
    checkers: { name: 'Checkers', path: '/checkers/' },
    dots: { name: 'Dots and Boxes', path: '/dots-and-boxes/' },
    mancala: { name: 'Mancala', path: '/mancala/' },
    imposter: { name: 'Imposter', path: '/imposter/' },
    closest: { name: 'Closest Guess', path: '/closest-guess/' },
    codebreaker: { name: 'Code Breaker', path: '/code-breaker/' },
    memory: { name: 'Memory Match', path: '/memory-match/' },
    trivia: { name: 'Trivia', path: '/trivia/' },
    letters: { name: 'Letter Game', path: '/letter-game/' },
    cluecards: { name: 'Clue Cards', path: '/clue-cards/' },
    draw: { name: 'Draw & Guess', path: '/draw-guess/' }
  };
  var RELAYS = [
    ['wss://public.cloud.shiftr.io:443', { username: 'public', password: 'public' }],
    ['wss://broker.hivemq.com:8884/mqtt', {}],
    ['wss://broker.emqx.io:8084/mqtt', {}]
  ];
  var ROOT = 'gamenight-night-v1/';
  var PLACE_PTS = [3, 2, 1];
  var MOVE_MS = 10000, SKIP_MS = 4000, ALIVE_MS = 25000;

  function getLS(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function setLS(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rid() { return Math.random().toString(36).slice(2, 10); }

  var params = new URLSearchParams(location.search);
  var nightId = params.get('night');
  var hashCode = (location.hash || '').replace('#', '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var here = Object.keys(CATALOG).filter(function (k) { return location.pathname.indexOf(CATALOG[k].path) === 0; })[0] || null;
  var N = getLS('gn-night');
  if (!nightId) return;
  /* someone opened a night link without coming through the hub: join as a guest */
  if (!N || N.id !== nightId) {
    if (!hashCode) return;
    N = { id: nightId, code: hashCode, host: false, name: getLS('gn-name') || '', mid: rid() };
    setLS('gn-night', N);
  }
  if (!N.mid) { N.mid = rid(); setLS('gn-night', N); }

  var clients = [], seen = {}, armed = false, moveTimer = 0, tickIv = 0, hbIv = 0, pubIv = 0;
  var members = {};       /* host: mid -> {name, at} */
  var shared = N.host ? null : (getLS('gn-night-view') || null); /* guests: the latest night the host sent */
  var leaving = false;

  /* ---------- the night itself (host) ---------- */
  function cur() { return N.list[N.idx] || null; }
  function urlFor(i) { var g = N.list[i]; return CATALOG[g.g].path + '?night=' + encodeURIComponent(N.id) + '#' + N.code; }
  function save() { setLS('gn-night', N); }
  function alive() {
    var now = Date.now(), out = [{ mid: N.mid, name: N.name }];
    Object.keys(members).forEach(function (m) { if (now - members[m].at < ALIVE_MS) out.push({ mid: m, name: members[m].name }); });
    return out;
  }
  function publicNight() {
    var live = alive();
    var votes = Object.keys(N.votes || {}).filter(function (m) { return N.votes[m] === N.idx && live.some(function (x) { return x.mid === m; }); }).length;
    return { id: N.id, code: N.code, host: N.name, list: N.list, idx: N.idx, done: N.done || 0, scores: N.scores || {}, wins: N.wins || {},
      history: (N.history || []).slice(-30), over: !!N.over, members: live.map(function (x) { return x.name; }), votes: votes, need: Math.floor(live.length / 2) + 1,
      move: N.move ? { to: N.move.to, left: Math.max(0, N.move.at - Date.now()), why: N.move.why } : null, seq: (N.seq = (N.seq || 0) + 1) };
  }
  function publish() {
    if (!N.host) return;
    save();
    send('state', publicNight(), true);
    paint();
  }
  /* a finished match: 3, 2, 1 points to the first three places (ties share). Computer players don't score. */
  function score(rank) {
    var people = rank.filter(function (r) { return !r.bot; }).sort(function (a, b) { return a.place - b.place; });
    var places = [];
    people.forEach(function (r) { if (places.indexOf(r.place) < 0) places.push(r.place); });
    N.scores = N.scores || {}; N.wins = N.wins || {};
    var line = [];
    people.forEach(function (r) {
      var p = places.indexOf(r.place);
      var pts = PLACE_PTS[p] || 0;
      if (people.length > 1 && p === places.length - 1 && p > 0) pts = 0;
      N.scores[r.name] = (N.scores[r.name] || 0) + pts;
      if (p === 0) N.wins[r.name] = (N.wins[r.name] || 0) + 1;
      line.push({ name: r.name, pts: pts, place: p });
    });
    N.history = N.history || [];
    N.history.push({ g: cur().g, line: line });
  }
  function report(rank) {
    if (!N.host || N.over) return;
    if (!rank) { armed = true; return; }
    if (!armed) return;
    armed = false;
    score(rank);
    N.done = (N.done || 0) + 1;
    if (N.done >= cur().rounds) startMove(N.idx + 1, 'done');
    else publish();
  }
  function startMove(to, why) {
    if (!N.host) return;
    if (to >= N.list.length) { N.over = true; N.move = null; publish(); return; }
    N.move = { to: to, at: Date.now() + (why === 'skip' ? SKIP_MS : MOVE_MS), why: why };
    publish();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(go, N.move.at - Date.now());
  }
  function go() {
    if (!N.move) return;
    N.idx = N.move.to; N.done = 0; N.move = null; N.votes = {};
    publish();
    leaveTo(urlFor(N.idx));
  }
  function stay() {
    if (!N.move) return;
    clearTimeout(moveTimer);
    N.move = null;
    if (cur() && N.done >= cur().rounds) cur().rounds = N.done + 1;
    publish();
  }
  function leaveTo(url) {
    leaving = true; window.GN_LEAVING = true;
    setTimeout(function () { location.href = url; }, 250);
  }

  /* ---------- talking to the others ---------- */
  function topic(t) { return ROOT + N.code.toLowerCase() + '/' + t; }
  function send(t, m, retain) {
    var env = JSON.stringify({ f: N.mid, id: N.mid + '.' + rid(), m: m });
    clients.forEach(function (c) { if (c.connected) { try { c.publish(topic(t), env, { retain: !!retain }); } catch (e) { /* skip */ } } });
  }
  function connect() {
    if (typeof mqtt === 'undefined') return;
    clients = RELAYS.map(function (r) {
      var c;
      try { c = mqtt.connect(r[0], Object.assign({}, r[1], { clientId: 'gn-' + N.mid + '-' + rid().slice(0, 4), connectTimeout: 10000, reconnectPeriod: 4000, keepalive: 30 })); }
      catch (e) { return null; }
      c.on('connect', function () {
        c.subscribe(N.host ? [topic('hb'), topic('vote')] : [topic('state')]);
        if (N.host) send('state', publicNight(), true); else hello();
      });
      c.on('message', function (t, buf) {
        var env; try { env = JSON.parse(buf.toString()); } catch (e) { return; }
        if (!env || !env.id || env.f === N.mid || seen[env.id]) return;
        seen[env.id] = 1;
        var kind = t.slice(t.lastIndexOf('/') + 1);
        if (N.host) hostMsg(kind, env);
        else if (kind === 'state') guestState(env.m);
      });
      c.on('error', function () {});
      return c;
    }).filter(Boolean);
  }
  function hostMsg(kind, env) {
    var m = env.m || {};
    if (kind === 'hb') {
      var isNew = !members[env.f] || Date.now() - members[env.f].at > ALIVE_MS;
      members[env.f] = { name: String(m.name || 'Player').slice(0, 20), at: Date.now() };
      if (isNew) publish();
    } else if (kind === 'vote') {
      N.votes = N.votes || {};
      if (m.skip) N.votes[env.f] = m.idx; else delete N.votes[env.f];
      var v = publicNight();
      if (!N.move && v.votes >= v.need) startMove(N.idx + 1, 'skip'); else publish();
    }
  }
  function hello() { send('hb', { name: N.name }); }
  function vote(skip) { send('vote', { skip: skip, idx: shared ? shared.idx : 0 }); myVote = skip ? (shared ? shared.idx : 0) : -1; paint(); }
  var myVote = -1, localMoveAt = 0;
  function guestState(s) {
    if (!s || s.id !== N.id) { if (s && s.code === N.code && s.id) { N.id = s.id; save(); } else return; }
    if (shared && s.seq < shared.seq && s.host === shared.host) return;
    shared = s;
    setLS('gn-night-view', s);
    if (s.move) localMoveAt = Date.now() + s.move.left; else localMoveAt = 0;
    if (myVote >= 0 && myVote !== s.idx) myVote = -1;
    paint();
    if (s.over) return;
    if (!s.move) {
      var want = s.list[s.idx] && s.list[s.idx].g;
      if (want && want !== here) leaveTo(CATALOG[want].path + '?night=' + encodeURIComponent(N.id) + '#' + N.code);
    }
  }

  /* ---------- on screen: a small pill, a panel, the countdown and the final scores ---------- */
  var css = '' +
    '.gn-pill{position:fixed;z-index:30;top:max(6px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;border:1px solid rgba(242,179,61,.7);background:rgba(20,18,31,.92);color:#F4F2FA;font:700 12.5px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.45);cursor:pointer;max-width:46vw;white-space:nowrap}' +
    '.gn-pill b{color:#F2B33D}.gn-pill span{overflow:hidden;text-overflow:ellipsis}' +
    '.gn-pill.vote{border-color:#FF6B6B}' +
    '.gn-layer{position:fixed;inset:0;z-index:40;background:rgba(8,6,16,.84);display:grid;place-items:center;padding:16px;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#F4F2FA}' +
    '.gn-box{width:min(100%,430px);max-height:100%;overflow-y:auto;background:#1E1B2E;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.6)}' +
    '.gn-box h2{margin:0 0 4px;font-size:1.35rem}.gn-box h2 b{color:#F2B33D}.gn-box p{margin:0 0 12px;color:#A9A4C2}' +
    '.gn-list{list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:5px}' +
    '.gn-list li{display:flex;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:12px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.1)}' +
    '.gn-list li.on{border-color:#F2B33D}.gn-list li.past{opacity:.5}.gn-list small{color:#A9A4C2;font-weight:600}' +
    '.gn-btns{display:flex;gap:8px;flex-wrap:wrap}.gn-btns button,.gn-btns a{flex:1;min-width:110px;padding:11px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#F4F2FA;font:inherit;font-weight:800;cursor:pointer;text-align:center;text-decoration:none}' +
    '.gn-btns .gold{background:#F2B33D;border-color:#F2B33D;color:#241800}.gn-btns .red{border-color:#FF6B6B;color:#FFB3B3}' +
    '.gn-big{font-size:3rem;font-weight:900;color:#F2B33D;text-align:center;margin:4px 0}' +
    '.gn-eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#A9A4C2;margin:12px 0 6px}' +
    '.gn-input{width:100%;font:inherit;font-size:16px;padding:11px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:#14121F;color:#F4F2FA;margin-bottom:10px}' +
    '@media (max-width:420px){.gn-pill{top:auto;bottom:max(4px,env(safe-area-inset-bottom));left:auto;right:8px;transform:none;opacity:.95}}';
  var st = document.createElement('style'); st.textContent = css;
  var pill, layer, open = '';
  function ensure() {
    if (pill) return;
    (document.head || document.documentElement).appendChild(st);
    pill = document.createElement('button'); pill.type = 'button'; pill.className = 'gn-pill';
    pill.addEventListener('click', function () { open = open === 'panel' ? '' : 'panel'; paint(); });
    layer = document.createElement('div'); layer.className = 'gn-layer'; layer.hidden = true;
    layer.addEventListener('click', onLayer);
    document.body.appendChild(pill); document.body.appendChild(layer);
  }
  function view() { return N.host ? publicNightNoSeq() : shared; }
  function publicNightNoSeq() { var s = N.seq; var v = publicNight(); N.seq = s; return v; }
  function scoresHTML(v) {
    var names = Object.keys(v.scores || {});
    (v.members || []).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    names.sort(function (a, b) { return (v.scores[b] || 0) - (v.scores[a] || 0); });
    if (!names.length) return '<p>No points yet. Finish a game to score.</p>';
    return '<ol class="gn-list">' + names.map(function (n, k) { return '<li class="' + (n === N.name ? 'on' : '') + '"><span>' + (k + 1) + '. ' + esc(n) + ' <small>' + (v.wins[n] || 0) + ' win' + ((v.wins[n] || 0) === 1 ? '' : 's') + '</small></span><b>' + (v.scores[n] || 0) + '</b></li>'; }).join('') + '</ol>';
  }
  function listHTML(v) {
    return '<ol class="gn-list">' + v.list.map(function (g, i) {
      return '<li class="' + (i === v.idx ? 'on' : i < v.idx ? 'past' : '') + '"><span>' + (i + 1) + '. ' + esc(CATALOG[g.g].name) + '</span><small>' + (i === v.idx ? (v.done || 0) + ' of ' + g.rounds : g.rounds) + ' round' + (g.rounds === 1 ? '' : 's') + '</small></li>';
    }).join('') + '</ol>';
  }
  function paint() {
    if (!document.body) return;
    ensure();
    var v = view();
    if (!v) { pill.innerHTML = '<b>Game Night</b> <span>connecting…</span>'; return; }
    var g = v.list[v.idx];
    pill.className = 'gn-pill' + (v.votes ? ' vote' : '');
    pill.innerHTML = '<b>Night ' + (v.idx + 1) + '/' + v.list.length + '</b><span>' + (g ? esc(CATALOG[g.g].name) + ' · ' + (v.done || 0) + '/' + g.rounds : '') + (v.votes ? ' · skip ' + v.votes + '/' + v.need : '') + '</span>';
    var html = '';
    if (!N.name) html = '<div class="gn-box"><h2>Join the <b>Game Night</b></h2><p>Type your name. It is used in every game tonight.</p><input class="gn-input" id="gnName" maxlength="14" placeholder="Your name"><div class="gn-btns"><button class="gold" type="button" data-gn="name">Join</button></div></div>';
    else if (v.over) html = '<div class="gn-box"><h2>Game Night <b>over!</b></h2><p>Final scores after ' + v.list.length + ' games.</p>' + scoresHTML(v) + '<div class="gn-btns"><a class="gold" href="/" data-gn="home">Back to Game Night</a></div></div>';
    else if (v.move) {
      var left = Math.max(0, Math.ceil(((N.host ? N.move.at : localMoveAt) - Date.now()) / 1000));
      var nx = v.list[v.move.to];
      html = '<div class="gn-box"><p class="gn-eyebrow">' + (v.move.why === 'skip' ? 'Skipped' : 'Next game') + '</p><h2>' + (nx ? esc(CATALOG[nx.g].name) : '') + '</h2><div class="gn-big" id="gnLeft">' + left + '</div>' + scoresHTML(v) +
        (N.host ? '<div class="gn-btns"><button type="button" data-gn="stay">Stay: one more round here</button><button class="gold" type="button" data-gn="go">Go now</button></div>' : '<p>Everyone moves over together.</p>') + '</div>';
    } else if (open === 'panel') {
      html = '<div class="gn-box"><h2>Game <b>Night</b></h2><p>Code <b>' + esc(v.code) + '</b> · host ' + esc(v.host) + ' · ' + (v.members || []).length + ' here</p><p>Invite friends: <b>' + esc(location.host) + '/?join=' + esc(v.code) + '</b> <button type="button" data-gn="invite" style="background:none;border:1px solid rgba(255,255,255,.2);color:#F4F2FA;border-radius:999px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px">' + (navigator.share ? 'Share' : 'Copy') + '</button></p>' + listHTML(v) +
        '<p class="gn-eyebrow">Scores tonight</p>' + scoresHTML(v) +
        '<div class="gn-btns">' + (N.host ? '<button class="red" type="button" data-gn="skip">Skip this game</button>' : '<button class="red" type="button" data-gn="vote">' + (myVote === v.idx ? 'Take back skip vote' : 'Vote to skip (' + v.votes + '/' + v.need + ')') + '</button>') +
        '<button type="button" data-gn="close">Back to the game</button></div><p style="margin:12px 0 0"><button type="button" data-gn="quit" style="background:none;border:0;color:#A9A4C2;text-decoration:underline;cursor:pointer;font:inherit">' + (N.host ? 'End the Game Night' : 'Leave the Game Night') + '</button></p></div>';
    }
    layer.hidden = !html;
    if (html && layer.getAttribute('data-k') !== html) { layer.innerHTML = html; layer.setAttribute('data-k', html); var f = layer.querySelector('#gnName'); if (f) f.focus(); }
  }
  function onLayer(e) {
    var b = e.target.closest('[data-gn]');
    if (!b) { if (e.target === layer && open) { open = ''; paint(); } return; }
    var a = b.getAttribute('data-gn');
    if (a === 'close') { open = ''; paint(); }
    else if (a === 'skip') { open = ''; startMove(N.idx + 1, 'skip'); }
    else if (a === 'vote') { vote(myVote !== (shared && shared.idx)); }
    else if (a === 'invite') { var link = location.origin + '/?join=' + N.code; if (navigator.share) navigator.share({ title: 'Game Night', text: 'Join our Game Night. Code: ' + N.code, url: link }).catch(function () {}); else { try { navigator.clipboard.writeText(link); b.textContent = 'Copied'; } catch (x) {} } }
    else if (a === 'stay') stay();
    else if (a === 'go') { clearTimeout(moveTimer); go(); }
    else if (a === 'name') { var n = (document.getElementById('gnName').value || '').trim().slice(0, 14); if (!n) return; N.name = n; setLS('gn-name', n); save(); location.reload(); }
    else if (a === 'quit') {
      if (N.host) { N.over = true; N.move = null; publish(); }
      setLS('gn-night', null); setLS('gn-night-view', null);
      leaveTo(location.pathname + location.hash);
    } else if (a === 'home') { setLS('gn-night', null); setLS('gn-night-view', null); }
  }

  /* ---------- start ---------- */
  window.GN_LEAVING = false;
  window.GN = {
    on: function () { return !!N.name; },
    code: function () { return N.name ? N.code : ''; },
    name: function () { return N.name; },
    isHost: function () { return !!N.host; },
    game: function () { return here; },
    report: report
  };
  function start() {
    paint();
    if (!N.name) return;
    connect();
    if (N.host) {
      if (cur() && cur().g !== here && !N.over) { leaveTo(urlFor(N.idx)); return; }
      pubIv = setInterval(function () { publish(); }, 15000);
      if (N.move) { moveTimer = setTimeout(go, Math.max(0, N.move.at - Date.now())); }
    } else {
      hbIv = setInterval(hello, 8000);
    }
    tickIv = setInterval(function () { var el = document.getElementById('gnLeft'); if (!el) return; var at = N.host ? (N.move && N.move.at) : localMoveAt; if (!at) return; var s = Math.max(0, Math.ceil((at - Date.now()) / 1000)); el.textContent = s; if (!N.host && s <= 0 && shared && shared.move) { var nx = shared.list[shared.move.to]; if (nx) leaveTo(CATALOG[nx.g].path + '?night=' + encodeURIComponent(N.id) + '#' + N.code); } }, 250);
  }
  function whenReady() {
    if (document.body) { (window.NET || Promise.resolve()).then(start); }
    else document.addEventListener('DOMContentLoaded', function () { (window.NET || Promise.resolve()).then(start); });
  }
  whenReady();
})();
