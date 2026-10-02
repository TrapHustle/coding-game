'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { THEMES } = require('./questions');

// ---------- Règles communes ----------
const PORT = Number(process.env.PORT) || 3000;
const TRACK = 20;                        // 20 questions
const MAX_PLAYERS = 30;
const COUNTDOWN_MS = 3800;
const LATENCY_GRACE_MS = 600;
const DROP_GRACE_MS = 20_000;
const ROOM_TTL_MS = 10 * 60_000;
const TIME_OPTIONS = [10, 15, 20, 30];
const LIVES_OPTIONS = [1, 3, 5, 0];      // 0 = vies infinies (mode Course)
const MODES = ['course', 'combat'];
const DEFAULT_SETTINGS = { mode: 'course', theme: 'javascript', time: 20, lives: 3 };

// ---------- Mode Course ----------
const CHECKPOINTS = [5, 10, 15];
const CHECKPOINT_BONUS = [150, 100, 50];
const SPRINT_MS = 45_000;
const NEXT_DELAY_OK = 900;
const NEXT_DELAY_KO = 2400;

// ---------- Mode Combat ----------
const START_HP = 100;
const BOMB_BASE = 14;                     // dégâts de base d'une bombe
const BOMB_SPEED = 14;                    // bonus de dégâts selon la rapidité (0..14)
const ROUND_DMG_CAP = 52;                 // dégâts max encaissés en une manche
const ROUND_RESOLVE_MS = 3800;            // pause entre deux manches (animations)
const KO_POINTS = 200;
const BOMB_POINTS = 15;

// ---------- Profil ----------
const AVATARS = ['🦊', '🐱', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐧', '🦉', '🐙', '🦄', '🐲', '🦖', '🤖', '👾', '👻', '🥷', '🧙', '🚀'];
const COLORS = ['#39f5a8', '#4cc9f0', '#ff4d6d', '#ffcf5c', '#b388ff', '#ff8fab', '#ff9f43', '#9be564'];
const EMOTES = ['🔥', '😂', '😱', '👏', '😎', '💀', '🐢', '🚀'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Catégories ----------
const CATEGORIES = [
  { id: 'dev', name: 'Développement', icon: '💻', themes: ['javascript', 'python', 'java', 'csharp', 'php', 'sql', 'htmlcss'] },
  { id: 'ops', name: 'Systèmes & Cloud', icon: '☁️', themes: ['git', 'linux', 'docker', 'kubernetes', 'aws', 'azure'] },
  { id: 'aisec', name: 'IA & Cybersécurité', icon: '🛡️', themes: ['ai', 'cybersecurite', 'cryptographie', 'securiteweb', 'pentest'] },
];

for (const [id, t] of Object.entries(THEMES)) {
  if (t.questions.length < TRACK) throw new Error(`Thème "${id}" : il faut au moins ${TRACK} questions.`);
  t.questions.forEach((q, i) => {
    if (q.options.length !== 4) throw new Error(`Thème "${id}", question ${i + 1} : il faut 4 options.`);
  });
}
for (const c of CATEGORIES) for (const id of c.themes) {
  if (!THEMES[id]) throw new Error(`Catégorie "${c.id}" référence un thème inconnu : ${id}`);
}

const summary = id => ({ id, name: THEMES[id].name, icon: THEMES[id].icon, kind: THEMES[id].kind, count: THEMES[id].questions.length });
const catCount = c => c.themes.reduce((n, id) => n + THEMES[id].questions.length, 0);

function themeLabel(id) {
  if (id === 'mix') return { name: 'Mix Tech', icon: '🎲' };
  if (typeof id === 'string' && id.startsWith('cat:')) {
    const c = CATEGORIES.find(x => x.id === id.slice(4));
    return c ? { name: `Mix ${c.name}`, icon: c.icon } : { name: 'Mix', icon: '🎲' };
  }
  const t = THEMES[id] || THEMES[DEFAULT_SETTINGS.theme];
  return { name: t.name, icon: t.icon };
}

const validTheme = id =>
  id === 'mix' ||
  Object.hasOwn(THEMES, id) ||
  (typeof id === 'string' && id.startsWith('cat:') && CATEGORIES.some(c => c.id === id.slice(4)));

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/config', (req, res) => {
  res.json({
    categories: CATEGORIES.map(c => ({
      id: c.id, name: c.name, icon: c.icon,
      mix: { id: `cat:${c.id}`, name: `Mix ${c.name}`, icon: c.icon, count: catCount(c) },
      themes: c.themes.map(summary),
    })),
    globalMix: { id: 'mix', name: 'Mix Tech', icon: '🎲', count: Object.values(THEMES).reduce((n, t) => n + t.questions.length, 0) },
    modes: [
      { id: 'course', name: 'Course', icon: '🏁', tagline: 'Avance sur la piste, franchis les checkpoints.' },
      { id: 'combat', name: 'Combat', icon: '🥊', tagline: 'Bonne réponse = bombe sur l\'adversaire. Dernier debout gagne.' },
    ],
    avatars: AVATARS, colors: COLORS, emotes: EMOTES,
    timeOptions: TIME_OPTIONS, livesOptions: LIVES_OPTIONS, defaults: DEFAULT_SETTINGS,
    track: TRACK, checkpoints: CHECKPOINTS, startHp: START_HP, maxPlayers: MAX_PLAYERS, lanUrls: lanUrls(),
  });
});

const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

// ---------- Utilitaires ----------
const now = () => Date.now();
const ord = n => (n === 1 ? '1er' : `${n}e`);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
}

function validateProfile(d) {
  const name = String(d?.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  if (name.length < 2) return { error: 'Choisis un pseudo (2 caractères minimum).' };
  return {
    name,
    avatar: AVATARS.includes(d?.avatar) ? d.avatar : AVATARS[0],
    color: COLORS.includes(d?.color) ? d.color : COLORS[0],
  };
}

function validateSettings(d, base) {
  const s = { ...base };
  if (MODES.includes(d?.mode)) s.mode = d.mode;
  if (validTheme(d?.theme)) s.theme = d.theme;
  if (TIME_OPTIONS.includes(Number(d?.time))) s.time = Number(d.time);
  if (LIVES_OPTIONS.includes(Number(d?.lives))) s.lives = Number(d.lives);
  return s;
}

function buildQuestions(themeId) {
  let ids;
  if (themeId === 'mix') ids = Object.keys(THEMES);
  else if (themeId.startsWith('cat:')) ids = CATEGORIES.find(c => c.id === themeId.slice(4)).themes;
  else ids = [themeId];
  const pool = ids.flatMap(id => THEMES[id].questions.map(q => ({ ...q, tag: THEMES[id].name })));
  return shuffle([...pool]).slice(0, TRACK).map(q => {
    const order = shuffle([0, 1, 2, 3]); // l'option 0 de la banque est la bonne réponse
    return { text: q.q, code: q.code, tag: q.tag, options: order.map(i => q.options[i]), answer: order.indexOf(0) };
  });
}

// ---------- Joueurs ----------
function newPlayer(socket, profile) {
  const p = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    ...profile,
    socketId: socket.id, connected: true, left: false, joinedAt: now(),
    lastEmote: 0, qTimer: null, nextTimer: null, dropTimer: null,
  };
  resetPlayer(p, DEFAULT_SETTINGS);
  return p;
}

function resetPlayer(p, settings) {
  clearTimeout(p.qTimer);
  clearTimeout(p.nextTimer);
  Object.assign(p, {
    score: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0,
    queue: [], seen: new Set(), seq: 0, current: null,
    // Course
    pos: 0, lives: settings.lives, reachedAt: 0,
    finished: false, finishedAt: 0, eliminated: false, eliminatedAt: 0, done: false, doneAt: 0,
    // Combat
    hp: START_HP, maxHp: START_HP, ko: false, koAt: 0, koRound: 0, bombsLanded: 0, kos: 0,
  });
}

const isRacing = p => !p.finished && !p.eliminated && !p.done; // encore en course (mode Course)
const isFighting = p => !p.ko;                                // encore debout (mode Combat)
function alive(room) {
  const test = room.settings.mode === 'combat' ? isFighting : isRacing;
  return [...room.players.values()].filter(p => !p.left && test(p));
}

// Classement selon le mode
function ranked(room) {
  const list = [...room.players.values()];
  if (room.status === 'lobby') return list.sort((a, b) => a.joinedAt - b.joinedAt);

  if (room.settings.mode === 'combat') {
    const group = p => (p.ko ? 1 : 0);
    return list.sort((a, b) => {
      if (group(a) !== group(b)) return group(a) - group(b);
      if (!a.ko) return (b.hp - a.hp) || (b.score - a.score);
      return (b.koRound - a.koRound) || (b.koAt - a.koAt) || (b.score - a.score); // survécu plus longtemps = mieux
    });
  }
  const group = p => (p.finished ? 0 : p.eliminated ? 2 : 1);
  return list.sort((a, b) => {
    if (group(a) !== group(b)) return group(a) - group(b);
    if (a.finished) return a.finishedAt - b.finishedAt;
    if (a.eliminated) return (b.eliminatedAt - a.eliminatedAt) || (b.pos - a.pos);
    return (b.pos - a.pos) || (a.reachedAt - b.reachedAt) || (b.score - a.score);
  });
}

function publicState(room) {
  const t = now();
  const label = themeLabel(room.settings.theme);
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mode: room.settings.mode,
    settings: { ...room.settings, themeName: label.name, themeIcon: label.icon },
    track: TRACK,
    checkpoints: CHECKPOINTS,
    startHp: START_HP,
    countdownMs: room.status === 'countdown' ? Math.max(0, room.startAt - t) : 0,
    remainingMs: room.status === 'playing' && room.settings.mode === 'course' ? Math.max(0, room.endsAt - t) : 0,
    sprint: room.sprint,
    combat: room.settings.mode === 'combat' ? {
      round: Math.min(room.round + 1, TRACK),
      total: TRACK,
      roundMs: room.status === 'playing' ? Math.max(0, room.roundEndsAt - t) : 0,
    } : null,
    players: ranked(room).map((p, i) => ({
      rank: i + 1,
      id: p.id, name: p.name, avatar: p.avatar, color: p.color,
      connected: p.connected, left: p.left,
      voice: room.voice?.has(p.id) || false,
      score: p.score, correct: p.correct, wrong: p.wrong, streak: p.streak, bestStreak: p.bestStreak,
      answered: !!p.current?.answered,
      // Course
      pos: p.pos, lives: p.lives, finished: p.finished, eliminated: p.eliminated, done: p.done,
      finishMs: p.finished ? p.finishedAt - room.raceStart : null,
      // Combat
      hp: p.hp, maxHp: p.maxHp, ko: p.ko, kos: p.kos, bombsLanded: p.bombsLanded, koRound: p.koRound,
    })),
  };
}

const broadcast = room => io.to(room.code).emit('state', publicState(room));
const feed = (room, icon, text, kind = 'info', extra = {}) => io.to(room.code).emit('feed', { icon, text, kind, ...extra });

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected && !host.left) return;
  const next = [...room.players.values()].find(p => p.connected && !p.left);
  if (next) {
    room.hostId = next.id;
    feed(room, '👑', `${next.name} devient l'hôte du salon`);
  }
}

// ---------- Lancement ----------
function startGame(room) {
  room.questions = buildQuestions(room.settings.theme);
  room.status = 'countdown';
  room.startAt = now() + COUNTDOWN_MS;
  room.sprint = false;
  room.round = 0;
  room.startCount = [...room.players.values()].filter(p => !p.left).length;
  room.cpHits = CHECKPOINTS.map(() => []);
  for (const p of room.players.values()) {
    resetPlayer(p, room.settings);
    p.queue = room.questions.map((_, i) => i);
  }
  broadcast(room);
  room.timers.start = setTimeout(() => beginPlay(room), COUNTDOWN_MS);
}

function beginPlay(room) {
  if (room.status !== 'countdown') return;
  room.status = 'playing';
  room.raceStart = now();
  const label = themeLabel(room.settings.theme);
  if (room.settings.mode === 'combat') {
    room.endsAt = 0;
    feed(room, '🥊', `Combat lancé ! Thème : ${label.name}`, 'start');
    broadcast(room);
    combatStartRound(room);
  } else {
    room.endsAt = room.raceStart + Math.round((TRACK * room.settings.time * 1.25 + 30) * 1000);
    for (const p of room.players.values()) {
      p.reachedAt = room.raceStart;
      sendQuestion(room, p);
    }
    scheduleEnd(room);
    feed(room, '🏁', `C'est parti ! Thème : ${label.name}`, 'start');
    broadcast(room);
  }
}

function emitQuestionTo(room, p) {
  const c = p.current;
  if (!p.socketId || !c) return;
  const q = room.questions[c.qIndex];
  const combat = room.settings.mode === 'combat';
  io.to(p.socketId).emit('question', {
    combat,
    seq: c.seq,
    number: combat ? c.seq + 1 : p.pos + 1,
    total: TRACK,
    retry: combat ? false : c.retry,
    text: q.text, code: q.code, tag: q.tag, options: q.options,
    durationMs: room.settings.time * 1000,
    remainingMs: Math.max(0, c.deadline - now()),
  });
}

// ========================================================================
//  MODE COURSE
// ========================================================================
function scheduleEnd(room) {
  clearTimeout(room.timers.end);
  room.timers.end = setTimeout(() => endGame(room), Math.max(0, room.endsAt - now()));
}

function startSprint(room, reason) {
  if (room.sprint) return;
  room.sprint = true;
  const end = now() + SPRINT_MS;
  if (end < room.endsAt) {
    room.endsAt = end;
    scheduleEnd(room);
  }
  feed(room, '⏱️', `${reason} Sprint final : ${Math.round((room.endsAt - now()) / 1000)} s !`, 'sprint');
}

function sendQuestion(room, p) {
  if (room.status !== 'playing' || !isRacing(p)) return;
  const qIndex = p.queue[0];
  const duration = room.settings.time * 1000;
  p.seq += 1;
  p.current = { seq: p.seq, qIndex, sentAt: now(), deadline: now() + duration, answered: false, retry: p.seen.has(qIndex) };
  p.seen.add(qIndex);
  clearTimeout(p.qTimer);
  const seq = p.seq;
  p.qTimer = setTimeout(() => resolveAnswer(room, p, seq, null), duration + LATENCY_GRACE_MS);
  emitQuestionTo(room, p);
}

function resolveAnswer(room, p, seq, choice) {
  const c = p.current;
  if (room.status !== 'playing' || !c || c.answered || c.seq !== seq) return;
  c.answered = true;
  clearTimeout(p.qTimer);

  const t = now();
  const q = room.questions[c.qIndex];
  const timedOut = choice === null || t > c.deadline + LATENCY_GRACE_MS;
  const ok = !timedOut && choice === q.answer;
  const result = { seq, ok, timedOut, choice, answer: q.answer, gained: 0 };

  if (ok) {
    const before = ranked(room).map(x => x.id);
    p.pos += 1;
    p.correct += 1;
    p.streak += 1;
    p.bestStreak = Math.max(p.bestStreak, p.streak);
    p.reachedAt = t;
    p.queue.shift();

    const speed = Math.max(0, Math.min(1, (c.deadline - t) / (room.settings.time * 1000)));
    let gained = 100 + Math.round(100 * speed);
    if (p.streak >= 3) gained += Math.min(50, (p.streak - 2) * 10);
    p.score += gained;
    result.gained = gained;

    const cpIndex = CHECKPOINTS.indexOf(p.pos);
    if (cpIndex >= 0) {
      const hits = room.cpHits[cpIndex];
      hits.push(p.id);
      const place = hits.length;
      const bonus = CHECKPOINT_BONUS[place - 1] || 0;
      p.score += bonus;
      let lifeBack = false;
      if (room.settings.lives > 0 && p.lives < room.settings.lives) {
        p.lives += 1;
        lifeBack = true;
      }
      result.checkpoint = { n: cpIndex + 1, place, bonus, lifeBack };
      feed(room, '🚩', `${p.name} franchit le checkpoint ${cpIndex + 1} ${place === 1 ? 'en tête !' : `(${ord(place)})`}`, 'checkpoint', { by: p.id });
    }

    if (p.pos >= TRACK) {
      p.finished = true;
      p.finishedAt = t;
      p.current = null;
      const place = [...room.players.values()].filter(x => x.finished).length;
      result.finished = { place, timeMs: t - room.raceStart };
      feed(room, place === 1 ? '🏆' : '🏁', `${p.name} franchit la ligne d'arrivée ${place === 1 ? 'en VAINQUEUR !' : `(${ord(place)})`}`, 'finish', { by: p.id });
      if (place === 1 && [...room.players.values()].some(isRacing)) startSprint(room, `${p.name} a gagné la course !`);
    }

    const after = ranked(room).map(x => x.id);
    const from = before.indexOf(p.id);
    const to = after.indexOf(p.id);
    if (to < from) {
      const passed = before.slice(to, from).map(id => room.players.get(id)).filter(Boolean);
      if (passed.length) {
        const names = passed.map(x => x.name);
        const label = names.length > 3 ? `${names.slice(0, 3).join(', ')} et ${names.length - 3} autre(s)` : names.join(', ');
        feed(room, '⚡', `${p.name} dépasse ${label} !`, 'overtake', {
          by: p.id, byName: p.name, passed: passed.map(x => x.id), passedNames: names,
        });
      }
    }
  } else {
    p.wrong += 1;
    p.streak = 0;
    p.queue.shift(); // la question est consommée : elle ne revient plus
    if (room.settings.lives > 0) {
      p.lives -= 1;
      if (p.lives <= 0) {
        eliminate(room, p, timedOut ? 'time' : 'wrong');
        result.eliminated = true;
      }
    }
  }

  Object.assign(result, { pos: p.pos, lives: p.lives, score: p.score, streak: p.streak });
  if (p.socketId) io.to(p.socketId).emit('result', result);

  if (isRacing(p) && p.queue.length === 0) finishQuiz(room, p); // plus de questions : quiz terminé
  if (checkEnd(room)) return;
  broadcast(room);
  if (isRacing(p)) {
    clearTimeout(p.nextTimer);
    p.nextTimer = setTimeout(() => sendQuestion(room, p), ok ? NEXT_DELAY_OK : NEXT_DELAY_KO);
  }
}

function finishQuiz(room, p) {
  if (!isRacing(p)) return;
  p.done = true;
  p.doneAt = now();
  p.current = null;
  clearTimeout(p.qTimer);
  clearTimeout(p.nextTimer);
  feed(room, '✔️', `${p.name} a terminé le quiz (case ${p.pos}/${TRACK})`, 'info', { by: p.id });
  const racers = alive(room);
  const finishers = [...room.players.values()].some(x => x.finished);
  if (room.status === 'playing' && racers.length === 1 && room.startCount >= 2 && !finishers) {
    startSprint(room, `${racers[0].name} est le dernier en lice !`);
  }
}

function eliminate(room, p, reason) {
  if (!isRacing(p)) return;
  p.eliminated = true;
  p.eliminatedAt = now();
  p.current = null;
  clearTimeout(p.qTimer);
  clearTimeout(p.nextTimer);
  const left = alive(room);
  let text = reason === 'left' ? `${p.name} a abandonné la course` : `${p.name} est éliminé !`;
  if (left.length && room.status === 'playing') text += ` (${left.length} encore en course)`;
  feed(room, '💀', text, 'elim', { by: p.id });
  const finishers = [...room.players.values()].some(x => x.finished);
  if (room.status === 'playing' && left.length === 1 && room.startCount >= 2 && !finishers) {
    startSprint(room, `${left[0].name} est le dernier survivant !`);
  }
}

// ========================================================================
//  MODE COMBAT
// ========================================================================
function combatStartRound(room) {
  if (room.status !== 'playing') return;
  const round = room.round;
  if (round >= TRACK) return combatEnd(room);
  const fighters = alive(room);
  if (room.startCount >= 2 && fighters.length <= 1) return combatEnd(room);

  const duration = room.settings.time * 1000;
  room.roundEndsAt = now() + duration;
  for (const p of fighters) {
    p.current = { seq: round, qIndex: round, sentAt: now(), deadline: room.roundEndsAt, answered: false, choice: null, ok: false, speed: 0, at: 0 };
    emitQuestionTo(room, p);
  }
  clearTimeout(room.timers.round);
  room.timers.round = setTimeout(() => resolveCombatRound(room, round), duration + LATENCY_GRACE_MS);
  broadcast(room);
}

function combatAnswer(room, p, seq, choice) {
  const c = p.current;
  if (room.status !== 'playing' || room.settings.mode !== 'combat' || p.ko) return;
  if (!c || c.answered || c.seq !== seq) return;
  const t = now();
  if (t > c.deadline + LATENCY_GRACE_MS) return;
  const q = room.questions[c.qIndex];
  c.answered = true;
  c.at = t;
  c.choice = choice;
  c.ok = choice === q.answer;
  c.speed = Math.max(0, Math.min(1, (c.deadline - t) / (room.settings.time * 1000)));
  if (p.socketId) io.to(p.socketId).emit('answer:locked', { seq });
  if (alive(room).every(x => x.current && x.current.answered)) resolveCombatRound(room, seq);
  else broadcast(room);
}

function resolveCombatRound(room, round) {
  if (room.status !== 'playing' || room.settings.mode !== 'combat' || room.round !== round) return;
  clearTimeout(room.timers.round);
  const t = now();
  const fighters = alive(room);
  const attackers = [];
  const victims = [];
  for (const p of fighters) {
    const c = p.current || {};
    p._r = { answered: !!c.answered, ok: !!c.ok, choice: c.answered ? c.choice : null, speed: c.speed || 0 };
    (p._r.ok ? attackers : victims).push(p);
  }

  for (const a of attackers) a._bomb = BOMB_BASE + Math.round(BOMB_SPEED * a._r.speed);

  const bombs = [];
  for (const v of victims) {
    let dmg = 0;
    for (const a of attackers) {
      dmg += a._bomb;
      if (bombs.length < 24) bombs.push({ from: a.id, to: v.id });
    }
    v._r.damage = Math.min(ROUND_DMG_CAP, dmg);
  }

  // Attaquants : points, immunité, bombes placées
  for (const a of attackers) {
    a.correct += 1;
    a.streak += 1;
    a.bestStreak = Math.max(a.bestStreak, a.streak);
    let gained = 100 + Math.round(100 * a._r.speed);
    if (a.streak >= 3) gained += Math.min(50, (a.streak - 2) * 10);
    gained += BOMB_POINTS * victims.length;
    a.score += gained;
    a.bombsLanded += victims.length;
    a._r.gained = gained;
    a._r.immune = true;
  }

  // Victimes : dégâts + K.O.
  const kos = [];
  for (const v of victims) {
    v.streak = 0;
    if (v._r.answered) v.wrong += 1;
    v.hp = Math.max(0, v.hp - v._r.damage);
    if (v.hp <= 0 && !v.ko) {
      v.ko = true;
      v.koAt = t;
      v.koRound = round + 1;
      v.current = null;
      v._r.ko = true;
      kos.push(v);
    }
  }
  if (kos.length && attackers.length) {
    for (const a of attackers) {
      a.kos += kos.length;
      a.score += KO_POINTS * kos.length;
    }
  }

  // Fil d'actualité
  if (attackers.length === 0) {
    feed(room, '💨', `Personne n'a trouvé — aucune bombe cette manche !`, 'info');
  } else if (victims.length === 0) {
    feed(room, '🛡️', `Tout le monde a trouvé — personne n'encaisse !`, 'checkpoint');
  }
  for (const v of kos) feed(room, '💥', `${v.name} est K.O. ! (manche ${round + 1})`, 'elim', { by: v.id });

  const fightersAfter = alive(room);
  const last = round + 1 >= TRACK;
  const lms = room.startCount >= 2 && fightersAfter.length <= 1;
  const ending = last || lms;

  io.to(room.code).emit('round:result', {
    round: round + 1,
    total: TRACK,
    answer: room.questions[round].answer,
    clash: attackers.length > 0 && victims.length === 0,
    stalemate: attackers.length === 0,
    bombs,
    nextInMs: ending ? null : ROUND_RESOLVE_MS,
    players: fighters.map(p => ({
      id: p.id, choice: p._r.choice, ok: p._r.ok, answered: p._r.answered,
      immune: !!p._r.immune, damage: p._r.damage || 0, gained: p._r.gained || 0,
      hp: p.hp, maxHp: p.maxHp, ko: !!p._r.ko,
    })),
  });

  for (const p of fighters) delete p._r, delete p._bomb;
  room.round = round + 1;
  broadcast(room);

  if (ending) setTimeout(() => combatEnd(room), 1400);
  else room.timers.round = setTimeout(() => combatStartRound(room), ROUND_RESOLVE_MS);
}

function combatAbandon(room, p) {
  if (p.ko) return;
  p.ko = true;
  p.koAt = now();
  p.koRound = room.round;
  p.current = null;
  feed(room, '🚪', `${p.name} a abandonné le combat`, 'elim', { by: p.id });
  if (room.status !== 'playing') return;
  const fighters = alive(room);
  if (room.startCount >= 2 && fighters.length <= 1) return combatEnd(room);
  if (fighters.length && fighters.every(x => x.current && x.current.answered)) resolveCombatRound(room, room.round);
}

function combatEnd(room) {
  if (room.status !== 'playing') return;
  for (const p of alive(room)) p.score += p.hp * 2; // bonus de survie
  endGame(room);
}

// ========================================================================
//  Fin de partie (commune)
// ========================================================================
function checkEnd(room) {
  if (room.status !== 'playing' || room.settings.mode !== 'course') return false;
  if ([...room.players.values()].some(isRacing)) return false;
  endGame(room);
  return true;
}

function endGame(room) {
  if (room.status !== 'playing') return;
  room.status = 'finished';
  clearRaceTimers(room);
  for (const p of room.players.values()) p.current = null;
  const winner = ranked(room)[0];
  if (winner) feed(room, '🏆', `${winner.name} remporte la bataille !`, 'win', { by: winner.id });
  ensureHost(room);
  broadcast(room);
}

function clearRaceTimers(room) {
  clearTimeout(room.timers.start);
  clearTimeout(room.timers.end);
  clearTimeout(room.timers.round);
  for (const p of room.players.values()) {
    clearTimeout(p.qTimer);
    clearTimeout(p.nextTimer);
  }
}

function deleteRoom(room) {
  clearRaceTimers(room);
  clearTimeout(room.timers.cleanup);
  for (const p of room.players.values()) clearTimeout(p.dropTimer);
  io.to(room.code).emit('room:closed');
  io.in(room.code).socketsLeave(room.code);
  rooms.delete(room.code);
}

function scheduleCleanup(room) {
  clearTimeout(room.timers.cleanup);
  room.timers.cleanup = setTimeout(() => {
    const listeners = io.sockets.adapter.rooms.get(room.code)?.size || 0;
    if (listeners === 0 && rooms.get(room.code) === room) deleteRoom(room);
  }, ROOM_TTL_MS);
}

// ---------- Sockets ----------
function attach(socket, room, p) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = p ? p.id : null;
  if (p) {
    p.socketId = socket.id;
    p.connected = true;
    clearTimeout(p.dropTimer);
  }
}

function ctx(socket) {
  const room = rooms.get(socket.data.roomCode);
  const p = room && socket.data.playerId ? room.players.get(socket.data.playerId) : null;
  return { room, p: p && p.socketId === socket.id ? p : null };
}

function leaveRoom(socket) {
  const { room, p } = ctx(socket);
  if (room) socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (!room || !p) return;

  clearTimeout(p.dropTimer);
  if (room.voice.delete(p.id)) io.to(room.code).emit('voice:left', { id: p.id });
  if (room.status === 'lobby') {
    room.players.delete(p.id);
    feed(room, '👋', `${p.name} a quitté le salon`);
  } else {
    p.left = true;
    p.connected = false;
    p.socketId = null;
    if (room.status !== 'finished') {
      if (room.settings.mode === 'combat') combatAbandon(room, p);
      else eliminate(room, p, 'left');
    }
  }
  if (![...room.players.values()].some(x => !x.left)) return deleteRoom(room);
  ensureHost(room);
  if (!checkEnd(room)) broadcast(room);
}

const safeAck = ack => (typeof ack === 'function' ? ack : () => {});

io.on('connection', socket => {
  socket.on('room:create', (data, ack) => {
    ack = safeAck(ack);
    const profile = validateProfile(data);
    if (profile.error) return ack(profile);
    leaveRoom(socket);
    const room = {
      code: makeCode(), hostId: null, status: 'lobby',
      settings: validateSettings(data, DEFAULT_SETTINGS),
      players: new Map(), questions: [], cpHits: [], timers: {}, voice: new Set(),
      sprint: false, startAt: 0, raceStart: 0, endsAt: 0, round: 0, roundEndsAt: 0, startCount: 0,
    };
    const p = newPlayer(socket, profile);
    room.players.set(p.id, p);
    room.hostId = p.id;
    rooms.set(room.code, room);
    attach(socket, room, p);
    ack({ ok: true, code: room.code, playerId: p.id, token: p.token, state: publicState(room) });
  });

  socket.on('room:join', (data, ack) => {
    ack = safeAck(ack);
    const profile = validateProfile(data);
    if (profile.error) return ack(profile);
    const room = rooms.get(String(data?.code || '').trim().toUpperCase());
    if (!room) return ack({ error: 'Salon introuvable. Vérifie le code.' });
    if (room.status !== 'lobby') return ack({ error: 'La partie a déjà commencé. Tu peux la regarder en spectateur.' });
    if (room.players.size >= MAX_PLAYERS) return ack({ error: 'Ce salon est complet.' });
    const taken = [...room.players.values()].some(x => x.name.toLowerCase() === profile.name.toLowerCase());
    if (taken) return ack({ error: 'Ce pseudo est déjà pris dans ce salon.' });
    leaveRoom(socket);
    const p = newPlayer(socket, profile);
    room.players.set(p.id, p);
    attach(socket, room, p);
    ack({ ok: true, code: room.code, playerId: p.id, token: p.token, state: publicState(room) });
    feed(room, '👋', `${p.name} a rejoint le salon`);
    broadcast(room);
  });

  socket.on('room:watch', (data, ack) => {
    ack = safeAck(ack);
    const room = rooms.get(String(data?.code || '').trim().toUpperCase());
    if (!room) return ack({ error: 'Salon introuvable. Vérifie le code.' });
    leaveRoom(socket);
    attach(socket, room, null);
    ack({ ok: true, code: room.code, state: publicState(room) });
  });

  socket.on('room:rejoin', (data, ack) => {
    ack = safeAck(ack);
    const room = rooms.get(String(data?.code || '').toUpperCase());
    const p = room && typeof data?.token === 'string' && [...room.players.values()].find(x => x.token === data.token);
    if (!p || p.left) return ack({ error: 'Cette partie n\'existe plus.' });
    const old = p.socketId && p.socketId !== socket.id ? io.sockets.sockets.get(p.socketId) : null;
    if (old) {
      old.leave(room.code);
      old.data.roomCode = null;
      old.data.playerId = null;
      old.emit('session:replaced');
    }
    attach(socket, room, p);
    ack({ ok: true, code: room.code, playerId: p.id, token: p.token, state: publicState(room) });
    if (room.status === 'playing' && p.current && !p.current.answered) emitQuestionTo(room, p);
    broadcast(room);
  });

  socket.on('room:settings', data => {
    const { room, p } = ctx(socket);
    if (!room || !p || room.hostId !== p.id || room.status !== 'lobby') return;
    room.settings = validateSettings(data, room.settings);
    broadcast(room);
  });

  socket.on('game:start', () => {
    const { room, p } = ctx(socket);
    if (!room || !p || room.hostId !== p.id || room.status !== 'lobby') return;
    startGame(room);
  });

  socket.on('answer', data => {
    const { room, p } = ctx(socket);
    const choice = Number(data?.choice);
    if (!room || !p || !Number.isInteger(choice) || choice < 0 || choice > 3) return;
    if (room.settings.mode === 'combat') combatAnswer(room, p, Number(data?.seq), choice);
    else resolveAnswer(room, p, Number(data?.seq), choice);
  });

  socket.on('emote', data => {
    const { room, p } = ctx(socket);
    if (!room || !p || !EMOTES.includes(data?.emoji)) return;
    if (now() - p.lastEmote < 700) return;
    p.lastEmote = now();
    io.to(room.code).emit('emote', { id: p.id, emoji: data.emoji });
  });

  socket.on('room:rematch', () => {
    const { room, p } = ctx(socket);
    if (!room || !p || room.hostId !== p.id || room.status !== 'finished') return;
    for (const x of [...room.players.values()]) {
      if (x.left || !x.connected) room.players.delete(x.id);
      else resetPlayer(x, room.settings);
    }
    room.status = 'lobby';
    room.sprint = false;
    room.round = 0;
    broadcast(room);
  });

  // ----- Chat vocal (signalisation WebRTC ; l'audio circule en pair-à-pair) -----
  socket.on('voice:join', (data, ack) => {
    ack = safeAck(ack);
    const { room, p } = ctx(socket);
    if (!room || !p) return ack({ error: 'Pas dans un salon.' });
    room.voice.add(p.id);
    socket.to(room.code).emit('voice:joined', { id: p.id });
    broadcast(room);
    ack({ ok: true, peers: [...room.voice].filter(id => id !== p.id) });
  });

  socket.on('voice:leave', () => {
    const { room, p } = ctx(socket);
    if (!room || !p) return;
    if (room.voice.delete(p.id)) {
      io.to(room.code).emit('voice:left', { id: p.id });
      broadcast(room);
    }
  });

  socket.on('voice:signal', data => {
    const { room, p } = ctx(socket);
    if (!room || !p || !data) return;
    const target = room.players.get(String(data.to));
    if (target && target.socketId && room.voice.has(p.id)) {
      io.to(target.socketId).emit('voice:signal', { from: p.id, data: data.data });
    }
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      if (room.voice.delete(p.id)) io.to(room.code).emit('voice:left', { id: p.id });
      clearTimeout(p.dropTimer);
      p.dropTimer = setTimeout(() => {
        if (p.connected || rooms.get(room.code) !== room) return;
        if (room.status === 'lobby' && room.players.has(p.id)) {
          room.players.delete(p.id);
          feed(room, '👋', `${p.name} s'est déconnecté`);
        }
        ensureHost(room);
        broadcast(room);
      }, DROP_GRACE_MS);
      broadcast(room);
    }
    scheduleCleanup(room);
  });
});

server.listen(PORT, () => {
  console.log('\n  ⚔️  CODE ROYALE est lancé !\n');
  console.log(`  Sur ce PC        : http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  Sur le réseau    : ${url}`);
  console.log('\n  Partage l\'adresse réseau avec les autres joueurs (même Wi-Fi).\n');
});
