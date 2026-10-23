/*
 * Fireboy & Watergirl: The Forest Temple - online co-op mod.
 *
 * Both PCs run the full game. Inside a level the game is driven in lockstep:
 * every 1/60 s tick both sides exchange only key presses, and the simulation is
 * made deterministic (virtual clock, seeded Math.random, tick-scheduled timers).
 * Outside levels each player browses menus freely; starting a level is mirrored.
 *
 * Transport: WebRTC data channels, signalled through the public PeerJS server
 * with a 5-letter join code (no port forwarding), or Direct IP over TCP.
 */
(function () {
  'use strict';

  var MOD_VERSION = '1.1.0';
  var PROTO = 'fbwg-forest-online-2';
  var FRAME = 1000 / 60;
  var DEFAULT_DELAY = 4;
  var DEFAULT_PORT = 7777;
  var CODE_PREFIX = 'fbwg-forest-v1-';
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var SIGNAL_URL = 'wss://0.peerjs.com:443/peerjs?key=peerjs';
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];
  var CHECKSUM_EVERY = 60;

  var nodeRequire = window.nodeRequire || null;

  // ---------------------------------------------------------------------------
  // command line (test flags) + log file
  // ---------------------------------------------------------------------------

  var argv = [];
  try { argv = nodeRequire('electron').remote.process.argv; } catch (e) { }
  function flag(name) {
    for (var i = 0; i < argv.length; i++) {
      var a = argv[i];
      if (a === '--fbwg-' + name) return true;
      if (a.indexOf('--fbwg-' + name + '=') === 0) return a.slice(name.length + 8);
    }
    return null;
  }

  var logLines = [], logPath = null;
  (function () {
    if (!nodeRequire) return;
    try {
      var path = nodeRequire('path'), fs = nodeRequire('fs');
      var dir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '.', 'FbwgForest');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      logPath = path.join(dir, 'fbwg_net_' + (flag('profile') || 'main') + '.log');
      fs.writeFileSync(logPath, '');
      setInterval(function () {
        if (!logLines.length) return;
        try { fs.appendFileSync(logPath, logLines.join('\n') + '\n'); } catch (e) { }
        logLines = [];
      }, 500);
    } catch (e) { logPath = null; }
  })();
  function log() {
    var s = Array.prototype.join.call(arguments, ' ');
    logLines.push(new Date().toISOString().slice(11, 23) + ' ' + s);
    if (window.console && console.info) console.info('[online] ' + s);
  }
  log('FBWG online co-op', MOD_VERSION, 'argv', argv.slice(1).join(' '));

  // ---------------------------------------------------------------------------
  // determinism hooks: Math.random, setTimeout, Date while a tick runs
  // ---------------------------------------------------------------------------

  var realRandom = Math.random;
  var realSetTimeout = window.setTimeout.bind(window);
  var realClearTimeout = window.clearTimeout.bind(window);
  var realDateNow = Date.now;
  var realGetTime = Date.prototype.getTime;

  var NET = window.FBWG_NET = {
    version: MOD_VERSION,
    det: false,          // true while deterministic game code runs
    seg: null,           // current lockstep segment (one per level load)
    conn: null,
    isHost: false,
    connected: false,
    hostRole: 'fb',      // which character the host controls
    delay: DEFAULT_DELAY,
    segCounter: 0,
    pendingActions: [],
    remoteApply: false,
    rtt: 0
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  Math.random = function () { return NET.det && NET.rng ? NET.rng() : realRandom(); };

  function vnow() { var s = NET.seg; return s && s.B ? s.B + s.rel : realDateNow(); }
  Date.now = function () { return NET.det && NET.seg ? vnow() : realDateNow(); };
  Date.prototype.getTime = function () {
    var t = realGetTime.call(this);
    if (NET.det && NET.seg && Math.abs(t - realDateNow()) < 1000) return vnow();
    return t;
  };

  var VTIMER_BASE = 1e9, vtimerSeq = 0;
  window.setTimeout = function (fn, ms) {
    var s = NET.seg;
    if (NET.det && s && typeof fn === 'function') {
      var id = VTIMER_BASE + (++vtimerSeq);
      var args = Array.prototype.slice.call(arguments, 2);
      s.timers.push({ id: id, due: s.rel + Math.max(0, +ms || 0), fn: fn, args: args, born: s.k });
      return id;
    }
    return realSetTimeout.apply(null, arguments);
  };
  window.clearTimeout = function (id) {
    if (typeof id === 'number' && id > VTIMER_BASE) {
      var s = NET.seg;
      if (s) s.timers = s.timers.filter(function (t) { return t.id !== id; });
      return;
    }
    return realClearTimeout(id);
  };

  function flushTimers(s) {
    // run every virtual timer due at this tick, oldest first; ones created now run next tick
    var due = s.timers.filter(function (t) { return t.due <= s.rel && t.born < s.k; });
    if (!due.length) return;
    due.sort(function (a, b) { return a.due - b.due || a.id - b.id; });
    s.timers = s.timers.filter(function (t) { return due.indexOf(t) < 0; });
    for (var i = 0; i < due.length; i++) {
      if (NET.seg !== s) {           // the level ended inside a callback: hand the rest to real time
        realSetTimeout.apply(null, [due[i].fn, 0].concat(due[i].args));
        continue;
      }
      try { due[i].fn.apply(null, due[i].args); } catch (e) { log('timer error', e && e.stack || e); }
    }
  }

  // ---------------------------------------------------------------------------
  // transport: PeerJS signalling + WebRTC, or TCP
  // ---------------------------------------------------------------------------

  function Signal(id, handlers) {
    var self = this;
    var token = Math.random().toString(36).slice(2);
    var ws = new WebSocket(SIGNAL_URL + '&id=' + encodeURIComponent(id) + '&token=' + token + '&version=1.5.4');
    var hb = null;
    this.id = id;
    this.ws = ws;
    ws.onopen = function () { hb = setInterval(function () { self.raw({ type: 'HEARTBEAT' }); }, 5000); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type !== 'HEARTBEAT') log('signal <', m.type, m.src || '');
      if (m.type === 'OPEN') handlers.open && handlers.open();
      else if (m.type === 'ID-TAKEN') handlers.error && handlers.error('code-taken');
      else if (m.type === 'ERROR') handlers.error && handlers.error((m.payload && m.payload.msg) || 'server error');
      else if (m.type === 'HEARTBEAT') { }
      else handlers.message && handlers.message(m);
    };
    ws.onerror = function () { handlers.error && handlers.error('Cannot reach the matchmaking server (check your internet).'); };
    ws.onclose = function () { clearInterval(hb); handlers.close && handlers.close(); };
  }
  Signal.prototype.raw = function (o) { try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); } catch (e) { } };
  Signal.prototype.send = function (type, dst, payload) {
    // the PeerJS cloud server silently drops payloads that don't look like its own client's
    payload.type = 'data';
    payload.connectionId = payload.cid;
    if (type === 'OFFER') { payload.label = payload.cid; payload.serialization = 'binary'; payload.reliable = false; }
    log('signal >', type, dst);
    this.raw({ type: type, dst: dst, payload: payload });
  };
  Signal.prototype.close = function () { try { this.ws.close(); } catch (e) { } };

  // A connection wraps either two RTC data channels or one TCP socket.
  function Conn(kind) {
    this.kind = kind;
    this.open = false;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    this.onopen = null;
  }
  Conn.prototype._deliver = function (str) {
    var m; try { m = JSON.parse(str); } catch (e) { return; }
    if (this.onmessage) this.onmessage(m);
  };
  Conn.prototype._opened = function () {
    if (this.open || this.closed) return;
    this.open = true;
    if (this.onopen) this.onopen();
  };
  Conn.prototype._closed = function (why) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    log('connection closed:', why);
    if (this.onclose) this.onclose(why);
  };
  Conn.prototype.send = function (o) {
    var s = JSON.stringify(o);
    try {
      if (this.kind === 'rtc') { if (this.rel && this.rel.readyState === 'open') this.rel.send(s); }
      else if (this.sock && !this.sock.destroyed) this.sock.write(s + '\n');
    } catch (e) { log('send error', e); }
  };
  Conn.prototype.sendFast = function (o) {
    if (this.kind === 'rtc' && this.fast && this.fast.readyState === 'open') {
      try { this.fast.send(JSON.stringify(o)); } catch (e) { }
      return;
    }
    this.send(o);
  };
  Conn.prototype.close = function () {
    try { if (this.rel) this.rel.close(); } catch (e) { }
    try { if (this.fast) this.fast.close(); } catch (e) { }
    try { if (this.pc) this.pc.close(); } catch (e) { }
    try { if (this.sock) this.sock.destroy(); } catch (e) { }
    try { if (this.server) this.server.close(); } catch (e) { }
    this._closed('local close');
  };

  function rtcSetup(conn, pc) {
    conn.pc = pc;
    var check = function () {
      if (conn.rel && conn.fast && conn.rel.readyState === 'open' && conn.fast.readyState === 'open') conn._opened();
    };
    var wire = function (ch) {
      if (ch.label === 'rel') conn.rel = ch; else conn.fast = ch;
      ch.onopen = check;
      ch.onmessage = function (e) { conn._deliver(e.data); };
      ch.onclose = function () { conn._closed('channel closed'); };
      check();
    };
    conn._wire = wire;
    pc.oniceconnectionstatechange = function () {
      log('ice state', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') conn._closed('ice ' + pc.iceConnectionState);
    };
  }

  function addRemoteCandidate(conn, cand) {
    if (!cand) return;
    if (!conn.remoteSet) { (conn.candQueue = conn.candQueue || []).push(cand); return; }
    conn.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(function (e) { log('candidate error', e); });
  }
  function flushCandidates(conn) {
    conn.remoteSet = true;
    (conn.candQueue || []).forEach(function (c) { addRemoteCandidate(conn, c); });
    conn.candQueue = [];
  }

  // Host: register the join code and wait for an offer.
  function hostCode(code, cb) {
    var sig, conn = null;
    sig = new Signal(CODE_PREFIX + code, {
      open: function () { cb.listening && cb.listening(); },
      error: function (e) { cb.error && cb.error(e === 'code-taken' ? 'code-taken' : e); },
      close: function () { if (!conn || !conn.open) cb.signalLost && cb.signalLost(); },
      message: function (m) {
        var p = m.payload || {};
        if (m.type === 'OFFER') {
          // already have a partner: ignore (the joiner times out with an error)
          if (conn && !conn.closed) return;
          conn = new Conn('rtc');
          conn.peerId = m.src;
          conn.cid = p.cid;
          var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          rtcSetup(conn, pc);
          pc.ondatachannel = function (e) { conn._wire(e.channel); };
          pc.onicecandidate = function (e) {
            if (e.candidate) sig.send('CANDIDATE', m.src, { cid: p.cid, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
          };
          conn.onopen = function () { sig.close(); cb.connected(conn); };
          pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
            flushCandidates(conn);
            return pc.createAnswer();
          }).then(function (ans) {
            return pc.setLocalDescription(ans);
          }).then(function () {
            sig.send('ANSWER', m.src, { cid: p.cid, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          }).catch(function (e) { log('answer error', e); });
          log('offer from', m.src);
        } else if (m.type === 'CANDIDATE' && conn && p.cid === conn.cid) {
          addRemoteCandidate(conn, p.candidate);
        }
      }
    });
    return { close: function () { sig.close(); } };
  }

  // Client: connect to a join code.
  function joinCode(code, cb) {
    var myId = 'fbwg-c-' + Math.random().toString(36).slice(2, 12);
    var dst = CODE_PREFIX + code;
    var cid = 'c' + Math.random().toString(36).slice(2, 10);
    var conn = new Conn('rtc');
    var done = false;
    var fail = function (why) {
      if (done) return;
      done = true;
      try { sig.close(); } catch (e) { }
      try { conn.close(); } catch (e) { }
      cb.error(why);
    };
    var timer = realSetTimeout(function () { fail('Could not connect. The code may be wrong, or your networks block direct connections (try Direct IP).'); }, 25000);
    var sig = new Signal(myId, {
      open: function () {
        var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        rtcSetup(conn, pc);
        conn._wire(pc.createDataChannel('rel', { ordered: true }));
        conn._wire(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
        pc.onicecandidate = function (e) {
          if (e.candidate) sig.send('CANDIDATE', dst, { cid: cid, candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
        };
        pc.createOffer().then(function (offer) {
          return pc.setLocalDescription(offer);
        }).then(function () {
          sig.send('OFFER', dst, { cid: cid, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          cb.status && cb.status('Contacting host...');
        }).catch(function (e) { fail('WebRTC error: ' + e); });
      },
      error: function (e) { fail(e); },
      message: function (m) {
        var p = m.payload || {};
        if (m.type === 'EXPIRE') fail('No game found with code ' + code + '.');
        else if (m.type === 'ANSWER' && p.cid === cid && p.reject) fail('That game already has two players.');
        else if (m.type === 'ANSWER' && p.cid === cid) {
          conn.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
            flushCandidates(conn);
            cb.status && cb.status('Connecting...');
          }).catch(function (e) { fail('WebRTC error: ' + e); });
        } else if (m.type === 'CANDIDATE' && p.cid === cid) {
          addRemoteCandidate(conn, p.candidate);
        }
      }
    });
    conn.onopen = function () {
      if (done) return;
      done = true;
      realClearTimeout(timer);
      sig.close();
      cb.connected(conn);
    };
    return { close: function () { fail('cancelled'); } };
  }

  function tcpWire(conn, sock) {
    conn.sock = sock;
    sock.setNoDelay(true);
    sock.setEncoding('utf8');
    var buf = '';
    sock.on('data', function (d) {
      buf += d;
      var i;
      while ((i = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) conn._deliver(line);
      }
    });
    sock.on('close', function () { conn._closed('tcp closed'); });
    sock.on('error', function (e) { log('tcp error', e.message); });
  }

  function hostTcp(port, cb) {
    if (!nodeRequire) { cb.error('Direct IP needs the game to start with Steam running.'); return null; }
    var net = nodeRequire('net');
    var conn = null;
    var server = net.createServer(function (sock) {
      if (conn && !conn.closed) { sock.destroy(); return; }
      conn = new Conn('tcp');
      tcpWire(conn, sock);
      server.close();
      conn._opened();
      cb.connected(conn);
    });
    server.on('error', function (e) { cb.error('Cannot listen on port ' + port + ': ' + e.message); });
    server.listen(port, function () { cb.listening && cb.listening(); });
    return { close: function () { try { server.close(); } catch (e) { } } };
  }

  function joinTcp(host, port, cb) {
    if (!nodeRequire) { cb.error('Direct IP needs the game to start with Steam running.'); return null; }
    var net = nodeRequire('net');
    var conn = new Conn('tcp');
    var sock = net.connect(port, host);
    var t = realSetTimeout(function () { sock.destroy(); cb.error('Timed out connecting to ' + host + ':' + port); }, 10000);
    sock.on('connect', function () {
      realClearTimeout(t);
      tcpWire(conn, sock);
      conn._opened();
      cb.connected(conn);
    });
    sock.on('error', function (e) { realClearTimeout(t); if (!conn.open) cb.error('Cannot connect to ' + host + ':' + port + ': ' + e.message); });
    return { close: function () { sock.destroy(); } };
  }

  // ---------------------------------------------------------------------------
  // session
  // ---------------------------------------------------------------------------

  var pendingHandle = null;   // listening/joining in progress
  var game = null, LevelClass = null;
  var pingTimer = null;

  function makeCode() {
    var s = '';
    for (var i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(realRandom() * CODE_CHARS.length)];
    return s;
  }

  function cancelPending() {
    if (pendingHandle) { try { pendingHandle.close(); } catch (e) { } }
    pendingHandle = null;
  }

  function startHosting(mode, opt) {
    disconnect(true);
    NET.isHost = true;
    var cbs = {
      listening: function () {
        if (mode === 'code') { ui.setStatus('Waiting for your friend to join with the code above...', 'wait'); ui.showCode(NET.code); writeCodeFile(); }
        else ui.setStatus('Hosting on port ' + opt.port + '. Waiting for your friend to connect...', 'wait');
        log('listening', mode, NET.code || opt.port);
      },
      error: function (e) {
        if (e === 'code-taken') { NET.code = makeCode(); pendingHandle = hostCode(NET.code, cbs); return; }
        ui.setStatus(String(e), 'err');
        log('host error', e);
        pendingHandle = null;
      },
      signalLost: function () { if (!NET.connected && pendingHandle) ui.setStatus('Lost the matchmaking server. Press Host again.', 'err'); },
      connected: function (conn) { pendingHandle = null; onConnected(conn); }
    };
    if (mode === 'code') {
      NET.code = makeCode();
      ui.setStatus('Creating game...', 'wait');
      pendingHandle = hostCode(NET.code, cbs);
    } else {
      pendingHandle = hostTcp(opt.port, cbs);
    }
  }

  function startJoining(mode, opt) {
    disconnect(true);
    NET.isHost = false;
    var cbs = {
      status: function (s) { ui.setStatus(s, 'wait'); },
      error: function (e) { pendingHandle = null; ui.setStatus(String(e), 'err'); log('join error', e); },
      connected: function (conn) { pendingHandle = null; onConnected(conn); }
    };
    if (mode === 'code') {
      ui.setStatus('Looking for game ' + opt.code + '...', 'wait');
      pendingHandle = joinCode(opt.code, cbs);
    } else {
      ui.setStatus('Connecting to ' + opt.host + ':' + opt.port + '...', 'wait');
      pendingHandle = joinTcp(opt.host, opt.port, cbs);
    }
  }

  function writeCodeFile() {
    var f = flag('codefile');
    if (!f || !nodeRequire) return;
    try { nodeRequire('fs').writeFileSync(f, NET.code); } catch (e) { }
  }

  function onConnected(conn) {
    NET.conn = conn;
    conn.onmessage = onMessage;
    conn.onclose = function (why) { if (NET.conn === conn) onDisconnected(why); };
    log('connected via', conn.kind, NET.isHost ? 'as host' : 'as client');
    ui.setStatus('Connected. Checking versions...', 'wait');
    if (!NET.isHost) conn.send({ t: 'hello', proto: PROTO, ver: MOD_VERSION, name: myName() });
  }

  function myName() {
    try { return String(window.greenworks.getSteamId().screenName || '').slice(0, 24) || 'Player'; } catch (e) { return 'Player'; }
  }

  function sessionReady() {
    NET.connected = true;
    NET.segCounter = 0;
    if (game) { NET.savedVisibility = game.stage.disableVisibilityChange; game.stage.disableVisibilityChange = true; }
    clearInterval(pingTimer);
    pingTimer = setInterval(function () { if (NET.conn) NET.conn.send({ t: 'ping', ts: performance.now() }); }, 1000);
    ui.setStatus('Connected! You are ' + roleName(myRole()) + '. ' + (NET.isHost ? 'Pick a level from the level map.' : 'Player 1 (the host) picks the levels.'), 'ok');
    NET.hostScreen = null;
    NET.mirrorKey = null;
    ui.toast('Partner connected! You are ' + roleName(myRole()));
    if (NET.isHost) coop.hostStart();
    ui.refresh();
    log('session ready, host role', NET.hostRole, 'delay', NET.delay);
  }

  function onDisconnected(why) {
    var was = NET.connected;
    NET.connected = false;
    NET.conn = null;
    clearInterval(pingTimer);
    if (NET.seg) endSegment('disconnect');
    coop.stop();
    if (game) game.stage.disableVisibilityChange = !!NET.savedVisibility;
    if (was) { ui.toast('Partner disconnected'); ui.setStatus('Disconnected (' + why + ').', 'err'); }
    ui.refresh();
  }

  function disconnect(silent) {
    cancelPending();
    if (NET.conn) {
      try { NET.conn.send({ t: 'bye' }); } catch (e) { }
      var c = NET.conn;
      NET.conn = null;
      c.close();
      onDisconnected('you left');
    }
    NET.code = null;
    if (!silent) ui.setStatus('Not connected.', '');
    ui.refresh();
  }

  function myRole() { return NET.isHost ? NET.hostRole : (NET.hostRole === 'fb' ? 'wg' : 'fb'); }
  function roleName(r) { return r === 'fb' ? 'Fireboy' : 'Watergirl'; }

  function onMessage(m) {
    var s = NET.seg;
    switch (m.t) {
      case 'hello':
        if (!NET.isHost) return;
        if (m.proto !== PROTO) {
          NET.conn.send({ t: 'reject', why: 'version', ver: MOD_VERSION });
          ui.setStatus('Your friend has a different mod version (' + m.ver + ' vs ' + MOD_VERSION + ').', 'err');
          realSetTimeout(function () { disconnect(true); }, 500);
          return;
        }
        NET.peerName = String(m.name || 'Player').slice(0, 24);
        NET.conn.send({ t: 'welcome', proto: PROTO, ver: MOD_VERSION, hostRole: NET.hostRole, delay: NET.delay, name: myName() });
        sessionReady();
        break;
      case 'welcome':
        NET.peerName = String(m.name || 'Player').slice(0, 24);
        NET.hostRole = m.hostRole;
        NET.delay = m.delay || DEFAULT_DELAY;
        sessionReady();
        break;
      case 'reject':
        ui.setStatus('The host has a different mod version (' + m.ver + ' vs ' + MOD_VERSION + '). Both players need the same version.', 'err');
        disconnect(true);
        break;
      case 'bye':
        if (NET.conn) { var c = NET.conn; NET.conn = null; c.close(); onDisconnected('partner left'); }
        break;
      case 'ping': NET.conn && NET.conn.send({ t: 'pong', ts: m.ts }); break;
      case 'pong': NET.rtt = performance.now() - m.ts; ui.refreshHud(); break;
      case 'role':
        NET.hostRole = m.hostRole;
        ui.toast('You are now ' + roleName(myRole()));
        ui.refresh();
        break;
      case 'start': applyRemoteStart(m); break;
      case 'req': onStartRequest(m); break;
      case 'screen':
        if (NET.isHost) return;
        NET.hostScreen = m;
        applyHostScreen();
        break;
      case 'hover': if (!NET.isHost) ui.showHostPointer(m.id); break;
      case 'coop': if (!NET.isHost) coop.joinerReceive(m.save); break;
      case 'busy': ui.toast('Your partner is still in a level.'); break;
      case 'ready':
        if (s && s.id === m.s) {
          if (m.file !== s.file) { log('LEVEL MISMATCH', m.file, s.file); ui.toast('Level mismatch - leaving level'); }
          s.remoteReady = true;
          s.remoteNow = m.now;
          maybeGo();
        } else (NET.early = NET.early || []).push(m);
        break;
      case 'go':
        if (s && s.id === m.s) beginRun(m.B);
        else (NET.early = NET.early || []).push(m);
        break;
      case 'i': onInputs(m); break;
      case 'c': onChecksum(m); break;
      case 'end':
        if (s && s.id === m.s) { s.peerEnded = m.k; log('peer ended segment', m.s, 'at', m.k); }
        break;
    }
  }

  function replayEarly() {
    var early = NET.early || [];
    NET.early = [];
    var cur = NET.seg ? NET.seg.id : 0;
    early.filter(function (m) { return m.s >= cur; }).forEach(onMessage);
  }

  function setHostRole(r) {
    NET.hostRole = r;
    if (NET.connected) NET.conn.send({ t: 'role', hostRole: r });
    ui.refresh();
  }

  // ---------------------------------------------------------------------------
  // level start mirroring
  // ---------------------------------------------------------------------------

  function findLevel(templeId, file) {
    var temples = (game.progress && game.progress.get && game.progress.get('temples')) || [];
    for (var i = 0; i < temples.length; i++) {
      if (templeId && temples[i].id !== templeId) continue;
      for (var j = 0; j < temples[i].levels.length; j++) {
        if (temples[i].levels[j].filename === file) return { temple: temples[i], level: temples[i].levels[j] };
      }
    }
    return null;
  }

  function startLevelLocal(temple, level, remote) {
    if (temple) game.currentTemple = temple;
    if (game.menuMusic && game.menuMusic.isPlaying) {
      try { game.menuMusic.fadeOut(500); game.menuMusic.onFadeComplete.addOnce(function (m) { m.stop(); }); } catch (e) { }
    }
    try { game.progress.setPlayed(level); } catch (e) { }
    // a player starting from the title screen never registered the level map; leaving the level needs it
    if (!game.state.states.levelMenu) game.state.add('levelMenu', requirejs('States/LevelMenu/LevelMenu'));
    game.state.add('level', LevelClass);
    NET.remoteApply = !!remote;
    try { game.state.fade('level', true, false, level); } finally { NET.remoteApply = false; }
  }

  function applyRemoteStart(m) {
    var f = findLevel(m.temple, m.file);
    if (!f) { log('start: level not found', m.temple, m.file); ui.toast('Cannot find level ' + m.file); return; }
    if (game.state.fading || NET.seg) {
      // wait for the current transition to finish
      realSetTimeout(function () { applyRemoteStart(m); }, 100);
      return;
    }
    log('remote start', m.file);
    ui.close();
    startLevelLocal(f.temple, f.level, true);
  }

  function onStartRequest(m) {
    if (!NET.isHost) return;
    if (NET.seg || game.state.current === 'level') { NET.conn.send({ t: 'busy' }); return; }
    var f = findLevel(m.temple, m.file);
    if (!f) return;
    if (game.state.fading) { realSetTimeout(function () { onStartRequest(m); }, 100); return; }
    log('partner requested level', m.file);
    ui.close();
    startLevelLocal(f.temple, f.level, false);
  }

  // ---------------------------------------------------------------------------
  // co-op save files: one shared progress (level results, unlocks, diamonds) per pair of players,
  // kept as identical files on both PCs in %LOCALAPPDATA%\FbwgForest\coop_saves. While connected the
  // game's progress is swapped for the co-op save and its own save goes to that file instead, so each
  // player's solo save is never written; disconnecting swaps the solo progress back.
  // ---------------------------------------------------------------------------

  var coop = {
    active: null,     // the co-op save in use: { id, name, created, updated, data }
    solo: null,       // this player's own progress while a co-op save is swapped in
    choice: null,     // host: id of the save picked in the panel ('new' = start a new one)

    dir: function () {
      if (!nodeRequire) return null;
      var path = nodeRequire('path'), fs = nodeRequire('fs');
      var base = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || '.', 'FbwgForest');
      var d = path.join(base, 'coop_saves' + (flag('profile') ? '_' + flag('profile') : ''));
      try { if (!fs.existsSync(base)) fs.mkdirSync(base); if (!fs.existsSync(d)) fs.mkdirSync(d); } catch (e) { return null; }
      return d;
    },

    list: function () {
      var d = this.dir(), out = [];
      if (!d) return out;
      var fs = nodeRequire('fs'), path = nodeRequire('path');
      fs.readdirSync(d).forEach(function (f) {
        if (!/^coop_[\w-]+\.json$/.test(f)) return;
        try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch (e) { log('bad co-op save', f); }
      });
      out.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
      return out;
    },

    write: function (save) {
      var d = this.dir();
      if (!d || !/^[\w-]+$/.test(save.id)) return;
      var fs = nodeRequire('fs'), path = nodeRequire('path');
      var file = path.join(d, 'coop_' + save.id + '.json');
      try {
        fs.writeFileSync(file + '.tmp', JSON.stringify(save, null, 1));
        fs.renameSync(file + '.tmp', file);   // a crash mid-write can't leave a half-written save
      } catch (e) { log('co-op save write failed', e.message); }
    },

    // the parts of the game's progress that its own save keeps
    snapshot: function () {
      var p = game.progress, levels = {};
      p.get('temples').forEach(function (t) {
        t.levels.forEach(function (l) {
          if (l.best == null && !l.played) return;
          (levels[t.id] = levels[t.id] || {})[l.id] = { best: l.best || null, played: !!l.played };
        });
      });
      return { levels: levels, gameComplete: !!p.get('gameComplete'), gameTotalComplete: !!p.get('gameTotalComplete'), touchLearned: !!p.get('touchLearned') };
    },

    apply: function (snap) {
      var p = game.progress;
      p.get('temples').forEach(function (t) {
        var lv = snap.levels[t.id] || {};
        t.levels.forEach(function (l) {
          var s = lv[l.id];
          if (s && s.best) l.best = s.best; else delete l.best;
          if (s && s.played) l.played = true; else delete l.played;
        });
      });
      p.set('gameComplete', snap.gameComplete);
      p.set('gameTotalComplete', snap.gameTotalComplete);
      p.set('touchLearned', snap.touchLearned);
      p.process();                       // recompute unlocks/stars; its save() is redirected while co-op is active
      p.firstComplete = p.firstTotalComplete = false;   // loading a save shouldn't replay the "temple complete" screens
      // redraw the level map if it's showing
      if (game.state.current === 'levelMenu' && !game.state.fading && !NET.seg) game.state.start('levelMenu', true, false, game.currentTemple);
    },

    stats: function (save) {
      var done = 0, diamonds = 0, levels = save.data.levels;
      for (var t in levels) for (var l in levels[t]) {
        var b = levels[t][l].best;
        if (b) { done++; diamonds += b.diamonds || 0; }
      }
      return { done: done, diamonds: diamonds };
    },

    use: function (save) {
      if (!this.solo) this.solo = this.snapshot();
      this.active = save;
      this.apply(save.data);
      log('co-op save in use:', save.id, save.name, JSON.stringify(this.stats(save)), 'solo was', JSON.stringify(this.stats({ data: this.solo })));
    },

    // host: load the save picked in the panel (or the newest one) and share it with the joiner
    hostStart: function () {
      var saves = this.list(), save = null, id = this.choice;
      if (id && id !== 'new') save = saves.filter(function (s) { return s.id === id; })[0] || null;
      if (!save && id !== 'new' && saves.length) save = saves[0];
      if (!save) save = this.create();
      this.choice = save.id;
      this.use(save);
      this.write(save);
      this.send();
      ui.refresh();
    },

    create: function () {
      var now = realDateNow();
      var save = {
        id: now.toString(36) + '-' + Math.floor(realRandom() * 1e9).toString(36),
        name: myName() + ' & ' + (NET.peerName || 'friend'),
        created: now, updated: now,
        data: { levels: {}, gameComplete: false, gameTotalComplete: false, touchLearned: true }
      };
      log('new co-op save', save.id);
      return save;
    },

    // host picked another save in the panel
    pick: function (id) {
      this.choice = id;
      if (NET.connected && NET.isHost) {
        if (NET.seg || game.state.current === 'level') { ui.toast('Change the save from the menus, not during a level'); ui.refresh(); return; }
        this.hostStart();
        ui.toast('Loaded co-op save: ' + this.active.name);
      }
      ui.refresh();
    },

    // the game saved its progress (after a level): write the co-op file; the host also sends it over
    onGameSave: function () {
      if (!this.active || !NET.isHost) return;
      this.active.data = this.snapshot();
      this.active.updated = realDateNow();
      this.write(this.active);
      this.send();
    },

    send: function () {
      if (NET.conn && NET.connected && this.active) NET.conn.send({ t: 'coop', save: this.active });
    },

    joinerReceive: function (save) {
      if (!save || !save.id || !save.data) return;
      var first = !this.active || this.active.id !== save.id;
      this.write(save);
      this.active = save;
      if (first) { this.use(save); ui.toast('Co-op save: ' + save.name); }
      else if (!NET.seg) this.apply(save.data);
      ui.refresh();
    },

    stop: function () {
      if (!this.solo) { this.active = null; return; }
      var solo = this.solo;
      this.active = null;
      this.solo = null;
      this.apply(solo);                  // the game's save() goes back to the player's own save
      log('co-op save closed; solo progress restored', JSON.stringify(this.stats({ data: this.snapshot() })));
    }
  };

  // ---------------------------------------------------------------------------
  // host-only level map: the joiner sees a read-only copy of the host's map
  // ---------------------------------------------------------------------------

  function plainCopy(obj) {
    // JSON copy that skips cycles and Phaser/DOM objects (templeData holds only plain level info)
    var seen = [];
    return JSON.parse(JSON.stringify(obj, function (k, v) {
      if (v && typeof v === 'object') {
        if (seen.indexOf(v) >= 0) return undefined;
        if (v.game || v.nodeType) return undefined;
        seen.push(v);
      }
      return v;
    }));
  }

  // host: tell the joiner which screen we're on (title screen or the level map with our progress)
  function sendScreen() {
    if (!NET.connected || !NET.isHost || NET.seg) return;
    var cur = game.state.current, st = game.state.states[cur];
    if (cur === 'levelMenu' && st && st.templeData) NET.conn.send({ t: 'screen', name: 'levelMenu', temple: plainCopy(st.templeData) });
    else if (cur === 'menu') NET.conn.send({ t: 'screen', name: 'menu' });
  }

  var screenRetry = null;
  // joiner: follow the host to its current screen once we're out of any level
  function applyHostScreen() {
    var m = NET.hostScreen;
    if (!m || !NET.connected || NET.isHost) return;
    if (NET.seg || game.state.current === 'level' || game.state.fading) {
      if (!screenRetry) screenRetry = realSetTimeout(function () { screenRetry = null; applyHostScreen(); }, 300);
      return;
    }
    if (m.name === 'levelMenu') {
      var key = JSON.stringify(m.temple);
      if (game.state.current === 'levelMenu' && NET.mirrorKey === key) return;
      NET.mirrorKey = key;
      if (!game.state.states.levelMenu) game.state.add('levelMenu', requirejs('States/LevelMenu/LevelMenu'));
      log('mirror host level map');
      NET.remoteApply = true;
      try {
        // already on the map: redraw in place with the host's latest progress
        if (game.state.current === 'levelMenu') game.state.start('levelMenu', true, false, m.temple);
        else game.state.fade('levelMenu', true, false, m.temple);
      } finally { NET.remoteApply = false; }
    } else if (m.name === 'menu' && game.state.current !== 'menu') {
      NET.mirrorKey = null;
      NET.remoteApply = true;
      try { game.state.fade('menu', true, false); } finally { NET.remoteApply = false; }
    }
  }

  // joiner shows the host's screens greyed out and can't click them
  function mirrorActive() {
    return NET.connected && !NET.isHost && !NET.seg && game &&
      (game.state.current === 'levelMenu' || game.state.current === 'menu');
  }

  // host: which level button is under the mouse (sent so the joiner sees what the host is looking at)
  var lastHover = null;
  function hostPointerMove(e) {
    if (!NET.connected || !NET.isHost || NET.seg || game.state.current !== 'levelMenu') return;
    var st = game.state.states.levelMenu, id = null;
    var buttons = st && st.buttons && st.buttons.children || [];
    var pt = { x: e.clientX, y: e.clientY };
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.data && b.data._id !== undefined && b.hitArea && game.input.hitTest(b, pt, new Phaser.Point())) { id = b.data._id; break; }
    }
    if (id === lastHover) return;
    lastHover = id;
    NET.conn.send({ t: 'hover', id: id });
  }

  // joiner: screen position of the level button the host points at
  function levelButtonRect(id) {
    var st = game.state.states.levelMenu;
    var buttons = st && st.buttons && st.buttons.children || [];
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.data && b.data._id === id && b.diamond) {
        var res = game.resolution || 1, wt = b.worldTransform;
        var size = b.diamond.width * Math.abs(b.worldScale ? b.worldScale.x : 1) / res;
        return { x: wt.tx / res, y: wt.ty / res, size: Math.max(40, size * 1.5) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // lockstep segments (one per loaded level)
  // ---------------------------------------------------------------------------

  // keys the simulation listens to
  var KEYS = {
    ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, KeyW: 87, KeyA: 65, KeyD: 68,
    KeyP: 80, KeyR: 82, Escape: 27
  };
  var KEY_ORDER = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyD', 'KeyP', 'KeyR', 'Escape'];
  var B_UP = 1, B_LEFT = 2, B_RIGHT = 4, B_P = 8, B_R = 16, B_ESC = 32;
  var ROLE_KEYS = {
    fb: { up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight' },
    wg: { up: 'KeyW', left: 'KeyA', right: 'KeyD' }
  };

  function newSegment(level) {
    var s = {
      id: ++NET.segCounter,
      file: level.levelData && level.levelData.filename,
      level: level,
      phase: 'loading',
      k: 0, rel: 0, B: 0,
      delay: NET.delay,
      timers: [],
      local: [], remote: [],
      localMax: -1, remoteMax: -1, peerAck: -1,
      held: {},
      sums: {}, peerSums: {},
      desync: false,
      peerEnded: null,
      acc: 0, lastTs: 0, lastSend: 0,
      stallSince: 0,
      controlsBefore: null
    };
    s.seed = hashStr(PROTO + '|' + s.id + '|' + s.file);
    return s;
  }

  function enterDet(s) {
    NET.det = true;
    NET.rng = s.rng;
  }
  function exitDet() { NET.det = false; }

  function maybeGo() {
    var s = NET.seg;
    if (!s || s.phase !== 'loading' || !s.localReady || !s.remoteReady || !NET.isHost) return;
    var B = Math.max(realDateNow(), s.remoteNow || 0) + 50;
    NET.conn.send({ t: 'go', s: s.id, B: B });
    beginRun(B);
  }

  function beginRun(B) {
    var s = NET.seg;
    if (!s || s.phase !== 'loading') return;
    s.phase = 'run';
    s.B = B;
    for (var t = 0; t < s.delay; t++) { s.local[t] = 0; s.remote[t] = 0; }
    s.localMax = s.delay - 1;
    // the host's first inputs can overtake its 'go' message
    s.remoteMax = s.delay - 1;
    while (s.remote[s.remoteMax + 1] !== undefined) s.remoteMax++;
    s.lastTs = performance.now();
    s.acc = FRAME;
    tappedKeys = {};   // keys tapped in the menus don't carry into the level
    game.time.suggestedFps = 60;
    log('segment', s.id, 'running', s.file, 'B', B, 'delay', s.delay);
    ui.refreshHud();
  }

  function sampleLocal() {
    // a key tapped and released between two frames still counts for this frame
    var k = {}, c;
    for (c in keyState) if (keyState[c]) k[c] = true;
    for (c in tappedKeys) k[c] = true;
    tappedKeys = {};
    var b = 0;
    if (k.ArrowUp || k.KeyW) b |= B_UP;
    if (k.ArrowLeft || k.KeyA) b |= B_LEFT;
    if (k.ArrowRight || k.KeyD) b |= B_RIGHT;
    if (k.KeyP) b |= B_P;
    if (k.KeyR) b |= B_R;
    if (k.Escape) b |= B_ESC;
    if (bot.on) b = bot.sample(b);
    if (demo.on) b |= demo.sample();
    return b;
  }

  function queueLocalInput(s, tick) {
    var bits = sampleLocal();
    var entry = bits;
    if (NET.pendingActions.length) { entry = [bits, NET.pendingActions]; NET.pendingActions = []; }
    s.local[tick] = entry;
    s.localMax = tick;
  }

  function sendInputs(s, force) {
    if (!NET.conn) return;
    var from = Math.max(s.peerAck + 1, 0);
    if (from > s.localMax) { if (!force) return; from = s.localMax; }
    if (s.localMax - from > 90) from = s.localMax - 90;
    NET.conn.sendFast({ t: 'i', s: s.id, b: from, e: s.local.slice(from, s.localMax + 1), a: s.remoteMax });
    s.lastSend = performance.now();
  }

  function onInputs(m) {
    var s = NET.seg;
    if (!s || s.id !== m.s) return;
    for (var i = 0; i < m.e.length; i++) {
      var t = m.b + i;
      if (s.remote[t] === undefined) s.remote[t] = m.e[i];
    }
    while (s.remote[s.remoteMax + 1] !== undefined) s.remoteMax++;
    if (m.a > s.peerAck) s.peerAck = m.a;
  }

  function haveRemote(s, k) {
    return s.remote[k] !== undefined || (s.peerEnded !== null && k > s.peerEnded) || !NET.connected;
  }
  function entryBits(e) { return e === undefined ? 0 : (typeof e === 'number' ? e : e[0]); }
  function entryActions(e) { return e && typeof e !== 'number' ? e[1] : null; }

  function resetKeys() {
    var kb = game.input.keyboard;
    for (var i = 0; i < KEY_ORDER.length; i++) {
      var key = kb._keys && kb._keys[KEY_ORDER[i]];
      if (key) key.reset(false);
    }
  }

  function synthKey(code, down) {
    var ev = {
      code: code, keyCode: KEYS[code], which: KEYS[code], key: code,
      altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
      timeStamp: vnow(), preventDefault: function () { }, stopPropagation: function () { }
    };
    NET.synth = true;
    try {
      if (down) game.input.keyboard.processKeyDown(ev);
      else game.input.keyboard.processKeyUp(ev);
    } catch (e) { log('key error', e && e.stack || e); }
    NET.synth = false;
  }

  function applyInputs(s, k) {
    var hostE = NET.isHost ? s.local[k] : s.remote[k];
    var clientE = NET.isHost ? s.remote[k] : s.local[k];
    var hb = entryBits(hostE), cb = entryBits(clientE);
    var hr = ROLE_KEYS[NET.hostRole], cr = ROLE_KEYS[NET.hostRole === 'fb' ? 'wg' : 'fb'];
    var want = {};
    if (hb & B_UP) want[hr.up] = 1;
    if (hb & B_LEFT) want[hr.left] = 1;
    if (hb & B_RIGHT) want[hr.right] = 1;
    if (cb & B_UP) want[cr.up] = 1;
    if (cb & B_LEFT) want[cr.left] = 1;
    if (cb & B_RIGHT) want[cr.right] = 1;
    var misc = hb | cb;
    if (misc & B_P) want.KeyP = 1;
    if (misc & B_R) want.KeyR = 1;
    if (misc & B_ESC) want.Escape = 1;
    for (var i = 0; i < KEY_ORDER.length; i++) {
      var c = KEY_ORDER[i];
      if (want[c] && !s.held[c]) { s.held[c] = 1; synthKey(c, true); }
      else if (!want[c] && s.held[c]) { s.held[c] = 0; synthKey(c, false); }
      if (NET.seg !== s) return;
    }
    var acts = [entryActions(hostE), entryActions(clientE)];
    for (var j = 0; j < 2; j++) {
      if (!acts[j]) continue;
      for (var a = 0; a < acts[j].length; a++) {
        if (NET.seg !== s) return;
        runAction(acts[j][a]);
      }
    }
  }

  function runAction(a) {
    var lvl = game.level;
    log('action', JSON.stringify(a));
    try {
      if (a.f === 'fade') {
        var data = a.n === 'level' ? lvl && lvl.levelData : (a.n === 'levelMenu' ? game.currentTemple : undefined);
        if (a.n === 'level') game.state.add('level', LevelClass);
        game.state.fade(a.n, true, false, data);
      } else if (lvl && typeof lvl[a.f] === 'function') {
        lvl[a.f]();
      }
    } catch (e) { log('action error', e && e.stack || e); }
  }

  function runTick(s) {
    var k = s.k;
    var t = game.time;
    enterDet(s);
    try {
      s.rel = k * FRAME;
      var V = s.B + s.rel;
      t.prevTime = t.now;
      t.now = V;
      t.time = V;
      t.elapsed = FRAME;
      t.elapsedMS = FRAME;
      if (k === 0) {
        resetKeys();
        if (s.startFn) s.startFn();
      }
      if (NET.seg === s) flushTimers(s);
      if (NET.seg === s && !game.paused) {
        t.events.update(V);
        if (t._timers.length) t.updateTimers();
      }
      if (NET.seg === s) applyInputs(s, k);
      if (NET.seg === s) game.updateLogic(t.desiredFpsMult);
    } catch (e) {
      log('tick error', k, e && e.stack || e);
    }
    exitDet();
    if (NET.seg === s) {
      s.k = k + 1;
      if (k % CHECKSUM_EVERY === 0 && k > 0) checksum(s, k);
      if (traceOn && k % 15 === 0 && game.level && game.level.pers1) {
        var l = game.level;
        log('trace', k, 'fb', Math.round(l.pers1.sprite.x), Math.round(l.pers1.sprite.y), l.pers1.isDead ? 'DEAD' : '',
          'wg', Math.round(l.pers2.sprite.x), Math.round(l.pers2.sprite.y), l.pers2.isDead ? 'DEAD' : '');
      }
    }
  }

  function checksum(s, k) {
    // while leaving a level the exact switch-over tick may differ by a frame or two; nothing to compare
    if (game.state.fading) return;
    var h = 2166136261;
    var mix = function (v) {
      var q = Math.round(v * 1000) | 0;
      h ^= q; h = Math.imul(h, 16777619);
    };
    try {
      var b = game.physics.box2d.world.GetBodyList();
      for (; b; b = b.GetNext()) {
        var p = b.GetPosition();
        mix(p.x); mix(p.y); mix(b.GetAngle());
        var v = b.GetLinearVelocity();
        mix(v.x); mix(v.y);
      }
      var lv = game.level;
      if (lv && lv.pers1) { mix(lv.pers1.isDead ? 1 : 0); mix(lv.pers2.isDead ? 1 : 0); }
    } catch (e) { mix(-1); }
    h = h >>> 0;
    s.sums[k] = h;
    if (NET.conn) NET.conn.send({ t: 'c', s: s.id, k: k, h: h });
    compareSums(s, k);
  }

  function onChecksum(m) {
    var s = NET.seg;
    if (!s || s.id !== m.s) return;
    s.peerSums[m.k] = m.h;
    compareSums(s, m.k);
  }

  function compareSums(s, k) {
    if (s.sums[k] === undefined || s.peerSums[k] === undefined) return;
    if (s.sums[k] !== s.peerSums[k]) {
      if (!s.desync) {
        s.desync = true;
        log('DESYNC segment', s.id, 'tick', k, s.sums[k], s.peerSums[k]);
        ui.refreshHud();
      }
    } else if (k % 600 === 0) log('sync ok seg', s.id, 'tick', k);
    delete s.sums[k];
    delete s.peerSums[k];
  }

  function runDue(now) {
    var s = NET.seg;
    if (!s || s.phase !== 'run') return;
    var dt = now - s.lastTs;
    s.lastTs = now;
    s.acc = Math.min(s.acc + Math.max(0, dt), FRAME * 5);
    var ran = 0;
    while (NET.seg === s && s.phase === 'run' && ran < 5) {
      // peer is ahead of us (it already sent inputs far beyond our tick): catch up a little
      var ahead = s.remoteMax - (s.k + s.delay);
      if (s.acc < FRAME && !(ahead > 2 && ran < 2)) break;
      if (!haveRemote(s, s.k)) {
        if (!s.stallSince) s.stallSince = now;
        break;
      }
      if (s.stallSince) { s.stallSince = 0; }
      if (s.local[s.k + s.delay] === undefined) {
        queueLocalInput(s, s.k + s.delay);
        sendInputs(s);
      }
      runTick(s);
      s.acc = Math.max(0, s.acc - FRAME);
      ran++;
      if (s.peerEnded !== null && s.k > s.peerEnded + 180) {
        log('partner left this level; leaving too');
        ui.toast('Your partner left the level');
        forceQuitLevel();
        return;
      }
    }
    if (NET.seg === s && now - s.lastSend > 50) sendInputs(s, true);   // resend in case packets were lost
    if (ran === 0 || s.stallSince) ui.refreshHud();
  }

  function forceQuitLevel() {
    var s = NET.seg;
    if (s) endSegment('forced');
    try {
      if (game.level && game.level.sounds && game.level.sounds.levelMusic) game.level.sounds.levelMusic.stop();
      game.paused = false;
      NET.remoteApply = true;
      game.state.fade('levelMenu', true, false, game.currentTemple);
    } catch (e) { log('force quit error', e); } finally { NET.remoteApply = false; }
  }

  function endSegment(why) {
    var s = NET.seg;
    if (!s) return;
    log('segment', s.id, 'end at tick', s.k, why);
    if (NET.conn && s.phase === 'run') NET.conn.send({ t: 'end', s: s.id, k: s.k });
    NET.seg = null;
    exitDet();
    // virtual timers still pending keep running on real time
    s.timers.forEach(function (t) {
      realSetTimeout.apply(null, [t.fn, Math.max(0, t.due - s.rel)].concat(t.args));
    });
    s.timers = [];
    if (game) {
      game.time.time = realDateNow();
      game.time.prevTime = game.time.now;
      try { resetKeys(); } catch (e) { }
      if (s.controlsBefore !== null && game.settings) game.settings.controls = s.controlsBefore;
    }
    ui.refreshHud();
  }

  // ---------------------------------------------------------------------------
  // local keyboard
  // ---------------------------------------------------------------------------

  var keyState = {}, tappedKeys = {};
  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  }
  window.addEventListener('keydown', function (e) { if (!isTyping(e)) keyState[e.code] = tappedKeys[e.code] = true; }, true);
  window.addEventListener('keyup', function (e) { keyState[e.code] = false; }, true);
  window.addEventListener('blur', function () { keyState = {}; tappedKeys = {}; });

  // test bot: random walking and jumping
  var bot = {
    on: !!flag('bot'),
    bits: 0, until: 0, n: 0,
    sample: function (real) {
      this.n++;
      if (this.n >= this.until) {
        var r = realRandom();
        this.bits = (r < 0.3 ? B_LEFT : r < 0.6 ? B_RIGHT : 0) | (realRandom() < 0.35 ? B_UP : 0);
        this.until = this.n + 10 + Math.floor(realRandom() * 40);
      }
      var b = this.bits | real;
      var lv = game && game.level;
      var cycling = flag('autolevel') === 'all';
      if (lv && lv.GameOverMenu && lv.GameOverMenu.visible && this.n % 240 === 0) b |= cycling ? B_ESC : B_R;
      // when cycling through levels: pause and leave after ~30 s
      var s = NET.seg;
      var quitAt = +flag('quitat') || 1800;
      if (cycling && s && NET.isHost && s.k === quitAt) b |= B_P;
      if (cycling && s && NET.isHost && s.k === quitAt + 30) b |= B_ESC;
      return b;
    }
  };

  // test/demo: replay a planned route. --fbwg-script=file.json with
  // {"fb": [[tick, "keys"], ...], "wg": [...]}; keys letters U L R P (held until the next entry)
  // test/demo: --fbwg-record=out.webm records this game window (including the ONLINE panel) until
  // %TEMP%\fbwg_rec_stop exists or 3 minutes pass.
  (function () {
    var out = flag('record');
    if (!out || !nodeRequire) return;
    var electron = nodeRequire('electron'), fs = nodeRequire('fs'), path = nodeRequire('path');
    var stopFile = path.join(process.env.TEMP || '.', 'fbwg_rec_stop');
    try { fs.unlinkSync(stopFile); } catch (e) { }
    realSetTimeout(function () {
      electron.desktopCapturer.getSources({ types: ['screen'] }, function (err, sources) {
        if (err || !sources.length) { log('record: no screen source', err); return; }
        var scr = electron.screen.getPrimaryDisplay();
        var sw = scr.size.width * scr.scaleFactor, sh = scr.size.height * scr.scaleFactor;
        navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
          chromeMediaSource: 'desktop', chromeMediaSourceId: sources[0].id,
          minWidth: sw, maxWidth: sw, minHeight: sh, maxHeight: sh, maxFrameRate: 30 } } }).then(function (stream) {
          var video = document.createElement('video');
          video.srcObject = stream;
          video.muted = true;
          video.play();
          var win = electron.remote.getCurrentWindow();
          var b = win.getContentBounds(), sf = scr.scaleFactor;
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(b.width * sf / 2) * 2;
          canvas.height = Math.round(b.height * sf / 2) * 2;
          var ctx = canvas.getContext('2d');
          var timer = setInterval(function () {
            b = win.getContentBounds();
            ctx.drawImage(video, b.x * sf, b.y * sf, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
          }, 1000 / 30);
          var mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
          var rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8000000 });
          var chunks = [];
          rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
          rec.onstop = function () {
            clearInterval(timer);
            stream.getTracks().forEach(function (t) { t.stop(); });
            var fr = new FileReader();
            fr.onload = function () { fs.writeFileSync(out, Buffer.from(fr.result)); log('record: saved', out); };
            fr.readAsArrayBuffer(new Blob(chunks, { type: 'video/webm' }));
          };
          rec.start(1000);
          log('record: started', canvas.width + 'x' + canvas.height, mime);
          var started = performance.now();
          var poll = setInterval(function () {
            if (fs.existsSync(stopFile) || performance.now() - started > 180000) { clearInterval(poll); rec.stop(); }
          }, 200);
        }).catch(function (e) { log('record: getUserMedia failed', e && e.name, e && e.message); });
      });
    }, 1500);
  })();

  var traceOn = !!flag('trace');
  var demo = {
    on: false, steps: null,
    load: function () {
      var f = flag('script');
      if (!f || !nodeRequire) return;
      try { this.steps = JSON.parse(nodeRequire('fs').readFileSync(f, 'utf8')); this.on = true; } catch (e) { log('script error', e); }
    },
    sample: function () {
      var s = NET.seg, list = this.steps && this.steps[myRole()];
      if (!s || !list) return 0;
      var t = s.k + s.delay, keys = '';
      for (var i = 0; i < list.length && list[i][0] <= t; i++) keys = list[i][1];
      return (keys.indexOf('U') >= 0 ? B_UP : 0) | (keys.indexOf('L') >= 0 ? B_LEFT : 0) |
        (keys.indexOf('R') >= 0 ? B_RIGHT : 0) | (keys.indexOf('P') >= 0 ? B_P : 0);
    }
  };
  demo.load();

  // ---------------------------------------------------------------------------
  // game patches
  // ---------------------------------------------------------------------------

  function install() {
    game = window.Phaser.GAMES[0];
    LevelClass = requirejs('States/Level/Level');
    var P = LevelClass.prototype;
    log('installing patches');

    // main loop: lockstep while a level runs online
    var origUpdate = Phaser.Game.prototype.update;
    Phaser.Game.prototype.update = function (ts) {
      var s = NET.seg;
      if (!s || this !== game) return origUpdate.call(this, ts);
      NET.lastFrame = performance.now();
      if (s.phase === 'loading') {
        this.sound.update();
        this.updateRender(1);
        ui.refreshHud();
        return;
      }
      runDue(performance.now());
      if (this.updateRender) this.updateRender(1);
    };
    setInterval(function () {
      var s = NET.seg;
      if (s) log('diag seg', s.id, s.phase, 'k', s.k, 'remoteMax', s.remoteMax, 'state', game.state.current,
        'fading', !!game.state.fading, 'paused', game.paused, 'timers', s.timers.length, 'stall', !!s.stallSince);
    }, 5000);
    // keep simulating when the window is minimized (no animation frames then)
    setInterval(function () {
      if (NET.seg && NET.seg.phase === 'run' && performance.now() - (NET.lastFrame || 0) > 60) runDue(performance.now());
    }, 8);

    // real keyboard events never reach the game during a lockstep level
    var KB = Phaser.Keyboard.prototype;
    var origDown = KB.processKeyDown, origUp = KB.processKeyUp;
    KB.processKeyDown = function (e) { if (NET.seg && !NET.synth) return; return origDown.call(this, e); };
    KB.processKeyUp = function (e) { if (NET.seg && !NET.synth) return; return origUp.call(this, e); };

    P.init = wrap(P.init, function (orig, args) {
      if (NET.connected && game.settings) {
        NET.controlsBefore = game.settings.controls;
        game.settings.controls = 'keyboard';
      } else NET.controlsBefore = null;
      return orig.apply(this, args);
    });

    P.loadComplete = wrap(P.loadComplete, function (orig, args) {
      if (!NET.connected) return orig.apply(this, args);
      var s = newSegment(this);
      s.controlsBefore = NET.controlsBefore;
      s.rng = mulberry32(s.seed);
      NET.seg = s;
      log('segment', s.id, 'loading', s.file);
      ui.close();
      enterDet(s);
      try { game.rnd.sow([s.seed]); } catch (e) { }
      try { return orig.apply(this, args); }
      finally { if (NET.seg === s) exitDet(); }
    });

    P.startLevel = wrap(P.startLevel, function (orig, args) {
      var s = NET.seg, self = this;
      if (!s || s.level !== this || s.phase !== 'loading' || s.startFn) return orig.apply(this, args);
      s.startFn = function () { orig.apply(self, args); };
      s.localReady = true;
      NET.conn.send({ t: 'ready', s: s.id, file: s.file, now: realDateNow() });
      replayEarly();
      maybeGo();
    });

    P.shutdown = wrap(P.shutdown, function (orig, args) {
      var s = NET.seg;
      try { return orig.apply(this, args); }
      finally { if (s && s.level === this) endSegment('shutdown'); }
    });

    // anything the player clicks inside a level becomes a synced action
    ['retry', 'quit', 'togglePause', 'revive'].forEach(function (name) {
      P[name] = wrap(P[name], function (orig, args) {
        var s = NET.seg;
        if (s && s.level === this && !NET.det) { NET.pendingActions.push({ f: name }); return; }
        return orig.apply(this, args);
      });
    });

    var origFade = game.state.fade;
    game.state.fade = function (name, a, b, data) {
      var s = NET.seg;
      if (s && !NET.det && !NET.remoteApply) { NET.pendingActions.push({ f: 'fade', n: name }); return; }
      if (NET.connected && name === 'level' && !NET.det && !NET.remoteApply && !s && data && data.filename) {
        var templeId = game.currentTemple && game.currentTemple.id;
        if (!NET.isHost) {
          ui.toast('Only Player 1 (the host) can pick the level');
          return;
        }
        if (this.fading) return origFade.apply(this, arguments);
        NET.conn.send({ t: 'start', temple: templeId, file: data.filename });
      }
      // joiner going to the level map (after a level, or leaving one) sees the host's map instead
      if (NET.connected && !NET.isHost && name === 'levelMenu' && NET.hostScreen && NET.hostScreen.name === 'levelMenu') {
        data = NET.hostScreen.temple;
        NET.mirrorKey = JSON.stringify(data);
        return origFade.call(this, name, a, b, data);
      }
      return origFade.apply(this, arguments);
    };

    // level map: the host reports it to the joiner; on the joiner it is a read-only copy of the host's,
    // so the joiner's own save must not trigger popups/new screens over it
    // while a co-op save is in use the game's own save goes to the co-op file, never the solo save
    // (the progress model is created while the game boots, possibly after this runs)
    (function hookProgress() {
      var p = game.progress;
      if (!p || !p.save) { realSetTimeout(hookProgress, 200); return; }
      var origProgressSave = p.save;
      p.save = function () {
        if (coop.active) { coop.onGameSave(); return Promise.resolve(); }
        return origProgressSave.apply(this, arguments);
      };
    })();

    var LM = requirejs('States/LevelMenu/LevelMenu').prototype;
    LM.afterAddContent = wrap(LM.afterAddContent, function (orig, args) {
      if (mirrorActive()) return this.layoutContent();
      return orig.apply(this, args);
    });
    window.addEventListener('mousemove', hostPointerMove, true);
    // host: report screen changes (title screen / level map / new progress on the map)
    var lastScreenKey = null;
    setInterval(function () {
      if (!NET.connected || !NET.isHost) { lastScreenKey = null; return; }
      if (NET.seg || game.state.fading) return;
      var cur = game.state.current, st = game.state.states[cur];
      if (cur !== 'menu' && cur !== 'levelMenu') return;
      var key = cur + (cur === 'levelMenu' && st && st.templeData ? JSON.stringify(plainCopy(st.templeData)) : '');
      if (key === lastScreenKey) return;
      lastScreenKey = key;
      sendScreen();
    }, 250);

    ui.build();
    autostart();
  }

  function wrap(orig, fn) {
    return function () { return fn.call(this, orig, arguments); };
  }

  function autostart() {
    var dly = 2500;
    if (flag('hostcode')) realSetTimeout(function () { startHosting('code'); }, dly);
    else if (flag('hostip')) realSetTimeout(function () { startHosting('ip', { port: +flag('hostip') || DEFAULT_PORT }); }, dly);
    else if (flag('joincode')) realSetTimeout(function () { startJoining('code', { code: String(flag('joincode')).toUpperCase() }); }, dly);
    else if (flag('joinip')) {
      var hp = String(flag('joinip')).split(':');
      realSetTimeout(function () { startJoining('ip', { host: hp[0], port: +hp[1] || DEFAULT_PORT }); }, dly);
    }
    if (flag('online')) realSetTimeout(function () { ui.open(); }, dly);
    // test helper: once connected, the host records wins for the first N levels (exercises co-op saving)
    var fakewin = +flag('fakewin');
    if (fakewin) {
      var fw = setInterval(function () {
        if (!NET.connected || !NET.isHost || !coop.active) return;
        clearInterval(fw);
        game.progress.get('temples')[0].levels.slice(0, fakewin).forEach(function (lv) {
          game.progress.update({ data: lv, state: { time: 10, diamonds: 5, silverDiamond: 1 } });
        });
        log('fakewin recorded', fakewin, 'levels');
      }, 500);
    }
    var auto = flag('autolevel');
    if (auto) {
      // test helper: the host keeps (re)starting level N whenever both sit in menus
      var idle = 0, autoN = 0;
      setInterval(function () {
        if (!NET.isHost || !NET.connected || NET.seg || game.state.fading || game.state.current === 'level') { idle = 0; return; }
        if (++idle < 6) return;
        idle = 0;
        var temples = game.progress.get('temples');
        var levels = temples[0].levels;
        var lv = auto === 'all' ? levels[(autoN++) % levels.length] : levels[(+auto || 1) - 1];
        log('autolevel', lv.filename);
        startLevelLocal(temples[0], lv, false);
      }, 500);
    }
  }

  // ---------------------------------------------------------------------------
  // UI (DOM overlay)
  // ---------------------------------------------------------------------------

  var ui = (function () {
    var mirrorEl, ringEl, mirrorShown = false, ringId = null, savePick, saveInfo, saveRow;
    var root, btn, panel, hud, toastEl, statusEl, codeBox, codeEl, roleRow, connRows, connectedRows, joinInput, ipInput, portInput;
    var built = false;

    var css = [
      // Electron 3 = Chromium 66: no CSS inset/min()
      '#fbwg-btn{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:50;',
      'font:bold 15px Georgia,serif;letter-spacing:2px;color:#f6e3a4;',
      'background:linear-gradient(#5b4a22,#2e2410);border:2px solid #b8963e;border-radius:10px;padding:9px 16px;cursor:pointer;',
      'box-shadow:0 3px 10px rgba(0,0,0,.6);text-shadow:0 1px 2px #000}',
      '#fbwg-btn:hover{filter:brightness(1.2)}',
      '#fbwg-btn .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#777;margin-right:8px;vertical-align:1px}',
      '#fbwg-btn.on .dot{background:#5fe36a;box-shadow:0 0 6px #5fe36a}',
      '#fbwg-shade{position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center}',
      '#fbwg-panel{width:460px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:22px 24px;',
      'font:15px Georgia,serif;color:#f3e6c0;background:linear-gradient(#3b3016,#1f190b);border:2px solid #b8963e;border-radius:14px;box-shadow:0 10px 40px #000}',
      '#fbwg-panel h2{margin:0 0 4px;font-size:24px;letter-spacing:3px;color:#ffd970;text-align:center}',
      '#fbwg-panel .sub{text-align:center;color:#bfae80;font-size:13px;margin-bottom:16px}',
      '#fbwg-panel .row{display:flex;gap:8px;margin:8px 0;align-items:center;flex-wrap:wrap}',
      '#fbwg-panel button{font:bold 14px Georgia,serif;color:#2a1f08;background:linear-gradient(#ffe08a,#c9992f);border:1px solid #6b5216;border-radius:8px;padding:8px 14px;cursor:pointer}',
      '#fbwg-panel button.alt{color:#f3e6c0;background:linear-gradient(#5d4c22,#3a2f12);border-color:#9c7e33}',
      '#fbwg-panel button:hover{filter:brightness(1.12)}',
      '#fbwg-panel button.sel{outline:2px solid #fff6c8}',
      '#fbwg-panel input{font:bold 16px Consolas,monospace;letter-spacing:2px;background:#120e05;color:#ffe9a8;border:1px solid #9c7e33;border-radius:6px;padding:7px 9px;min-width:0;flex:1}',
      '#fbwg-panel .lbl{color:#bfae80;font-size:13px;width:100%;margin-top:10px}',
      '#fbwg-panel .grow{flex:1}',
      '#fbwg-panel select{font:bold 14px Georgia,serif;background:#120e05;color:#ffe9a8;border:1px solid #9c7e33;border-radius:6px;padding:7px 8px;min-width:0}',
      '#fbwg-panel .saveinfo{font-size:13px;color:#d9c48c;margin:2px 2px 0}',
      '#fbwg-code{font:bold 40px Consolas,monospace;letter-spacing:8px;color:#fff3c4;text-align:center;background:#120e05;border:1px dashed #b8963e;border-radius:10px;padding:8px 0;margin:6px 0}',
      '#fbwg-status{margin-top:14px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.35);font-size:14px;min-height:20px}',
      '#fbwg-status.ok{color:#8ff09a}#fbwg-status.err{color:#ff9a8a}#fbwg-status.wait{color:#ffe08a}',
      '#fbwg-panel details{margin-top:12px;color:#bfae80}#fbwg-panel summary{cursor:pointer}',
      '#fbwg-panel .help{font-size:12.5px;color:#bfae80;line-height:1.45;margin-top:12px}',
      '#fbwg-panel{position:relative}',
      '#fbwg-x{position:absolute;top:8px;right:8px;background:none!important;border:none!important;color:#f3e6c0!important;font-size:20px!important;padding:4px 8px!important}',
      '#fbwg-hud{position:fixed;left:10px;top:8px;z-index:40;font:bold 13px Georgia,serif;color:#f3e6c0;',
      'background:rgba(20,15,5,.6);border:1px solid rgba(184,150,62,.6);border-radius:8px;padding:4px 12px;pointer-events:none;display:none;white-space:nowrap}',
      '#fbwg-hud.warn{color:#ffe08a}#fbwg-hud.bad{color:#ff8a7a;font-size:16px;background:rgba(60,0,0,.75)}',
      // joiner's read-only copy of the host's screen
      'body.fbwg-mirror #container canvas{filter:grayscale(.85) brightness(.6) contrast(1.05)}',
      '#fbwg-mirror{position:fixed;top:0;left:0;right:0;bottom:0;z-index:45;display:none;cursor:not-allowed}',
      '#fbwg-mirror .banner{position:absolute;right:16px;bottom:84px;font:bold 17px Georgia,serif;color:#fff3c4;max-width:calc(100vw - 32px);box-sizing:border-box;',
      'background:rgba(30,22,8,.88);border:2px solid #b8963e;border-radius:12px;padding:10px 18px;text-align:right;box-shadow:0 4px 18px #000}',
      '#fbwg-mirror .banner small{display:block;font-size:13px;color:#d9c48c;font-weight:normal;margin-top:3px}',
      '#fbwg-ring{position:fixed;z-index:46;display:none;pointer-events:none;border:4px solid #ffd970;border-radius:50%;',
      'box-shadow:0 0 18px 6px rgba(255,217,112,.75),inset 0 0 14px rgba(255,217,112,.6);animation:fbwgPulse 1s ease-in-out infinite}',
      '@keyframes fbwgPulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '#fbwg-toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:70;font:bold 16px Georgia,serif;color:#fff3c4;',
      'background:rgba(30,22,8,.92);border:1px solid #b8963e;border-radius:10px;padding:10px 18px;display:none}'
    ].join('');

    function el(tag, attrs, html) {
      var e = document.createElement(tag);
      for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
      if (html) e.innerHTML = html;
      return e;
    }

    function build() {
      if (built) return;
      built = true;
      var st = el('style');
      st.textContent = css;
      document.head.appendChild(st);

      btn = el('div', { id: 'fbwg-btn' }, '<span class="dot"></span>ONLINE');
      btn.onclick = open;
      document.body.appendChild(btn);

      root = el('div', { id: 'fbwg-shade' });
      panel = el('div', { id: 'fbwg-panel' });
      panel.innerHTML =
        '<button id="fbwg-x" title="Close (Esc)">&#10005;</button>' +
        '<h2>ONLINE CO-OP</h2><div class="sub">Play the Forest Temple together over the internet</div>' +
        '<div id="fbwg-conn">' +
        '  <div class="row"><button id="fbwg-host" class="grow">Host a game</button></div>' +
        '  <div class="lbl">Join a friend - enter their code:</div>' +
        '  <div class="row"><input id="fbwg-join-code" maxlength="5" placeholder="ABCDE" spellcheck="false"><button id="fbwg-join">Join</button></div>' +
        '  <details><summary>Direct IP (needs port forwarding or a VPN)</summary>' +
        '    <div class="row"><span>Port</span><input id="fbwg-port" value="' + DEFAULT_PORT + '" style="max-width:90px"><button id="fbwg-host-ip" class="alt">Host on this port</button></div>' +
        '    <div class="row"><input id="fbwg-ip" placeholder="friend IP, e.g. 25.10.4.7" spellcheck="false"><button id="fbwg-join-ip" class="alt">Join IP</button></div>' +
        '  </details>' +
        '</div>' +
        '<div id="fbwg-codebox" style="display:none"><div id="fbwg-code"></div>' +
        '  <div class="row"><button id="fbwg-copy" class="grow alt">Copy code</button></div></div>' +
        '<div id="fbwg-saves"><div class="lbl">Co-op save (kept on both PCs):</div>' +
        '  <div class="row"><select id="fbwg-save-pick" class="grow"></select></div>' +
        '  <div id="fbwg-save-info" class="saveinfo"></div></div>' +
        '<div id="fbwg-roles"><div class="lbl">Host plays as:</div>' +
        '  <div class="row"><button id="fbwg-fb" class="grow alt">&#128293; Fireboy</button><button id="fbwg-wg" class="grow alt">&#128167; Watergirl</button></div></div>' +
        '<div id="fbwg-connected" style="display:none"><div class="row"><button id="fbwg-leave" class="alt grow">Disconnect</button></div></div>' +
        '<div id="fbwg-status"></div>' +
        '<div class="help">Each player uses <b>Arrow keys or WASD</b> for their own character. ' +
        'Player 1 (the host) picks levels from the level map; Player 2 sees the host\'s map and both games start the level together. ' +
        'P = pause, R = restart, Esc = leave (shared). Both players need this same mod installed.</div>';
      root.appendChild(panel);
      document.body.appendChild(root);

      hud = el('div', { id: 'fbwg-hud' });
      document.body.appendChild(hud);
      toastEl = el('div', { id: 'fbwg-toast' });
      document.body.appendChild(toastEl);
      mirrorEl = el('div', { id: 'fbwg-mirror' },
        '<div class="banner">Player 1 (host) is choosing the level<small>You\'re viewing the host\'s map - the level starts for you automatically</small></div>');
      mirrorEl.addEventListener('mousedown', function (e) { e.stopPropagation(); e.preventDefault(); });
      mirrorEl.addEventListener('click', function () { toast('Only Player 1 (the host) can pick the level'); });
      document.body.appendChild(mirrorEl);
      ringEl = el('div', { id: 'fbwg-ring' });
      document.body.appendChild(ringEl);

      statusEl = panel.querySelector('#fbwg-status');
      codeBox = panel.querySelector('#fbwg-codebox');
      codeEl = panel.querySelector('#fbwg-code');
      roleRow = panel.querySelector('#fbwg-roles');
      connRows = panel.querySelector('#fbwg-conn');
      connectedRows = panel.querySelector('#fbwg-connected');
      joinInput = panel.querySelector('#fbwg-join-code');
      ipInput = panel.querySelector('#fbwg-ip');
      portInput = panel.querySelector('#fbwg-port');

      var $ = function (id) { return panel.querySelector('#' + id); };
      $('fbwg-x').onclick = close;
      root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
      // keep typing in the panel away from the game
      ['keydown', 'keyup', 'keypress'].forEach(function (t) {
        root.addEventListener(t, function (e) {
          if (t === 'keydown' && e.key === 'Escape') close();
          if (t === 'keydown' && e.key === 'Enter' && e.target === joinInput) $('fbwg-join').click();
          e.stopPropagation();
        });
      });
      // Esc closes the panel even when keyboard focus is outside it (e.g. on a button that just hid)
      window.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && root.style.display === 'flex') { close(); e.stopPropagation(); }
      }, true);
      joinInput.addEventListener('input', function () {
        joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      });
      $('fbwg-host').onclick = function () { startHosting('code'); refresh(); };
      $('fbwg-join').onclick = function () {
        var c = joinInput.value.trim().toUpperCase();
        if (c.length !== 5) { setStatus('Codes are 5 letters/digits.', 'err'); return; }
        startJoining('code', { code: c });
        refresh();
      };
      $('fbwg-host-ip').onclick = function () { startHosting('ip', { port: +portInput.value || DEFAULT_PORT }); refresh(); };
      $('fbwg-join-ip').onclick = function () {
        var v = ipInput.value.trim();
        if (!v) { setStatus('Enter your friend\'s IP address.', 'err'); return; }
        var hp = v.split(':');
        startJoining('ip', { host: hp[0], port: +hp[1] || +portInput.value || DEFAULT_PORT });
        refresh();
      };
      $('fbwg-copy').onclick = function () {
        try { nodeRequire('electron').clipboard.writeText(NET.code); } catch (e) {
          try { navigator.clipboard.writeText(NET.code); } catch (e2) { }
        }
        toast('Code copied');
      };
      $('fbwg-fb').onclick = function () { setHostRole('fb'); };
      $('fbwg-wg').onclick = function () { setHostRole('wg'); };
      $('fbwg-leave').onclick = function () { disconnect(); };
      savePick = $('fbwg-save-pick');
      saveInfo = $('fbwg-save-info');
      saveRow = $('fbwg-saves');
      savePick.onchange = function () { coop.pick(savePick.value); };
      setStatus('Not connected.', '');
      refresh();
      setInterval(tickVisibility, 250);
    }

    function tickVisibility() {
      var inLevel = game && (game.state.current === 'level' || NET.seg);
      btn.style.display = inLevel ? 'none' : '';
      if (inLevel && root.style.display === 'flex') close();
      var mirror = mirrorActive();
      if (mirror !== mirrorShown) {
        mirrorShown = mirror;
        document.body.classList.toggle('fbwg-mirror', mirror);
        mirrorEl.style.display = mirror ? 'block' : 'none';
      }
      if (!mirror || game.state.current !== 'levelMenu' || game.state.fading) ringEl.style.display = 'none';
      else if (ringId !== null) showHostPointer(ringId);
      refreshHud();
    }

    // joiner: gold ring on the level the host's mouse is over
    function showHostPointer(id) {
      ringId = id;
      var r = id === null || !mirrorActive() || game.state.current !== 'levelMenu' ? null : levelButtonRect(id);
      if (!r) { ringEl.style.display = 'none'; return; }
      ringEl.style.width = ringEl.style.height = Math.round(r.size) + 'px';
      ringEl.style.left = Math.round(r.x - r.size / 2 - 4) + 'px';
      ringEl.style.top = Math.round(r.y - r.size / 2 - 4) + 'px';
      ringEl.style.display = 'block';
    }

    function open() {
      if (!built) return;
      if (game && (game.state.current === 'level' || NET.seg)) return;
      root.style.display = 'flex';
      refresh();
      realSetTimeout(function () { if (!NET.connected && !NET.code) joinInput.focus(); }, 30);
    }
    function close() {
      if (!built) return;
      root.style.display = 'none';
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }

    function setStatus(text, cls) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = cls || '';
    }

    function showCode(c) {
      codeEl.textContent = c;
      refresh();
    }

    function refresh() {
      if (!built) return;
      var busy = !!pendingHandle;
      btn.className = NET.connected ? 'on' : '';
      btn.innerHTML = '<span class="dot"></span>' + (NET.connected ? 'ONLINE: ' + roleName(myRole()).toUpperCase() : 'ONLINE');
      connRows.style.display = NET.connected || busy ? 'none' : '';
      connectedRows.style.display = NET.connected || busy ? '' : 'none';
      panel.querySelector('#fbwg-leave').textContent = NET.connected ? 'Disconnect' : 'Cancel';
      codeBox.style.display = NET.code && NET.isHost && (busy || NET.connected) ? '' : 'none';
      roleRow.style.display = (NET.isHost && (busy || NET.connected)) ? '' : 'none';
      panel.querySelector('#fbwg-fb').className = 'grow ' + (NET.hostRole === 'fb' ? 'sel' : 'alt');
      panel.querySelector('#fbwg-wg').className = 'grow ' + (NET.hostRole === 'wg' ? 'sel' : 'alt');
      refreshSaves(busy);
    }

    function describeSave(s) {
      var st = coop.stats(s);
      return st.done + (st.done === 1 ? ' level' : ' levels') + ' done - ' + st.diamonds + ' diamonds - last played ' +
        new Date(s.updated).toLocaleDateString();
    }

    // host: pick which co-op save to play (before or after the friend joins); joiner: see which one is in use
    function refreshSaves(busy) {
      var host = NET.isHost && (busy || NET.connected), joiner = !NET.isHost && NET.connected;
      saveRow.style.display = host || joiner ? '' : 'none';
      if (!host && !joiner) return;
      savePick.style.display = host ? '' : 'none';
      if (joiner) {
        saveInfo.textContent = coop.active ? coop.active.name + ': ' + describeSave(coop.active) : 'Waiting for the host\'s save...';
        return;
      }
      var saves = coop.list(), cur = coop.active ? coop.active.id : coop.choice;
      if (!cur && saves.length) cur = saves[0].id;
      var opts = saves.map(function (s) {
        return '<option value="' + s.id + '"' + (s.id === cur ? ' selected' : '') + '>' +
          s.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') +
          ' (' + coop.stats(s).done + ' levels)</option>';
      });
      opts.push('<option value="new"' + (cur === 'new' || !saves.length ? ' selected' : '') + '>+ New co-op save</option>');
      var html = opts.join('');
      if (savePick.innerHTML !== html) savePick.innerHTML = html;
      var sel = saves.filter(function (s) { return s.id === cur; })[0];
      saveInfo.textContent = sel ? describeSave(sel) + (coop.active && coop.active.id === sel.id ? ' (loaded)' : '') :
        'A fresh save starts from level 1 for both of you.';
    }

    var hudText = '';
    function refreshHud() {
      if (!built) return;
      var s = NET.seg, txt = '', cls = '';
      if (s) {
        if (s.desync) { txt = 'DESYNC - the games drifted apart. Press P then Esc to leave, then restart the level.'; cls = 'bad'; }
        else if (s.phase === 'loading') { txt = s.localReady ? 'Waiting for your partner to load...' : 'Loading...'; cls = 'warn'; }
        else if (s.stallSince && performance.now() - s.stallSince > 400) {
          txt = 'Waiting for your partner...' + (performance.now() - s.stallSince > 10000 ? ' (connection problem?)' : ''); cls = 'warn';
        } else {
          txt = 'Online - you are ' + roleName(myRole()) + (NET.rtt ? ' - ' + Math.round(NET.rtt) + ' ms' : '');
        }
      }
      var key = txt + '|' + cls;
      if (key === hudText) return;
      hudText = key;
      hud.textContent = txt;
      hud.className = cls;
      hud.style.display = txt ? 'block' : 'none';
    }

    var toastTimer = null;
    function toast(t) {
      if (!built) return;
      toastEl.textContent = t;
      toastEl.style.display = 'block';
      realClearTimeout(toastTimer);
      toastTimer = realSetTimeout(function () { toastEl.style.display = 'none'; }, 3000);
    }

    return {
      build: build, open: open, close: close, setStatus: setStatus, showCode: showCode, refresh: refresh,
      refreshHud: refreshHud, toast: toast, showHostPointer: function (id) { if (built) showHostPointer(id); }
    };
  })();

  // ---------------------------------------------------------------------------
  // boot: wait until the game's modules are defined, then patch
  // ---------------------------------------------------------------------------

  var bootTries = 0;
  (function waitForGame() {
    var ok = false;
    try {
      ok = window.requirejs && requirejs.defined('main') && requirejs.defined('States/Level/Level') &&
        window.Phaser && Phaser.GAMES && Phaser.GAMES[0] && Phaser.GAMES[0].state && Phaser.GAMES[0].state.fade;
    } catch (e) { ok = false; }
    if (ok) {
      try { install(); } catch (e) { log('install failed', e && e.stack || e); }
      return;
    }
    if (++bootTries > 1200) { log('game never finished booting; online mod inactive'); return; }
    realSetTimeout(waitForGame, 50);
  })();
})();
