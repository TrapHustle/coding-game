(() => {
  'use strict';

  // ================= Utilitaires =================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  const fmtTime = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtNum = n => Number(n || 0).toLocaleString('fr-FR');
  const ord = n => (n === 1 ? '1er' : `${n}e`);

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* indisponible */ } },
  };
  const session = {
    get() { try { return JSON.parse(sessionStorage.getItem('cr-session')); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('cr-session', JSON.stringify(v)); } catch { /* ignore */ } },
    clear() { try { sessionStorage.removeItem('cr-session'); } catch { /* ignore */ } },
  };

  // ================= Sons (WebAudio) =================
  let audioCtx = null;
  function tone(freq, dur = 0.12, type = 'sine', vol = 0.07, delay = 0) {
    if (S.muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    } catch { /* audio indisponible */ }
  }
  const sfx = {
    ok: () => { tone(660, 0.1, 'triangle'); tone(990, 0.16, 'triangle', 0.07, 0.08); },
    bad: () => tone(150, 0.32, 'sawtooth', 0.05),
    tick: () => tone(900, 0.05, 'square', 0.025),
    count: () => tone(520, 0.14, 'square', 0.04),
    go: () => { tone(784, 0.12, 'square', 0.05); tone(1046, 0.25, 'square', 0.05, 0.1); },
    cp: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 'triangle', 0.07, i * 0.08)),
    win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.22, 'triangle', 0.07, i * 0.11)),
    pass: () => { tone(880, 0.08, 'sine'); tone(1320, 0.12, 'sine', 0.06, 0.06); },
    passed: () => { tone(330, 0.12, 'square', 0.035); tone(247, 0.18, 'square', 0.035, 0.1); },
    elim: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.2, 'sawtooth', 0.04, i * 0.13)),
    boom: () => { tone(90, 0.3, 'sawtooth', 0.06); tone(60, 0.4, 'sawtooth', 0.05, 0.05); },
  };

  // ================= État =================
  const S = {
    config: null,
    profile: store.get('cr-profile', {}),
    create: store.get('cr-create', {}),
    muted: store.get('cr-muted', false),
    validThemes: new Set(),
    screen: 'home',
    code: null, me: null, room: null,
    question: null, answered: false,
    qDeadline: 0, raceEnd: 0, roundEnd: 0, holdUntil: 0,
    hops: new Set(), lastTick: null, ready: false,
  };
  const meP = () => (S.room && S.me ? S.room.players.find(p => p.id === S.me) : null);
  const isCombat = () => S.room?.mode === 'combat';

  const socket = io();

  // ================= Écrans =================
  function show(name) {
    S.screen = name;
    document.body.dataset.screen = name;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
    window.scrollTo({ top: 0 });
  }

  function toast(text, kind = '') {
    const box = $('#toasts');
    const t = el('div', { class: `toast ${kind}` }, text);
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2600);
  }

  function splash(title, sub = '') {
    const s = $('#splash');
    $('#splash-title').textContent = title;
    $('#splash-sub').textContent = sub;
    s.hidden = false;
    s.classList.remove('show');
    void s.offsetWidth;
    s.classList.add('show');
    clearTimeout(S.splashTimer);
    S.splashTimer = setTimeout(() => { s.hidden = true; }, 1650);
  }

  function confetti() {
    const colors = S.config?.colors || ['#39f5a8', '#ffcf5c', '#4cc9f0'];
    for (let i = 0; i < 70; i++) {
      const c = el('div', {
        class: 'confetti',
        style: `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};animation-duration:${2 + Math.random() * 2}s;animation-delay:${Math.random() * 0.6}s;border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
      });
      document.body.append(c);
      setTimeout(() => c.remove(), 5000);
    }
  }

  // ================= Accueil =================
  function buildHome() {
    const cfg = S.config;
    const pick = list => list[Math.floor(Math.random() * list.length)];

    S.validThemes = new Set();
    for (const cat of cfg.categories) { cat.themes.forEach(t => S.validThemes.add(t.id)); S.validThemes.add(cat.mix.id); }
    S.validThemes.add(cfg.globalMix.id);

    S.profile = {
      name: S.profile.name || '',
      avatar: cfg.avatars.includes(S.profile.avatar) ? S.profile.avatar : pick(cfg.avatars),
      color: cfg.colors.includes(S.profile.color) ? S.profile.color : pick(cfg.colors),
    };
    S.create = {
      mode: cfg.modes.some(m => m.id === S.create.mode) ? S.create.mode : cfg.defaults.mode,
      theme: S.validThemes.has(S.create.theme) ? S.create.theme : cfg.defaults.theme,
      time: cfg.timeOptions.includes(S.create.time) ? S.create.time : cfg.defaults.time,
      lives: cfg.livesOptions.includes(S.create.lives) ? S.create.lives : cfg.defaults.lives,
    };

    $('#in-name').value = S.profile.name;
    $('#in-name').addEventListener('input', e => { S.profile.name = e.target.value; saveProfile(); });

    $('#avatar-grid').replaceChildren(...cfg.avatars.map(a =>
      el('button', { type: 'button', class: 'av-btn', 'data-v': a, title: 'Choisir cet avatar', onclick: () => { S.profile.avatar = a; saveProfile(); } }, a)));
    $('#color-row').replaceChildren(...cfg.colors.map(c =>
      el('button', { type: 'button', class: 'color-btn', 'data-v': c, title: 'Choisir cette couleur', style: `background:${c};--c:${c}`, onclick: () => { S.profile.color = c; saveProfile(); } })));

    // Mode
    $('#seg-mode').replaceChildren(...cfg.modes.map(m =>
      el('button', { type: 'button', 'data-v': m.id, onclick: () => { S.create.mode = m.id; saveCreate(); } }, `${m.icon} ${m.name}`)));

    // Sujets groupés par catégorie
    const themeBtn = (t, mixer) => el('button',
      { type: 'button', class: `theme-btn${mixer ? ' mixer' : ''}`, 'data-v': t.id, onclick: () => { S.create.theme = t.id; saveCreate(); } },
      el('span', { class: 'th-icon' }, t.icon),
      el('span', { class: 'th-name' }, mixer ? t.name : t.name),
      el('span', { class: 'th-kind' }, mixer ? `${t.count} questions` : `${t.kind} · ${t.count} q.`));
    const grid = $('#theme-grid');
    grid.replaceChildren();
    for (const cat of cfg.categories) {
      grid.append(el('div', { class: 'theme-cat' }, `${cat.icon} ${cat.name}`));
      for (const t of cat.themes) grid.append(themeBtn(t));
      grid.append(themeBtn(cat.mix, true));
    }
    grid.append(el('div', { class: 'theme-cat' }, '🎲 Tout mélanger'));
    grid.append(themeBtn(cfg.globalMix, true));

    $('#seg-time').replaceChildren(...cfg.timeOptions.map(v =>
      el('button', { type: 'button', 'data-v': v, onclick: () => { S.create.time = v; saveCreate(); } }, `${v}s`)));
    $('#seg-lives').replaceChildren(...cfg.livesOptions.map(v =>
      el('button', { type: 'button', 'data-v': v, onclick: () => { S.create.lives = v; saveCreate(); } }, v === 0 ? '∞' : String(v))));

    // Réglages du salon
    $('#set-mode').replaceChildren(...cfg.modes.map(m => el('option', { value: m.id }, `${m.icon} ${m.name}`)));
    const sel = $('#set-theme');
    sel.replaceChildren();
    for (const cat of cfg.categories) {
      const og = el('optgroup', { label: `${cat.icon} ${cat.name}` });
      for (const t of cat.themes) og.append(el('option', { value: t.id }, `${t.icon} ${t.name}`));
      og.append(el('option', { value: cat.mix.id }, `${cat.icon} Mix ${cat.name}`));
      sel.append(og);
    }
    sel.append(el('option', { value: cfg.globalMix.id }, '🎲 Mix Tech'));
    $('#set-time').replaceChildren(...cfg.timeOptions.map(v => el('option', { value: v }, `${v} secondes`)));
    $('#set-lives').replaceChildren(...cfg.livesOptions.map(v => el('option', { value: v }, v === 0 ? 'Infinies ∞' : `${v} vie${v > 1 ? 's' : ''}`)));

    $('#emotes').replaceChildren(...cfg.emotes.map(e =>
      el('button', { type: 'button', class: 'emote-btn', title: 'Envoyer une réaction', onclick: () => socket.emit('emote', { emoji: e }) }, e)));

    refreshProfileUI();
    refreshCreateUI();
  }

  function saveProfile() { store.set('cr-profile', S.profile); refreshProfileUI(); }
  function saveCreate() { store.set('cr-create', S.create); refreshCreateUI(); }

  function refreshProfileUI() {
    $$('#avatar-grid .av-btn').forEach(b => b.classList.toggle('selected', b.dataset.v === S.profile.avatar));
    $$('#color-row .color-btn').forEach(b => b.classList.toggle('selected', b.dataset.v === S.profile.color));
    const pv = $('#pv-token');
    pv.textContent = S.profile.avatar;
    pv.style.setProperty('--c', S.profile.color);
    $('#pv-name').textContent = S.profile.name.trim() || 'Ton pseudo';
  }

  function refreshCreateUI() {
    $$('#seg-mode button').forEach(b => b.classList.toggle('selected', b.dataset.v === S.create.mode));
    $$('#theme-grid .theme-btn').forEach(b => b.classList.toggle('selected', b.dataset.v === S.create.theme));
    $$('#seg-time button').forEach(b => b.classList.toggle('selected', Number(b.dataset.v) === S.create.time));
    $$('#seg-lives button').forEach(b => b.classList.toggle('selected', Number(b.dataset.v) === S.create.lives));
    const m = S.config.modes.find(x => x.id === S.create.mode);
    $('#mode-tagline').textContent = m ? `${m.icon} ${m.tagline}` : '';
    $('#lives-field').style.display = S.create.mode === 'combat' ? 'none' : '';
  }

  function switchTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    $('#home-error').textContent = '';
  }

  function homeError(msg) { $('#home-error').textContent = msg; }

  function readProfile() {
    const name = $('#in-name').value.trim();
    if (name.length < 2) { homeError('Choisis un pseudo (2 caractères minimum).'); $('#in-name').focus(); return null; }
    S.profile.name = name;
    saveProfile();
    return { name, avatar: S.profile.avatar, color: S.profile.color };
  }

  function busy(on) { ['#btn-create', '#btn-join', '#btn-watch'].forEach(s => { $(s).disabled = on; }); }

  // ================= Entrée / sortie =================
  function enterRoom(res, spectator = false) {
    if (S.code !== res.code) $('#feed').replaceChildren();
    S.code = res.code;
    S.me = spectator ? null : res.playerId;
    S.question = null;
    S.room = null;
    session.set(spectator ? { code: res.code, watch: true } : { code: res.code, token: res.token });
    history.replaceState(null, '', `?room=${res.code}`);
    applyState(res.state);
    Voice.updateUI();
    if (Voice.joined && S.me) Voice.resync();
    else if (!spectator && S.me) Voice.join(true); // vocal dès l'entrée dans la salle
  }

  function resetLocal() {
    session.clear();
    if (Voice.joined) Voice.stop();
    Object.assign(S, { code: null, me: null, room: null, question: null, answered: false, holdUntil: 0 });
    history.replaceState(null, '', location.pathname);
    $('#countdown').hidden = true;
    clearInterval(S.cdTimer);
    show('home');
  }

  function leave() { socket.emit('room:leave'); resetLocal(); }

  function tryResume() {
    const sess = session.get();
    if (!sess?.code) return;
    if (sess.watch) {
      socket.emit('room:watch', { code: sess.code }, res => {
        if (res?.error) { resetLocal(); toast(res.error, 'bad'); return; }
        enterRoom(res, true);
      });
      return;
    }
    socket.emit('room:rejoin', sess, res => {
      if (res?.error) { const wasIn = !!S.code; resetLocal(); if (wasIn) toast(res.error, 'bad'); return; }
      enterRoom(res);
    });
  }

  // ================= Synchronisation =================
  function applyState(st) {
    const prev = S.room;
    if (prev && st.mode === 'course') {
      for (const p of st.players) {
        const before = prev.players.find(x => x.id === p.id);
        if (before && p.pos > before.pos) S.hops.add(p.id);
      }
    }
    S.room = st;
    if (st.status === 'playing' && st.mode === 'course') S.raceEnd = Date.now() + st.remainingMs;
    if (st.combat) S.roundEnd = Date.now() + st.combat.roundMs;
    Voice.updateUI();

    if (st.status === 'lobby') {
      if (S.screen !== 'lobby') show('lobby');
      $('#countdown').hidden = true;
      renderLobby();
    } else if (st.status === 'countdown' || st.status === 'playing') {
      const entering = S.screen !== 'game';
      if (entering) show('game');
      $('#screen-game').dataset.gmode = st.mode;
      if ((entering || prev?.mode !== st.mode) && st.mode === 'course') Track.build(true);
      if (st.status === 'countdown' && prev?.status !== 'countdown') {
        S.question = null;
        $('#feed').replaceChildren();
        startCountdown(st.countdownMs);
      }
      renderGame();
    } else if (st.status === 'finished') {
      const first = S.screen !== 'results';
      if (first) show('results');
      renderResults();
      if (first) {
        const me = meP();
        if (me && me.rank === 1) { confetti(); sfx.win(); }
      }
    }
  }

  // ================= Salon =================
  function shareLink(code) {
    let base = location.origin;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (local && S.config?.lanUrls?.length) base = S.config.lanUrls[0];
    return `${base}/?room=${code}`;
  }

  function renderLobby() {
    const st = S.room;
    const isHost = !!S.me && st.hostId === S.me;
    const combat = st.settings.mode === 'combat';
    $('#lobby-code').textContent = st.code;
    $('#share-link').value = shareLink(st.code);
    $('#player-count').textContent = `${st.players.length}/${S.config.maxPlayers}`;

    $('#lobby-players').replaceChildren(...st.players.map(p => {
      const tags = [p.id === st.hostId ? '👑 Hôte' : null, p.id === S.me ? 'toi' : null, !p.connected ? 'hors-ligne' : null].filter(Boolean).join(' · ');
      return el('div', { class: `lp${p.id === S.me ? ' me' : ''}${p.connected ? '' : ' off'}`, 'data-id': p.id, style: `--c:${p.color}` },
        el('div', { class: 'lp-av' }, p.avatar),
        el('div', { class: 'lp-name' }, p.name),
        el('div', { class: 'lp-tags' }, tags));
    }));

    $('#lobby-hint').textContent = S.me
      ? (st.players.length < 2
        ? 'Partage le code ou le lien : c\'est plus fun à plusieurs ! (L\'hôte peut aussi lancer seul pour s\'entraîner.)'
        : `${st.players.length} joueurs prêts à s'affronter.`)
      : '👀 Tu regardes ce salon en spectateur.';

    for (const [sel, key] of [['#set-mode', 'mode'], ['#set-theme', 'theme'], ['#set-time', 'time'], ['#set-lives', 'lives']]) {
      const select = $(sel);
      if (document.activeElement !== select) select.value = String(st.settings[key]);
      select.disabled = !isHost;
    }
    $('#rules-course').hidden = combat;
    $('#rules-combat').hidden = !combat;
    $('#set-lives-field').style.display = combat ? 'none' : '';
    $('#btn-start').hidden = !isHost;
    $('#wait-host').hidden = isHost;
    $('#btn-leave-lobby').textContent = S.me ? 'Quitter le salon' : 'Arrêter de regarder';
    Voice.updateUI();
    Voice.applyIndicators();
  }

  function sendSettings() {
    socket.emit('room:settings', {
      mode: $('#set-mode').value,
      theme: $('#set-theme').value,
      time: Number($('#set-time').value),
      lives: Number($('#set-lives').value),
    });
  }

  // ================= Piste (mode Course) =================
  const Track = {
    W: 1000, H: 470, compact: null, nodes: [], total: 0, nodeEls: [],
    build(force = false) {
      const box = $('#track');
      const width = box.clientWidth || box.parentElement.clientWidth || window.innerWidth;
      const compact = width < 640;
      if (!force && compact === this.compact) return false;
      this.compact = compact;
      const W = this.W;
      const H = this.H = compact ? 760 : 470;
      const k = compact ? 1.9 : 1;
      box.classList.toggle('compact', compact);
      box.style.aspectRatio = `${W} / ${H}`;
      box.style.maxWidth = `calc(64vh * ${(W / H).toFixed(3)})`;

      const top = H * 0.12, bottom = H * 0.88;
      const gap = (bottom - top) / 3, r = gap / 2;
      const xL = r + 64, xR = W - r - 64, S_ = xR - xL;
      const ys = [bottom, bottom - gap, bottom - 2 * gap, top];
      const segs = [];
      for (let row = 0; row < 4; row++) {
        const right = row % 2 === 0;
        segs.push({ type: 'line', x1: right ? xL : xR, x2: right ? xR : xL, y: ys[row], len: S_ });
        if (row < 3) segs.push({ type: 'arc', cx: right ? xR : xL, cy: ys[row] - r, r, right, len: Math.PI * r });
      }
      const total = this.total = segs.reduce((a, s) => a + s.len, 0);
      const pointAt = len => {
        for (const s of segs) {
          if (len <= s.len + 1e-6) {
            const t = len / s.len;
            if (s.type === 'line') return { x: s.x1 + (s.x2 - s.x1) * t, y: s.y };
            const a = s.right ? Math.PI / 2 - Math.PI * t : Math.PI / 2 + Math.PI * t;
            return { x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a) };
          }
          len -= s.len;
        }
        const last = segs[segs.length - 1];
        return { x: last.x2, y: last.y };
      };

      let d = `M ${xL} ${ys[0]}`;
      for (const s of segs) d += s.type === 'line' ? ` L ${s.x2} ${s.y}` : ` A ${s.r} ${s.r} 0 0 ${s.right ? 0 : 1} ${s.cx} ${s.cy - s.r}`;

      const halfTurn = Math.PI * r / 2;
      const bounds = [0, S_ + halfTurn, 2 * S_ + 3 * halfTurn, 3 * S_ + 5 * halfTurn, total];
      const n = S.config.track, per = n / 4;
      this.nodes = [];
      for (let i = 0; i <= n; i++) {
        const seg = Math.min(3, Math.floor(i / per));
        const f = (i - seg * per) / per;
        const len = bounds[seg] + f * (bounds[seg + 1] - bounds[seg]);
        const p = pointAt(len);
        this.nodes.push({ x: (p.x / W) * 100, y: (p.y / H) * 100, sx: p.x, sy: p.y, len });
      }

      const svg = $('#track-svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.replaceChildren();
      const defs = svgEl('defs');
      const filter = svgEl('filter', { id: 'glow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
      filter.append(svgEl('feGaussianBlur', { stdDeviation: 5 * k, result: 'b' }));
      const merge = svgEl('feMerge');
      merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
      filter.append(merge);
      defs.append(filter);
      svg.append(defs);
      svg.append(
        svgEl('path', { d, class: 'road-edge', 'stroke-width': 50 * k }),
        svgEl('path', { d, class: 'road', 'stroke-width': 40 * k }),
        svgEl('path', { d, class: 'road-dash', 'stroke-width': 2 * k, 'stroke-dasharray': `${10 * k} ${14 * k}` }),
        svgEl('path', { d, id: 'road-progress', class: 'road-progress', 'stroke-width': 9 * k, pathLength: total, 'stroke-dasharray': `${total} ${total}`, 'stroke-dashoffset': total }),
      );

      const cps = S.config.checkpoints;
      this.nodeEls = [];
      this.nodes.forEach((node, i) => {
        const g = svgEl('g');
        if (i === 0) {
          g.append(svgEl('circle', { cx: node.sx, cy: node.sy, r: 20 * k, class: 'start-ring' }),
            svgEl('text', { x: node.sx, y: node.sy + 42 * k, class: 'track-label', 'font-size': 13 * k }, 'DÉPART'));
        } else if (i === n) {
          g.append(svgEl('circle', { cx: node.sx, cy: node.sy, r: 27 * k, class: 'finish-ring' }),
            svgEl('text', { x: node.sx, y: node.sy, class: 'mark-emoji', 'font-size': 26 * k }, '🏁'),
            svgEl('text', { x: node.sx, y: node.sy - 44 * k, class: 'track-label', 'font-size': 13 * k }, 'ARRIVÉE'));
        } else if (cps.includes(i)) {
          const cpN = cps.indexOf(i) + 1;
          const turn = segs[cpN * 2 - 1];
          const ring = svgEl('circle', { cx: node.sx, cy: node.sy, r: 24 * k, class: 'cp-ring' });
          g.append(ring, svgEl('text', { x: node.sx, y: node.sy, class: 'mark-emoji', 'font-size': 22 * k }, '🚩'),
            svgEl('text', { x: turn.cx + (turn.right ? -14 : 14) * k, y: turn.cy, class: 'cp-label', 'font-size': 15 * k, 'text-anchor': turn.right ? 'end' : 'start' }, `CP${cpN}`));
          this.nodeEls[i] = ring;
        } else {
          const c = svgEl('circle', { cx: node.sx, cy: node.sy, r: 11 * k, class: 'node' });
          g.append(c, svgEl('text', { x: node.sx, y: node.sy, class: 'node-num', 'font-size': 11 * k }, String(i)));
          this.nodeEls[i] = c;
        }
        svg.append(g);
      });

      $('#tokens').replaceChildren();
      this.setProgress(meP()?.pos || 0);
      return true;
    },
    setProgress(pos) {
      const path = $('#road-progress');
      if (!path || !this.nodes.length) return;
      const node = this.nodes[Math.min(pos, this.nodes.length - 1)];
      path.setAttribute('stroke-dashoffset', this.total - node.len);
      this.nodeEls.forEach((c, i) => c && c.classList.toggle('passed', i <= pos && i > 0));
    },
  };

  function renderTokens() {
    const st = S.room;
    if (!st || !Track.nodes.length) return;
    const layer = $('#tokens');
    const groups = new Map();
    for (const p of st.players) {
      if (p.left) continue;
      const pos = Math.min(p.pos, st.track);
      if (!groups.has(pos)) groups.set(pos, []);
      groups.get(pos).push(p);
    }
    const keep = new Set();
    for (const [pos, list] of groups) {
      const node = Track.nodes[pos];
      const n = list.length;
      const spread = n > 1 ? Math.min(36, 14 + n * 4) * (Track.compact ? 0.7 : 1) : 0;
      list.forEach((p, i) => {
        keep.add(p.id);
        let t = layer.querySelector(`[data-id="${p.id}"]`);
        if (!t) {
          t = el('div', { class: 'token', 'data-id': p.id }, el('div', { class: 'tk-av' }), el('div', { class: 'tk-name' }));
          t.style.left = `${node.x}%`;
          t.style.top = `${node.y}%`;
          layer.append(t);
        }
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
        t.style.setProperty('--c', p.color);
        t.style.setProperty('--dx', `${(Math.cos(angle) * spread).toFixed(1)}px`);
        t.style.setProperty('--dy', `${(Math.sin(angle) * spread).toFixed(1)}px`);
        t.style.left = `${node.x}%`;
        t.style.top = `${node.y}%`;
        t.style.zIndex = p.id === S.me ? 80 : 60 - Math.min(p.rank, 59);
        t.title = `${p.name} — case ${p.pos}/${st.track}`;
        t.querySelector('.tk-av').textContent = p.avatar;
        t.querySelector('.tk-name').textContent = p.name;
        t.classList.toggle('me', p.id === S.me);
        t.classList.toggle('elim', p.eliminated);
        t.classList.toggle('off', !p.connected);
        t.classList.toggle('leader', p.rank === 1 && p.pos > 0);
        if (S.hops.has(p.id)) { t.classList.remove('hop'); void t.offsetWidth; t.classList.add('hop'); }
      });
    }
    for (const t of [...layer.children]) if (!keep.has(t.dataset.id)) t.remove();
  }

  function renderMini() {
    const st = S.room;
    const box = $('#minirace');
    let inner = $('.mr-inner', box);
    if (!inner) {
      inner = el('div', { class: 'mr-inner' });
      for (const cp of st.checkpoints) inner.append(el('span', { class: 'mr-tick', style: `left:${(cp / st.track) * 100}%` }, '🚩'));
      inner.append(el('span', { class: 'mr-tick', style: 'left:100%' }, '🏁'));
      box.append(inner);
    }
    const counts = new Map();
    const keep = new Set();
    for (const p of st.players) {
      if (p.left) continue;
      keep.add(p.id);
      const k = counts.get(p.pos) || 0;
      counts.set(p.pos, k + 1);
      let t = inner.querySelector(`[data-id="${p.id}"]`);
      if (!t) { t = el('div', { class: 'mr-tok', 'data-id': p.id }); inner.append(t); }
      t.textContent = p.avatar;
      t.style.setProperty('--c', p.color);
      t.style.setProperty('--dy', `${(k % 3) * 7 - 7}px`);
      t.style.left = `${(Math.min(p.pos, st.track) / st.track) * 100}%`;
      t.classList.toggle('me', p.id === S.me);
      t.classList.toggle('elim', p.eliminated);
    }
    for (const t of $$('.mr-tok', inner)) if (!keep.has(t.dataset.id)) t.remove();
  }

  // ================= Arène (mode Combat) =================
  const Arena = {
    render() {
      const st = S.room;
      const ring = $('#ring');
      const keep = new Set();
      for (const p of st.players) {
        if (p.left) continue;
        keep.add(p.id);
        let card = ring.querySelector(`[data-id="${p.id}"]`);
        if (!card) {
          card = el('div', { class: 'fighter', 'data-id': p.id },
            el('div', { class: 'f-rank' }),
            el('div', { class: 'f-crown' }, '👑'),
            el('div', { class: 'f-avatar' }, el('span', { class: 'f-shield' }, '🛡️'), el('span', { class: 'f-face' })),
            el('div', { class: 'f-name' }),
            el('div', { class: 'f-hpbar' }, el('i')),
            el('div', { class: 'f-hp' }),
            el('div', { class: 'f-tag' }));
          ring.append(card);
        }
        card.style.setProperty('--c', p.color);
        card.style.order = p.rank;
        card.classList.toggle('me', p.id === S.me);
        card.classList.toggle('ko', p.ko);
        card.classList.toggle('leader', p.rank === 1 && !p.ko);
        card.classList.toggle('answered', p.answered && !p.ko);
        card.querySelector('.f-rank').textContent = `#${p.rank}`;
        card.querySelector('.f-crown').style.display = (p.rank === 1 && !p.ko) ? '' : 'none';
        card.querySelector('.f-face').textContent = p.avatar;
        card.querySelector('.f-name').textContent = p.name + (p.id === S.me ? ' (toi)' : '');
        const ratio = p.maxHp ? Math.max(0, p.hp / p.maxHp) : 0;
        const fill = card.querySelector('.f-hpbar i');
        fill.style.width = `${ratio * 100}%`;
        fill.className = ratio > 0.5 ? 'hp-ok' : ratio > 0.2 ? 'hp-low' : 'hp-crit';
        card.querySelector('.f-hp').innerHTML = p.ko ? '💥 K.O.' : `${p.hp}<small>/${p.maxHp} PV</small>`;
        card.querySelector('.f-tag').textContent = p.ko ? `éliminé manche ${p.koRound}` : (!p.connected ? 'hors-ligne' : (p.answered ? '✓ a répondu' : '…réfléchit'));
      }
      for (const c of [...ring.children]) if (!keep.has(c.dataset.id)) c.remove();
    },

    resolve(res) {
      const arena = $('#arena');
      const ring = $('#ring');
      const fx = $('#arena-fx');
      if (!arena || !ring) return;
      const base = arena.getBoundingClientRect();
      const center = id => {
        const c = ring.querySelector(`[data-id="${id}"]`);
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2 - base.left, y: r.top + r.height / 2 - base.top };
      };
      for (const pr of res.players) {
        if (!pr.immune) continue;
        const card = ring.querySelector(`[data-id="${pr.id}"]`);
        if (card) { card.classList.remove('immune'); void card.offsetWidth; card.classList.add('immune'); setTimeout(() => card.classList.remove('immune'), 1500); }
      }
      const bombs = (res.bombs || []).slice(0, 16);
      bombs.forEach((b, i) => {
        const from = center(b.from), to = center(b.to);
        if (!from || !to) return;
        const delay = i * 45;
        const bomb = el('div', { class: 'bomb' }, '💣');
        bomb.style.left = `${from.x}px`;
        bomb.style.top = `${from.y}px`;
        fx.append(bomb);
        setTimeout(() => {
          bomb.style.transition = 'left .5s cubic-bezier(.5,0,.6,1), top .5s cubic-bezier(.4,0,.75,1)';
          bomb.style.left = `${to.x}px`;
          bomb.style.top = `${to.y}px`;
        }, delay + 20);
        setTimeout(() => {
          bomb.remove();
          const boom = el('div', { class: 'boom' }, '💥');
          boom.style.left = `${to.x}px`;
          boom.style.top = `${to.y}px`;
          fx.append(boom);
          setTimeout(() => boom.remove(), 600);
        }, delay + 520);
      });
      setTimeout(() => {
        for (const pr of res.players) {
          if (!(pr.damage > 0)) continue;
          const card = ring.querySelector(`[data-id="${pr.id}"]`);
          if (!card) continue;
          card.classList.remove('hit');
          void card.offsetWidth;
          card.classList.add('hit');
          const d = el('div', { class: 'f-dmg' }, `-${pr.damage}`);
          card.append(d);
          setTimeout(() => d.remove(), 1300);
        }
        if (bombs.length && !S.muted) sfx.boom();
      }, bombs.length ? 540 : 0);
    },
  };

  // ================= Chat vocal (WebRTC) =================
  const Voice = {
    joined: false, muted: false, local: null,
    pcs: new Map(), audios: new Map(), meters: new Map(), speaking: new Set(),
    ac: null, loop: null,
    cfg: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] },

    async join(auto = false) {
      if (this.joined || this._connecting) return;
      if (!window.isSecureContext) {
        if (!auto) toast('🎙️ Le vocal exige une connexion HTTPS. Utilise le lien https (le tunnel), pas l\'adresse http://192.168…', 'bad');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) { if (!auto) toast('Micro non supporté par ce navigateur.', 'bad'); return; }
      this._connecting = true;
      $('#voice').classList.add('connecting');
      try {
        this.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      } catch {
        this._connecting = false;
        $('#voice').classList.remove('connecting');
        if (!auto) toast('Micro refusé ou indisponible. Autorise le micro dans le navigateur.', 'bad');
        return;
      }
      this.joined = true;
      this.muted = false;
      this.local.getAudioTracks().forEach(t => { t.enabled = true; });
      this.addMeter(S.me, this.local);
      this.startLoop();
      this.announce();
      this._connecting = false;
      $('#voice').classList.remove('connecting');
      this.updateUI();
      toast('🎧 Tu es dans le vocal', 'good');
    },

    announce() {
      socket.emit('voice:join', {}, res => {
        if (res?.error) { this.stop(); return; }
        for (const id of (res.peers || [])) this.connect(id, true);
      });
    },

    resync() { // après une reconnexion réseau
      if (!this.joined || !this.local) return;
      for (const pc of this.pcs.values()) try { pc.close(); } catch { /* ignore */ }
      this.pcs.clear();
      this.announce();
    },

    connect(id, initiator) {
      if (this.pcs.has(id)) return this.pcs.get(id);
      const pc = new RTCPeerConnection(this.cfg);
      this.pcs.set(id, pc);
      for (const tr of this.local.getTracks()) pc.addTrack(tr, this.local);
      pc.onicecandidate = e => { if (e.candidate) socket.emit('voice:signal', { to: id, data: { candidate: e.candidate } }); };
      pc.ontrack = e => this.addAudio(id, e.streams[0]);
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') try { pc.restartIce(); } catch { /* ignore */ } };
      if (initiator) {
        pc.onnegotiationneeded = async () => {
          try {
            await pc.setLocalDescription(await pc.createOffer());
            socket.emit('voice:signal', { to: id, data: { sdp: pc.localDescription } });
          } catch { /* ignore */ }
        };
      }
      return pc;
    },

    async onSignal({ from, data }) {
      if (!this.joined || !this.local || !data) return;
      const pc = this.pcs.get(from) || this.connect(from, false);
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(data.candidate).catch(() => {});
        }
      } catch { /* négociation : on ignore les erreurs transitoires */ }
    },

    addAudio(id, stream) {
      let a = this.audios.get(id);
      if (!a) { a = new Audio(); a.autoplay = true; a.playsInline = true; document.body.append(a); this.audios.set(id, a); }
      a.srcObject = stream;
      a.play?.().catch(() => {});
      this.addMeter(id, stream);
    },

    drop(id) {
      const pc = this.pcs.get(id);
      if (pc) { try { pc.close(); } catch { /* ignore */ } this.pcs.delete(id); }
      const a = this.audios.get(id);
      if (a) { a.srcObject = null; a.remove(); this.audios.delete(id); }
      this.meters.delete(id);
      this.speaking.delete(id);
      this.applyIndicators();
    },

    toggleMic() {
      if (!this.joined) return;
      this.muted = !this.muted;
      this.local.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
      if (this.muted) this.speaking.delete(S.me);
      this.updateUI();
      this.applyIndicators();
    },

    stop() {
      socket.emit('voice:leave');
      for (const pc of this.pcs.values()) try { pc.close(); } catch { /* ignore */ }
      this.pcs.clear();
      for (const a of this.audios.values()) { a.srcObject = null; a.remove(); }
      this.audios.clear();
      this.meters.clear();
      this.speaking.clear();
      if (this.local) { this.local.getTracks().forEach(t => t.stop()); this.local = null; }
      if (this.loop) { clearInterval(this.loop); this.loop = null; }
      this.joined = false;
      this.muted = false;
      this.updateUI();
      this.applyIndicators();
    },

    addMeter(id, stream) {
      try {
        this.ac = this.ac || new (window.AudioContext || window.webkitAudioContext)();
        if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
        const src = this.ac.createMediaStreamSource(stream);
        const an = this.ac.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        this.meters.set(id, { an, data: new Uint8Array(an.frequencyBinCount) });
      } catch { /* analyse indisponible */ }
    },

    startLoop() {
      if (this.loop) return;
      this.loop = setInterval(() => {
        let changed = false;
        for (const [id, m] of this.meters) {
          if (id === S.me && this.muted) { if (this.speaking.delete(id)) changed = true; continue; }
          m.an.getByteFrequencyData(m.data);
          let sum = 0;
          for (let i = 0; i < m.data.length; i++) sum += m.data[i];
          const level = sum / m.data.length;
          const talking = level > 14;
          if (talking && !this.speaking.has(id)) { this.speaking.add(id); changed = true; }
          else if (!talking && this.speaking.has(id)) { this.speaking.delete(id); changed = true; }
        }
        if (changed) this.applyIndicators();
      }, 140);
    },

    applyIndicators() {
      const voiceIds = new Set((S.room?.players || []).filter(p => p.voice).map(p => p.id));
      $$('#lobby-players .lp, #leaderboard .lb-row, #ring .fighter, #tokens .token, #res-body tr').forEach(elm => {
        const id = elm.dataset.id;
        elm.classList.toggle('in-voice', voiceIds.has(id));
        elm.classList.toggle('speaking', this.speaking.has(id));
      });
    },

    count() { return (S.room?.players || []).filter(p => p.voice).length; },

    updateUI() {
      const box = $('#voice');
      box.hidden = !(S.code && S.me); // pas de vocal pour les spectateurs
      $('#voice-count').textContent = `🎧 ${this.count()}`;
      const join = $('#voice-join');
      join.classList.toggle('active', this.joined);
      join.textContent = this.joined ? '📴' : '🎧';
      join.title = this.joined ? 'Quitter le chat vocal' : 'Rejoindre le chat vocal';
      const mic = $('#voice-mic');
      mic.hidden = !this.joined;
      mic.classList.toggle('off', this.muted);
      mic.textContent = this.muted ? '🔇' : '🎙️';
      mic.title = this.muted ? 'Micro coupé — cliquer pour parler' : 'Micro ouvert — cliquer pour couper';
    },
  };

  // ================= Rendu de partie =================
  function livesText(p, max) {
    if (max === 0) return '∞';
    return '❤️'.repeat(Math.max(0, p.lives)) + '🖤'.repeat(Math.max(0, max - p.lives));
  }

  function renderGame() {
    renderHud();
    if (isCombat()) {
      Arena.render();
    } else {
      renderTokens();
      renderMini();
      const me = meP();
      if (me) Track.setProgress(me.pos);
    }
    renderLeaderboard();
    renderQuestionArea();
    Voice.applyIndicators();
    S.hops.clear();
  }

  function renderHud() {
    const st = S.room;
    const me = meP();
    const combat = st.mode === 'combat';
    $('#hud-theme').textContent = `${st.settings.themeIcon} ${st.settings.themeName}`;
    $('#hud-round').hidden = !combat;
    if (combat && st.combat) $('#hud-round').textContent = `🥊 Manche ${st.combat.round}/${st.combat.total}`;
    $('#hud-me').hidden = !me;
    $('#hud-spec').hidden = !!me;
    $('#emotes').hidden = !me;
    if (me) {
      $('#hud-rank').textContent = `#${me.rank}/${st.players.length}`;
      if (combat) {
        $('#hud-l2').textContent = 'PV';
        $('#hud-s2').textContent = me.hp;
        $('#hud-l3').textContent = 'K.O. infligés';
        $('#hud-s3').textContent = me.kos;
      } else {
        $('#hud-l2').textContent = 'Case';
        $('#hud-s2').textContent = `${me.pos}/${st.track}`;
        $('#hud-l3').textContent = 'Vies';
        $('#hud-s3').textContent = livesText(me, st.settings.lives);
      }
      $('#hud-score').textContent = fmtNum(me.score);
    }
    $('#hud-sprint').hidden = !st.sprint;
  }

  function renderLeaderboard() {
    const st = S.room;
    const combat = st.mode === 'combat';
    const ol = $('#leaderboard');
    const before = new Map($$('.lb-row', ol).map(li => [li.dataset.id, li.getBoundingClientRect().top]));
    const rows = st.players.map(p => {
      const li = ol.querySelector(`[data-id="${p.id}"]`) || el('li', { 'data-id': p.id });
      const me = p.id === S.me;
      const out = combat ? p.ko : p.eliminated;
      li.className = `lb-row${me ? ' me' : ''}${out ? ' elim' : ''}`;
      li.style.setProperty('--c', p.color);
      let status, barPct, sub;
      if (combat) {
        status = p.ko ? '💥 K.O.' : `${p.hp} PV`;
        barPct = (p.maxHp ? p.hp / p.maxHp : 0) * 100;
        sub = `${p.kos} K.O. · ${fmtNum(p.score)} pts`;
      } else {
        if (p.finished) status = `🏁 ${fmtTime(p.finishMs)}`;
        else if (p.eliminated) status = '💀 éliminé';
        else if (p.done) status = '✔️ terminé';
        else status = livesText(p, st.settings.lives);
        barPct = (p.pos / st.track) * 100;
        sub = `${p.pos}/${st.track} · ${fmtNum(p.score)} pts`;
      }
      li.replaceChildren(
        el('span', { class: 'lb-rank' }, String(p.rank)),
        el('span', { class: 'lb-av' }, p.avatar),
        el('div', { class: 'lb-main' },
          el('div', { class: 'lb-name' }, p.name, me ? el('small', {}, 'toi') : null, !p.connected && !p.left ? el('small', { class: 'off' }, 'hors-ligne') : null),
          el('div', { class: 'lb-bar' }, el('i', { style: `width:${barPct}%` }))),
        el('div', { class: 'lb-side' },
          el('div', { class: 'lb-status' }, status),
          el('div', { class: 'lb-score' }, sub)),
      );
      return li;
    });
    ol.replaceChildren(...rows);
    for (const li of rows) {
      const top = before.get(li.dataset.id);
      if (top == null) continue;
      const dy = top - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  function renderQuestionArea() {
    const st = S.room;
    const me = meP();
    const combat = st.mode === 'combat';
    const card = $('#question-card');
    const holding = Date.now() < S.holdUntil;
    const out = me ? (combat ? me.ko : (me.finished || me.eliminated || me.done)) : true;
    let mode;
    if (!me) mode = 'done';
    else if (out) mode = holding ? 'question' : 'done';
    else if (st.status === 'countdown' || !S.question) mode = 'waiting';
    else mode = 'question';
    card.dataset.mode = mode;

    if (mode === 'done') {
      if (!me) {
        $('#done-emoji').textContent = '👀';
        $('#done-title').textContent = 'Mode spectateur';
        $('#done-text').textContent = combat ? 'Tu suis le combat en direct : PV, bombes et K.O.' : 'Tu suis la bataille en direct sur la piste et dans le classement.';
      } else if (combat && me.ko) {
        $('#done-emoji').textContent = '💥';
        $('#done-title').textContent = 'K.O. !';
        $('#done-text').textContent = `Tu as tenu jusqu'à la manche ${me.koRound}. Regarde qui remporte le combat (et balance des réactions !).`;
      } else if (me.finished) {
        $('#done-emoji').textContent = me.rank === 1 ? '🏆' : '🏁';
        $('#done-title').textContent = `Arrivée ! ${ord(me.rank)} place`;
        $('#done-text').textContent = `Temps : ${fmtTime(me.finishMs)} · ${me.correct} bonnes réponses · ${me.wrong} erreur(s).`;
      } else if (me.done) {
        $('#done-emoji').textContent = '✔️';
        $('#done-title').textContent = 'Quiz terminé !';
        $('#done-text').textContent = `Tu as répondu aux 20 questions et t'arrêtes à la case ${me.pos}/${st.track} (${me.correct} bonnes réponses). La partie continue pour les autres.`;
      } else {
        $('#done-emoji').textContent = '💀';
        $('#done-title').textContent = 'Éliminé !';
        $('#done-text').textContent = `Tu t'es arrêté à la case ${me.pos}/${st.track}. Reste pour voir qui gagne.`;
      }
    }
    if (holding) {
      clearTimeout(S.holdTimer);
      S.holdTimer = setTimeout(renderQuestionArea, S.holdUntil - Date.now() + 30);
    }
  }

  function renderQuestion(q) {
    $('#q-number').textContent = q.combat ? `Manche ${q.round} / ${q.total}` : `Question ${q.number} / ${q.total}`;
    $('#q-tag').textContent = q.tag;
    $('#q-retry').hidden = !q.retry;
    $('#q-text').textContent = q.text;
    $('#q-code').hidden = !q.code;
    $('#q-code code').textContent = q.code || '';
    $('#q-options').replaceChildren(...q.options.map((o, i) =>
      el('button', { type: 'button', class: 'opt', 'data-i': i, onclick: () => answer(i) },
        el('span', { class: 'opt-key' }, 'ABCD'[i]),
        el('span', { class: 'opt-text' }, o))));
    const fb = $('#q-feedback');
    fb.textContent = '';
    fb.className = 'feedback';

    const bar = $('#q-bar');
    bar.classList.remove('low');
    bar.style.transition = 'none';
    bar.style.width = `${(q.remainingMs / q.durationMs) * 100}%`;
    void bar.offsetWidth;
    bar.style.transition = `width ${q.remainingMs}ms linear`;
    bar.style.width = '0%';

    const live = $('.q-live');
    live.classList.remove('enter', 'locked');
    void live.offsetWidth;
    live.classList.add('enter');
    renderQuestionArea();
  }

  function freezeBar() {
    const bar = $('#q-bar');
    const w = getComputedStyle(bar).width;
    bar.style.transition = 'none';
    bar.style.width = w;
  }

  function answer(i) {
    const q = S.question;
    if (!q || S.answered || S.room?.status !== 'playing' || $('#question-card').dataset.mode !== 'question') return;
    S.answered = true;
    $$('#q-options .opt').forEach(b => { b.disabled = true; if (Number(b.dataset.i) === i) b.classList.add('picked'); });
    socket.emit('answer', { seq: q.seq, choice: i });
    if (isCombat()) {
      $('.q-live').classList.add('locked');
      const fb = $('#q-feedback');
      fb.className = 'feedback';
      fb.textContent = '🔒 Réponse verrouillée — en attente des autres…';
    }
  }

  // Résultat d'une question (mode Course)
  function showResult(r) {
    S.answered = true;
    freezeBar();
    $$('#q-options .opt').forEach(b => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      b.classList.remove('picked');
      if (i === r.answer) b.classList.add('correct');
      else if (i === r.choice) b.classList.add('wrong');
    });
    const fb = $('#q-feedback');
    const maxLives = S.room?.settings.lives ?? 0;
    let text;
    if (r.ok) {
      fb.className = 'feedback ok';
      text = `✅ Bonne réponse ! +${r.gained} pts`;
      if (r.streak >= 3) text += ` · 🔥 série x${r.streak}`;
      sfx.ok();
      if (r.checkpoint) {
        const cp = r.checkpoint;
        const parts = [`${ord(cp.place)} au checkpoint`];
        if (cp.bonus) parts.push(`+${cp.bonus} pts`);
        if (cp.lifeBack) parts.push('+1 ❤️');
        text += ` · 🚩 ${parts.join(' · ')}`;
        splash(`🚩 CHECKPOINT ${cp.n}`, parts.join(' · '));
        sfx.cp();
      }
      if (r.finished) {
        S.holdUntil = Date.now() + 1800;
        splash(r.finished.place === 1 ? '🏆 VICTOIRE !' : '🏁 ARRIVÉE !', `${ord(r.finished.place)} · ${fmtTime(r.finished.timeMs)}`);
        sfx.win();
        if (r.finished.place === 1) confetti();
      }
    } else {
      fb.className = 'feedback ko';
      text = r.timedOut ? '⏱️ Temps écoulé !' : '❌ Mauvaise réponse !';
      if (maxLives) text += ' −1 ❤️';
      if (r.eliminated) {
        text += ' Plus de vies… éliminé !';
        S.holdUntil = Date.now() + 2200;
        splash('💀 ÉLIMINÉ', 'Tu restes en spectateur');
        sfx.elim();
      } else { text += ' Elle reviendra plus tard.'; sfx.bad(); }
    }
    fb.textContent = text;
  }

  // Résolution d'une manche (mode Combat)
  function showCombatResult(res) {
    S.answered = true;
    freezeBar();
    $('.q-live').classList.remove('locked');
    const me = S.me ? res.players.find(p => p.id === S.me) : null;
    const opts = $$('#q-options .opt');
    opts.forEach(b => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      b.classList.remove('picked');
      if (i === res.answer) b.classList.add('correct');
      else if (me && i === me.choice) b.classList.add('wrong');
    });
    const fb = $('#q-feedback');
    if (me) {
      if (me.ok) {
        fb.className = 'feedback ok';
        fb.textContent = `🛡️ Trouvé ! Immunisé · 💣 bombe lancée · +${me.gained} pts`;
        sfx.ok();
      } else if (me.ko) {
        fb.className = 'feedback ko';
        fb.textContent = `💥 Tu encaisses −${me.damage} PV… K.O. !`;
        S.holdUntil = Date.now() + 2200;
        splash('💥 K.O. !', 'Tu passes spectateur');
        sfx.elim();
      } else if (me.damage > 0) {
        fb.className = 'feedback ko';
        fb.textContent = `💣 Raté — tu encaisses −${me.damage} PV. Accroche-toi !`;
        sfx.bad();
      } else {
        fb.className = 'feedback ko';
        fb.textContent = res.stalemate ? '😮 Personne n\'a trouvé : aucune bombe ce tour.' : '😮 Raté, mais personne ne t\'a touché.';
        sfx.bad();
      }
    } else if (res.clash) {
      fb.className = 'feedback ok';
      fb.textContent = '🛡️ Tout le monde a trouvé — personne n\'encaisse !';
    }
    Arena.resolve(res);
    renderQuestionArea();
  }

  // ================= Compte à rebours =================
  function startCountdown(ms) {
    const end = Date.now() + ms;
    const overlay = $('#countdown');
    const num = $('#count-num');
    overlay.hidden = false;
    let last = null;
    clearInterval(S.cdTimer);
    S.cdTimer = setInterval(() => {
      const left = end - Date.now();
      const label = left > 0 ? String(Math.min(3, Math.ceil(left / 1000))) : 'GO !';
      if (label !== last) {
        last = label;
        num.textContent = label;
        num.classList.remove('pop');
        void num.offsetWidth;
        num.classList.add('pop');
        if (label === 'GO !') sfx.go(); else sfx.count();
      }
      if (left < -650) { clearInterval(S.cdTimer); overlay.hidden = true; }
    }, 50);
  }

  // ================= Résultats =================
  function renderResults() {
    const st = S.room;
    const me = meP();
    const combat = st.mode === 'combat';
    if (!me) $('#res-title').textContent = '🏆 Fin de la bataille';
    else if (me.rank === 1) $('#res-title').textContent = combat ? '🏆 DERNIER DEBOUT !' : '🏆 VICTOIRE ROYALE !';
    else $('#res-title').textContent = `Tu termines ${ord(me.rank)} sur ${st.players.length}`;
    const winner = st.players[0];
    $('#res-sub').textContent = winner ? `${winner.avatar} ${winner.name} remporte ${combat ? 'le combat' : 'la course'} « ${st.settings.themeName} »` : '';

    const resultText = p => {
      if (combat) return p.ko ? `💥 K.O. (manche ${p.koRound})` : `🛡️ Survivant · ${p.hp} PV`;
      if (p.finished) return `🏁 ${fmtTime(p.finishMs)}`;
      if (p.eliminated) return p.left ? '🚪 abandon' : '💀 éliminé';
      if (p.done) return `✔️ quiz terminé`;
      return '⏱️ temps écoulé';
    };

    const top = st.players.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    $('#podium').replaceChildren(...order.map((p, i) => {
      const place = [2, 1, 3][i];
      if (!p) return el('div');
      const info = combat ? `${p.ko ? 'K.O.' : p.hp + ' PV'} · ${fmtNum(p.score)} pts` : `${resultText(p)} · ${fmtNum(p.score)} pts`;
      return el('div', { class: `pod p${place}`, style: `--c:${p.color}` },
        el('div', { class: 'pod-av' }, p.avatar),
        el('div', { class: 'pod-name' }, p.name),
        el('div', { class: 'pod-info' }, info),
        el('div', { class: 'pod-block' }, String(place)));
    }));

    const heads = combat
      ? ['#', 'Joueur', 'Résultat', 'PV', 'K.O.', '✅', '❌', 'Points']
      : ['#', 'Joueur', 'Résultat', 'Case', '✅', '❌', 'Série', 'Points'];
    $('#res-head').replaceChildren(...heads.map(h => el('th', {}, h)));

    $('#res-body').replaceChildren(...st.players.map(p => {
      const cells = combat
        ? [String(p.rank), null, resultText(p), p.ko ? '0' : String(p.hp), String(p.kos), String(p.correct), String(p.wrong), fmtNum(p.score)]
        : [String(p.rank), null, resultText(p), `${p.pos}/${st.track}`, String(p.correct), String(p.wrong), `x${p.bestStreak}`, fmtNum(p.score)];
      return el('tr', { class: p.id === S.me ? 'me' : '', 'data-id': p.id },
        ...cells.map((c, idx) => idx === 1
          ? el('td', {}, el('div', { class: 'res-player', style: `--c:${p.color}` }, el('span', { class: 'mini-av' }, p.avatar), p.name))
          : el('td', { class: idx === 0 || idx > 2 ? 'num' : '' }, c)));
    }));

    const isHost = !!S.me && st.hostId === S.me;
    $('#btn-rematch').hidden = !isHost;
    $('#res-wait').hidden = isHost;
    Voice.applyIndicators();
  }

  // ================= Événements serveur =================
  socket.on('connect', () => { $('#conn').classList.add('on'); if (S.ready) tryResume(); });
  socket.on('disconnect', () => { $('#conn').classList.remove('on'); if (S.code) toast('Connexion perdue… reconnexion en cours', 'bad'); });

  socket.on('state', st => { if (S.code && st.code === S.code) applyState(st); });

  socket.on('question', q => {
    S.question = q;
    S.answered = false;
    S.lastTick = null;
    S.qDeadline = Date.now() + q.remainingMs;
    renderQuestion(q);
  });

  socket.on('result', r => { if (S.question && r.seq === S.question.seq) showResult(r); });
  socket.on('answer:locked', () => { /* déjà affiché localement */ });
  socket.on('round:result', res => showCombatResult(res));

  socket.on('feed', f => {
    const ul = $('#feed');
    ul.prepend(el('li', { class: `feed-item k-${f.kind}` }, el('span', {}, f.icon), el('span', {}, f.text)));
    while (ul.children.length > 40) ul.lastChild.remove();
    if (S.screen !== 'game') return;
    if (f.kind === 'overtake') {
      if (f.by === S.me) { toast(`⚡ Tu dépasses ${f.passedNames.join(', ')} !`, 'good'); sfx.pass(); }
      else if (S.me && f.passed.includes(S.me)) { toast(`😤 ${f.byName} t'a dépassé !`, 'bad'); sfx.passed(); }
    } else if (['checkpoint', 'finish', 'elim', 'sprint'].includes(f.kind) && f.by !== S.me) {
      toast(`${f.icon} ${f.text}`, f.kind === 'checkpoint' ? 'checkpoint' : f.kind);
    }
  });

  socket.on('emote', ({ id, emoji }) => {
    const host = isCombat() ? $(`#ring [data-id="${id}"] .f-avatar`) : $(`#tokens [data-id="${id}"]`);
    if (!host) return;
    const b = el('span', { class: 'bubble' }, emoji);
    host.append(b);
    setTimeout(() => b.remove(), 1850);
  });

  socket.on('room:closed', () => { resetLocal(); toast('Le salon a été fermé.', 'bad'); });
  socket.on('session:replaced', () => { resetLocal(); toast('Ta partie a été ouverte dans un autre onglet.', 'bad'); });

  socket.on('voice:signal', msg => Voice.onSignal(msg));
  socket.on('voice:left', ({ id }) => Voice.drop(id));
  socket.on('voice:joined', () => { /* le nouveau venu nous enverra une offre */ });

  // ================= Actions utilisateur =================
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#btn-create').addEventListener('click', () => {
    const profile = readProfile();
    if (!profile) return;
    busy(true);
    socket.emit('room:create', { ...profile, ...S.create }, res => {
      busy(false);
      if (res?.error) return homeError(res.error);
      enterRoom(res);
    });
  });

  function joinRoom() {
    const profile = readProfile();
    if (!profile) return;
    const code = $('#in-code').value.trim().toUpperCase();
    if (code.length < 5) { homeError('Entre le code à 5 caractères du salon.'); $('#in-code').focus(); return; }
    busy(true);
    socket.emit('room:join', { ...profile, code }, res => {
      busy(false);
      if (res?.error) return homeError(res.error);
      enterRoom(res);
    });
  }
  $('#btn-join').addEventListener('click', joinRoom);
  $('#in-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  $('#btn-watch').addEventListener('click', () => {
    const code = $('#in-code').value.trim().toUpperCase();
    if (code.length < 5) { homeError('Entre le code du salon à regarder.'); $('#in-code').focus(); return; }
    busy(true);
    socket.emit('room:watch', { code }, res => {
      busy(false);
      if (res?.error) return homeError(res.error);
      enterRoom(res, true);
    });
  });

  ['#set-mode', '#set-theme', '#set-time', '#set-lives'].forEach(s => $(s).addEventListener('change', sendSettings));
  $('#btn-start').addEventListener('click', () => socket.emit('game:start'));
  $('#btn-rematch').addEventListener('click', () => socket.emit('room:rematch'));
  $('#btn-leave-lobby').addEventListener('click', leave);
  $('#btn-quit').addEventListener('click', leave);
  $('#btn-leave-game').addEventListener('click', () => { if (!S.me || confirm('Quitter la partie ? Tu seras éliminé.')) leave(); });

  $('#btn-copy').addEventListener('click', async () => {
    const input = $('#share-link');
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand('copy'); }
    toast('Lien copié ! Envoie-le aux autres joueurs.', 'good');
  });

  $('#btn-mute').addEventListener('click', () => {
    S.muted = !S.muted;
    store.set('cr-muted', S.muted);
    $('#btn-mute').textContent = S.muted ? '🔇' : '🔊';
  });

  $('#voice-join').addEventListener('click', () => { if (Voice.joined) Voice.stop(); else Voice.join(); });
  $('#voice-mic').addEventListener('click', () => Voice.toggleMic());

  document.addEventListener('keydown', e => {
    if (S.screen !== 'game' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, select, textarea')) return;
    const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
    const i = map[e.key.toLowerCase()];
    if (i != null) answer(i);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.screen === 'game' && !isCombat() && Track.build()) renderGame(); }, 150);
  });

  // Horloge
  setInterval(() => {
    const st = S.room;
    if (!st || S.screen !== 'game') return;
    const timer = $('#hud-timer');
    if (st.status === 'playing') {
      timer.textContent = isCombat() ? fmtTime(S.roundEnd - Date.now()) : fmtTime(S.raceEnd - Date.now());
    } else timer.textContent = '--:--';
    timer.classList.toggle('sprint', !!st.sprint);
    if (S.question && !S.answered && $('#question-card').dataset.mode === 'question') {
      const secs = Math.max(0, Math.ceil((S.qDeadline - Date.now()) / 1000));
      $('#q-secs').textContent = secs;
      const low = secs <= 5;
      $('#q-secs').classList.toggle('low', low);
      $('#q-bar').classList.toggle('low', low);
      if (secs <= 3 && secs > 0 && secs !== S.lastTick) { S.lastTick = secs; sfx.tick(); }
    }
  }, 200);

  // ================= Démarrage =================
  async function init() {
    $('#btn-mute').textContent = S.muted ? '🔇' : '🔊';
    try {
      const res = await fetch('/api/config');
      S.config = await res.json();
    } catch {
      homeError('Impossible de contacter le serveur. Est-il lancé ?');
      return;
    }
    buildHome();
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && !session.get()) {
      switchTab('join');
      $('#in-code').value = roomParam.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    }
    S.ready = true;
    if (socket.connected) tryResume();
  }

  init();
})();
