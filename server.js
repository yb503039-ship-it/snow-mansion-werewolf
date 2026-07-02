'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.set('trust proxy', 1);

function getPublicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

app.get('/qr/:code.svg', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) return res.status(400).send('Invalid room code');
    const room = rooms.get(code);
    if (!room) return res.status(404).send('Room not found');
    const url = `${getPublicBaseUrl(req)}/?room=${encodeURIComponent(code)}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 260 });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  } catch (error) {
    console.error(error);
    res.status(500).send('QR generation failed');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();

const ROLES = {
  villager: {
    id: 'villager',
    name: '市民',
    team: 'village',
    countAs: 'citizen',
    result: '人狼でない',
    description: '特別な能力はありません。昼の話し合いと投票で人狼を見つけます。',
    action: 'none',
  },
  werewolf: {
    id: 'werewolf',
    name: '人狼',
    team: 'werewolf',
    countAs: 'wolf',
    result: '人狼である',
    description: '毎夜、生存者を1人襲撃します。仲間の人狼を知ることができます。',
    action: 'attack',
  },
  seer: {
    id: 'seer',
    name: '占い師',
    team: 'village',
    countAs: 'citizen',
    result: '人狼でない',
    description: '毎夜、生存者を1人占い、その人が人狼かどうかを知ることができます。',
    action: 'divine',
  },
  guard: {
    id: 'guard',
    name: '狩人',
    team: 'village',
    countAs: 'citizen',
    result: '人狼でない',
    description: '毎夜、自分以外の生存者を1人護衛し、人狼の襲撃から守ります。',
    action: 'guard',
  },
  medium: {
    id: 'medium',
    name: '霊能者',
    team: 'village',
    countAs: 'citizen',
    result: '人狼でない',
    description: '処刑された人が人狼だったかどうかを翌日に知ることができます。',
    action: 'medium',
  },
  madman: {
    id: 'madman',
    name: '狂人',
    team: 'werewolf',
    countAs: 'citizen',
    result: '人狼でない',
    description: '人狼陣営ですが、占い結果は「人狼でない」です。嘘を使って市民を混乱させます。',
    action: 'none',
  },
};

const DEFAULT_SETTINGS = {
  daySeconds: 240,
  nightSeconds: 90,
  voteSeconds: 60,
  showVotes: 'after', // hide | show | after
  runoff: true,
  randomTie: true,
  allowSkip: 1,
  missedVote: 'invalid', // invalid | skip
  allowSelfVote: false,
  skipWhenAllVoted: true,
  firstNightAttack: true,
  consecutiveGuard: true,
};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function makeId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizePassword(value) {
  return String(value || '').trim().slice(0, 60);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}

function passwordMatches(room, password) {
  if (!room.passwordHash) return true;
  const normalized = normalizePassword(password);
  if (!normalized) return false;
  return hashPassword(normalized) === room.passwordHash;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function majorityChoice(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  if (counts.size === 0) return null;
  const max = Math.max(...counts.values());
  const candidates = [...counts.entries()].filter(([, count]) => count === max).map(([id]) => id);
  return pickRandom(candidates);
}

function autoRoleCounts(playerCount) {
  const counts = { villager: 0, werewolf: 0, seer: 0, guard: 0, medium: 0, madman: 0 };
  if (playerCount < 4) return counts;
  counts.werewolf = playerCount >= 16 ? 4 : playerCount >= 11 ? 3 : playerCount >= 7 ? 2 : 1;
  counts.seer = 1;
  counts.guard = playerCount >= 5 ? 1 : 0;
  counts.medium = playerCount >= 7 ? 1 : 0;
  counts.madman = playerCount >= 6 ? 1 : 0;
  const used = counts.werewolf + counts.seer + counts.guard + counts.medium + counts.madman;
  counts.villager = Math.max(0, playerCount - used);
  return counts;
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    daySeconds: clampNumber(settings.daySeconds, 60, 360, DEFAULT_SETTINGS.daySeconds),
    nightSeconds: clampNumber(settings.nightSeconds, 30, 120, DEFAULT_SETTINGS.nightSeconds),
    voteSeconds: clampNumber(settings.voteSeconds, 30, 120, DEFAULT_SETTINGS.voteSeconds),
    showVotes: ['hide', 'show', 'after'].includes(settings.showVotes) ? settings.showVotes : DEFAULT_SETTINGS.showVotes,
    runoff: Boolean(settings.runoff ?? DEFAULT_SETTINGS.runoff),
    randomTie: Boolean(settings.randomTie ?? DEFAULT_SETTINGS.randomTie),
    allowSkip: clampNumber(settings.allowSkip, 0, 2, DEFAULT_SETTINGS.allowSkip),
    missedVote: ['invalid', 'skip'].includes(settings.missedVote) ? settings.missedVote : DEFAULT_SETTINGS.missedVote,
    allowSelfVote: Boolean(settings.allowSelfVote ?? DEFAULT_SETTINGS.allowSelfVote),
    skipWhenAllVoted: Boolean(settings.skipWhenAllVoted ?? DEFAULT_SETTINGS.skipWhenAllVoted),
    firstNightAttack: Boolean(settings.firstNightAttack ?? DEFAULT_SETTINGS.firstNightAttack),
    consecutiveGuard: Boolean(settings.consecutiveGuard ?? DEFAULT_SETTINGS.consecutiveGuard),
  };
}

function publicPlayer(player, includeRole = false) {
  return {
    id: player.id,
    name: player.name,
    alive: player.alive,
    connected: player.connected,
    ready: player.ready,
    role: includeRole ? player.role : undefined,
    roleName: includeRole && player.role ? ROLES[player.role].name : undefined,
  };
}

function publicLog(room) {
  return room.log.filter((entry) => entry.public).slice(-80);
}

function hostLog(room) {
  return room.log.slice(-160);
}

function addLog(room, text, publicEntry = true, type = 'info') {
  room.log.push({ text, public: publicEntry, type, at: Date.now(), day: room.day, phase: room.phase });
  if (room.log.length > 400) room.log.shift();
}

function getRoomBySocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  return rooms.get(code) || null;
}

function isHost(socket, room) {
  return Boolean(room && socket.id === room.hostSocketId);
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function livingWolves(room) {
  return room.players.filter((p) => p.alive && p.role === 'werewolf');
}

function livingByRole(room, role) {
  return room.players.filter((p) => p.alive && p.role === role);
}

function countVictory(room) {
  const alive = alivePlayers(room);
  const wolves = alive.filter((p) => p.role === 'werewolf').length;
  const citizens = alive.length - wolves;
  if (wolves <= 0) return { winner: 'village', text: '市民陣営の勝利です。すべての人狼が死亡しました。' };
  if (wolves >= citizens) return { winner: 'werewolf', text: '人狼陣営の勝利です。市民の数が人狼の数以下になりました。' };
  return null;
}

function buildStateForSocket(room, socket) {
  const playerId = socket.data.playerId;
  const me = findPlayer(room, playerId);
  const host = isHost(socket, room);
  const includeRoles = host && room.status !== 'lobby';
  const role = me?.role ? ROLES[me.role] : null;
  const wolves = me?.role === 'werewolf' || host
    ? room.players.filter((p) => p.role === 'werewolf').map((p) => ({ id: p.id, name: p.name, alive: p.alive }))
    : [];
  const players = room.players.map((p) => publicPlayer(p, includeRoles));
  const messages = room.messages.filter((m) => {
    if (m.channel === 'public') return true;
    if (m.channel === 'wolf') return host || me?.role === 'werewolf';
    if (m.channel === 'grave') return host || me?.alive === false;
    return false;
  }).slice(-100);

  return {
    room: {
      code: room.code,
      title: room.title,
      status: room.status,
      phase: room.phase,
      day: room.day,
      gmMode: room.gmMode,
      settings: room.settings,
      phaseStartedAt: room.phaseStartedAt,
      phaseEndsAt: room.phaseEndsAt,
      skipUsed: room.skipUsed,
      roleCounts: room.roleCounts,
      voteCandidates: room.voteCandidates,
      winner: room.winner,
      winText: room.winText,
      passwordRequired: Boolean(room.passwordHash),
    },
    me: me ? {
      id: me.id,
      name: me.name,
      alive: me.alive,
      role: me.role,
      roleName: role?.name,
      team: role?.team,
      description: role?.description,
      privateLogs: me.privateLogs.slice(-30),
      connected: me.connected,
    } : null,
    isHost: host,
    players,
    wolves,
    messages,
    publicLog: publicLog(room),
    hostLog: host ? hostLog(room) : [],
    roles: host ? ROLES : null,
  };
}

function emitRoom(room) {
  for (const socketId of room.sockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.emit('state', buildStateForSocket(room, socket));
  }
}

function clearPhaseTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function setPhaseTimer(room, seconds, callback) {
  clearPhaseTimer(room);
  if (room.gmMode || seconds <= 0) return;
  room.timer = setTimeout(() => {
    try {
      callback();
    } catch (error) {
      console.error(error);
    }
  }, seconds * 1000);
}

function enterPhase(room, phase, options = {}) {
  clearPhaseTimer(room);
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  room.phaseEndsAt = null;
  room.voteCandidates = options.voteCandidates || null;

  if (phase === 'night') {
    room.status = 'playing';
    room.nightActions = {};
    room.phaseEndsAt = room.gmMode ? null : Date.now() + room.settings.nightSeconds * 1000;
    addLog(room, `【${room.day}日目 夜】夜になりました。能力者は行動してください。`, true, 'phase');
    setPhaseTimer(room, room.settings.nightSeconds, () => resolveNight(room.code));
  }

  if (phase === 'day') {
    room.status = 'playing';
    room.phaseEndsAt = room.gmMode ? null : Date.now() + room.settings.daySeconds * 1000;
    addLog(room, `【${room.day}日目 昼】話し合いを開始してください。`, true, 'phase');
    setPhaseTimer(room, room.settings.daySeconds, () => enterPhase(room, 'vote'));
  }

  if (phase === 'vote') {
    room.status = 'playing';
    room.votes = {};
    room.runoffDone = Boolean(options.runoffDone);
    room.phaseEndsAt = room.gmMode ? null : Date.now() + room.settings.voteSeconds * 1000;
    addLog(room, options.runoffDone ? '【決選投票】最多得票者の中から投票してください。' : '【投票】処刑したい相手に投票してください。', true, 'phase');
    setPhaseTimer(room, room.settings.voteSeconds, () => resolveVote(room.code));
  }

  if (phase === 'end') {
    room.status = 'ended';
    room.phaseEndsAt = null;
    clearPhaseTimer(room);
  }
  emitRoom(room);
}

function assignRoles(room) {
  const players = shuffle(room.players);
  const counts = room.roleCounts || autoRoleCounts(players.length);
  let deck = [];
  for (const [role, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) deck.push(role);
  }
  if (deck.length !== players.length) {
    const diff = players.length - deck.length;
    for (let i = 0; i < diff; i += 1) deck.push('villager');
    if (deck.length > players.length) deck = deck.slice(0, players.length);
  }
  deck = shuffle(deck);
  players.forEach((player, index) => {
    player.role = deck[index] || 'villager';
    player.alive = true;
    player.privateLogs = [];
    player.ready = false;
  });
  room.executedLast = null;
  room.lastGuardTarget = null;
}

function requiredNightActors(room) {
  const actors = [];
  if (room.settings.firstNightAttack || room.day > 1) {
    if (livingWolves(room).length > 0) actors.push({ type: 'wolf', ids: livingWolves(room).map((p) => p.id) });
  }
  for (const seer of livingByRole(room, 'seer')) actors.push({ type: 'seer', ids: [seer.id] });
  for (const guard of livingByRole(room, 'guard')) actors.push({ type: 'guard', ids: [guard.id] });
  return actors;
}

function hasSubmittedNight(room, player) {
  if (!player.alive) return true;
  if (player.role === 'werewolf') {
    if (!room.settings.firstNightAttack && room.day === 1) return true;
    return Boolean(room.nightActions[`wolf:${player.id}`]);
  }
  if (player.role === 'seer') return Boolean(room.nightActions[`seer:${player.id}`]);
  if (player.role === 'guard') return Boolean(room.nightActions[`guard:${player.id}`]);
  return true;
}

function allRequiredNightActionsSubmitted(room) {
  return room.players.filter((p) => p.alive).every((p) => hasSubmittedNight(room, p));
}

function submitPrivate(player, text, type = 'info') {
  player.privateLogs.push({ text, type, at: Date.now() });
  if (player.privateLogs.length > 80) player.privateLogs.shift();
}

function resolveNight(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== 'night') return;
  clearPhaseTimer(room);

  const alive = alivePlayers(room);
  const deadTonight = new Set();
  const guardActions = livingByRole(room, 'guard').map((guard) => room.nightActions[`guard:${guard.id}`]).filter(Boolean);
  const guardedTargets = new Set(guardActions.map((a) => a.targetId).filter(Boolean));

  // Auto-fill missing seer actions at timeout so the player still gets a result.
  for (const seer of livingByRole(room, 'seer')) {
    const key = `seer:${seer.id}`;
    let action = room.nightActions[key];
    if (!action) {
      const candidates = alive.filter((p) => p.id !== seer.id);
      if (candidates.length) {
        action = { actorId: seer.id, targetId: pickRandom(candidates).id, auto: true };
        room.nightActions[key] = action;
      }
    }
    if (action) {
      const target = findPlayer(room, action.targetId);
      if (target) {
        const result = target.role === 'werewolf' ? '人狼である' : '人狼でない';
        submitPrivate(seer, `占い結果：${target.name}さんは「${result}」でした。${action.auto ? '（未選択のため自動占い）' : ''}`, 'result');
      }
    }
  }

  let attackTargetId = null;
  if (room.settings.firstNightAttack || room.day > 1) {
    const wolves = livingWolves(room);
    const wolfChoices = wolves.map((wolf) => room.nightActions[`wolf:${wolf.id}`]?.targetId).filter(Boolean);
    attackTargetId = majorityChoice(wolfChoices);
    if (!attackTargetId && wolves.length > 0) {
      const candidates = alive.filter((p) => p.role !== 'werewolf');
      if (candidates.length) attackTargetId = pickRandom(candidates).id;
    }
  }

  if (attackTargetId) {
    const target = findPlayer(room, attackTargetId);
    if (target && target.alive) {
      if (guardedTargets.has(target.id)) {
        addLog(room, '昨夜、人狼の襲撃は防がれました。犠牲者はいません。', true, 'result');
      } else {
        deadTonight.add(target.id);
      }
    }
  }

  const deadNames = [];
  for (const id of deadTonight) {
    const player = findPlayer(room, id);
    if (player && player.alive) {
      player.alive = false;
      deadNames.push(player.name);
    }
  }

  if (deadNames.length > 0) {
    addLog(room, `昨夜、${deadNames.join('さん、')}さんが無残な姿で発見されました。`, true, 'result');
  } else if (!attackTargetId) {
    addLog(room, '昨夜、犠牲者は出ませんでした。', true, 'result');
  }

  // Medium result from the previous execution.
  if (room.executedLast) {
    const executed = room.executedLast;
    const result = executed.role === 'werewolf' ? '人狼である' : '人狼でない';
    for (const medium of livingByRole(room, 'medium')) {
      submitPrivate(medium, `霊能結果：処刑された${executed.name}さんは「${result}」でした。`, 'result');
    }
  }

  const victory = countVictory(room);
  if (victory) {
    room.winner = victory.winner;
    room.winText = victory.text;
    addLog(room, victory.text, true, 'win');
    enterPhase(room, 'end');
    return;
  }

  enterPhase(room, 'day');
}

function getVoteOptions(room, voterId) {
  const alive = alivePlayers(room);
  let candidates = room.voteCandidates ? alive.filter((p) => room.voteCandidates.includes(p.id)) : alive;
  if (!room.settings.allowSelfVote) candidates = candidates.filter((p) => p.id !== voterId);
  return candidates.map((p) => p.id);
}

function allVotesSubmitted(room) {
  const alive = alivePlayers(room);
  return alive.every((p) => Boolean(room.votes[p.id]));
}

function resolveVote(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== 'vote') return;
  clearPhaseTimer(room);

  const alive = alivePlayers(room);
  const counts = new Map();
  const voteDetails = [];
  for (const voter of alive) {
    let targetId = room.votes[voter.id]?.targetId;
    const validTargets = getVoteOptions(room, voter.id);

    if (!targetId) {
      targetId = room.settings.missedVote === 'skip' && room.skipUsed < room.settings.allowSkip ? 'skip' : 'invalid';
    }
    if (targetId !== 'skip' && targetId !== 'invalid' && !validTargets.includes(targetId)) {
      targetId = 'invalid';
    }
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
    voteDetails.push({ voterId: voter.id, voterName: voter.name, targetId });
  }

  const detailText = voteDetails.map((v) => {
    const targetName = v.targetId === 'skip' ? '処刑見送り' : v.targetId === 'invalid' ? '無効票' : findPlayer(room, v.targetId)?.name || '不明';
    return `${v.voterName}→${targetName}`;
  }).join(' / ');
  if (room.settings.showVotes === 'show' || room.settings.showVotes === 'after') {
    addLog(room, `投票先：${detailText}`, room.settings.showVotes === 'show', 'vote');
  }

  const publicCounts = [...counts.entries()].map(([targetId, count]) => {
    const name = targetId === 'skip' ? '処刑見送り' : targetId === 'invalid' ? '無効票' : findPlayer(room, targetId)?.name || '不明';
    return `${name}：${count}票`;
  }).join(' / ');
  addLog(room, `投票結果：${publicCounts}`, true, 'vote');

  counts.delete('invalid');
  if (counts.size === 0) {
    addLog(room, '有効票がありませんでした。処刑は行われません。', true, 'result');
    afterExecution(room, null);
    return;
  }
  const max = Math.max(...counts.values());
  const top = [...counts.entries()].filter(([, count]) => count === max).map(([id]) => id);

  if (top.includes('skip') && top.length === 1 && room.skipUsed < room.settings.allowSkip) {
    room.skipUsed += 1;
    addLog(room, '投票により、今回の処刑は見送られました。', true, 'result');
    afterExecution(room, null);
    return;
  }

  const topPlayers = top.filter((id) => id !== 'skip');
  if (topPlayers.length > 1 && room.settings.runoff && !room.runoffDone) {
    enterPhase(room, 'vote', { voteCandidates: topPlayers, runoffDone: true });
    return;
  }

  let executedId = null;
  if (topPlayers.length === 1) {
    executedId = topPlayers[0];
  } else if (topPlayers.length > 1 && room.settings.randomTie) {
    executedId = pickRandom(topPlayers);
  }

  if (!executedId) {
    addLog(room, '同数のため、処刑は行われません。', true, 'result');
    afterExecution(room, null);
    return;
  }

  const executed = findPlayer(room, executedId);
  if (executed && executed.alive) {
    executed.alive = false;
    room.executedLast = { id: executed.id, name: executed.name, role: executed.role };
    addLog(room, `${executed.name}さんが処刑されました。`, true, 'result');
  }
  afterExecution(room, executed || null);
}

function afterExecution(room) {
  const victory = countVictory(room);
  if (victory) {
    room.winner = victory.winner;
    room.winText = victory.text;
    addLog(room, victory.text, true, 'win');
    enterPhase(room, 'end');
    return;
  }
  room.day += 1;
  enterPhase(room, 'night');
}

function validateRoleCounts(playerCount, counts) {
  const normalized = { villager: 0, werewolf: 0, seer: 0, guard: 0, medium: 0, madman: 0 };
  for (const role of Object.keys(normalized)) normalized[role] = clampNumber(counts?.[role], 0, playerCount, 0);
  let total = Object.values(normalized).reduce((sum, n) => sum + n, 0);
  if (total > playerCount) {
    return { ok: false, error: `役職数が参加人数を超えています。現在：${total} / 参加人数：${playerCount}` };
  }
  normalized.villager += playerCount - total;
  total = Object.values(normalized).reduce((sum, n) => sum + n, 0);
  if (normalized.werewolf < 1) return { ok: false, error: '人狼は最低1人必要です。' };
  return { ok: true, counts: normalized, total };
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload = {}, ack) => {
    const code = makeRoomCode();
    const playerId = makeId('p');
    const hostName = String(payload.hostName || 'GM').trim().slice(0, 20) || 'GM';
    const gmMode = payload.gmMode !== false;
    const initialPassword = normalizePassword(payload.password);
    const room = {
      code,
      title: String(payload.title || '吹雪の屋敷').trim().slice(0, 40) || '吹雪の屋敷',
      hostSocketId: socket.id,
      hostPlayerId: playerId,
      passwordHash: initialPassword ? hashPassword(initialPassword) : null,
      sockets: new Set([socket.id]),
      players: [{ id: playerId, name: hostName, socketId: socket.id, alive: true, connected: true, role: null, ready: false, privateLogs: [] }],
      status: 'lobby',
      phase: 'lobby',
      day: 1,
      gmMode,
      settings: normalizeSettings(payload.settings),
      roleCounts: null,
      log: [],
      messages: [],
      nightActions: {},
      votes: {},
      voteCandidates: null,
      runoffDone: false,
      skipUsed: 0,
      executedLast: null,
      winner: null,
      winText: null,
      phaseStartedAt: Date.now(),
      phaseEndsAt: null,
      timer: null,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    socket.join(code);
    addLog(room, `${hostName}さんが部屋を作成しました。`, true, 'system');
    ack?.({ ok: true, code, playerId });
    emitRoom(room);
  });

  socket.on('joinRoom', (payload = {}, ack) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: '部屋が見つかりません。部屋コードを確認してください。' });
    const name = String(payload.name || '').trim().slice(0, 20);
    if (!name) return ack?.({ ok: false, error: '名前を入力してください。' });

    let player = null;
    if (payload.playerId) player = findPlayer(room, payload.playerId);

    if (room.status !== 'lobby' && !player) return ack?.({ ok: false, error: 'この部屋はすでにゲーム開始済みです。' });
    if (!player && room.players.length >= 20) return ack?.({ ok: false, error: 'この部屋は満員です。' });
    if (!player && !passwordMatches(room, payload.password)) return ack?.({ ok: false, error: '部屋パスワードが違います。' });

    if (!player) {
      player = { id: makeId('p'), name, socketId: socket.id, alive: true, connected: true, role: null, ready: false, privateLogs: [] };
      room.players.push(player);
      addLog(room, `${name}さんが参加しました。`, true, 'system');
    } else {
      player.name = name;
      player.socketId = socket.id;
      player.connected = true;
      if (player.id === room.hostPlayerId) room.hostSocketId = socket.id;
      addLog(room, `${name}さんが再接続しました。`, true, 'system');
    }
    room.sockets.add(socket.id);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    socket.join(code);
    ack?.({ ok: true, code, playerId: player.id, passwordRequired: Boolean(room.passwordHash) });
    emitRoom(room);
  });

  socket.on('updateRoom', (payload = {}, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ変更できます。' });
    if (room.status !== 'lobby') return ack?.({ ok: false, error: '開始後は設定を変更できません。' });
    room.gmMode = payload.gmMode !== false;
    room.settings = normalizeSettings(payload.settings || room.settings);
    if (payload.title) room.title = String(payload.title).trim().slice(0, 40) || room.title;
    if (payload.clearPassword) {
      room.passwordHash = null;
      addLog(room, '部屋パスワードを解除しました。', true, 'system');
    } else if (Object.prototype.hasOwnProperty.call(payload, 'password')) {
      const nextPassword = normalizePassword(payload.password);
      if (nextPassword) {
        room.passwordHash = hashPassword(nextPassword);
        addLog(room, '部屋パスワードを設定しました。', true, 'system');
      }
    }
    if (payload.roleCounts) {
      const checked = validateRoleCounts(room.players.length, payload.roleCounts);
      if (!checked.ok) return ack?.({ ok: false, error: checked.error });
      room.roleCounts = checked.counts;
    }
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on('autoRoleCounts', (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ変更できます。' });
    room.roleCounts = autoRoleCounts(room.players.length);
    ack?.({ ok: true, counts: room.roleCounts });
    emitRoom(room);
  });

  socket.on('startGame', (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ開始できます。' });
    if (room.players.length < 4 || room.players.length > 20) return ack?.({ ok: false, error: 'プレイヤー人数は4〜20人にしてください。' });
    const checked = validateRoleCounts(room.players.length, room.roleCounts || autoRoleCounts(room.players.length));
    if (!checked.ok) return ack?.({ ok: false, error: checked.error });
    room.roleCounts = checked.counts;
    room.day = 1;
    room.status = 'playing';
    room.winner = null;
    room.winText = null;
    room.skipUsed = 0;
    room.log = [];
    room.messages = [];
    assignRoles(room);
    addLog(room, 'ゲームが開始されました。各自、自分の役職を確認してください。', true, 'phase');
    ack?.({ ok: true });
    enterPhase(room, 'night');
  });

  socket.on('hostNext', (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ操作できます。' });
    if (!room.gmMode) return ack?.({ ok: false, error: 'GMなしモードでは自動進行です。' });
    if (room.phase === 'night') {
      resolveNight(room.code);
    } else if (room.phase === 'day') {
      enterPhase(room, 'vote');
    } else if (room.phase === 'vote') {
      resolveVote(room.code);
    } else {
      return ack?.({ ok: false, error: '現在この操作はできません。' });
    }
    ack?.({ ok: true });
  });

  socket.on('submitNightAction', (payload = {}, ack) => {
    const room = getRoomBySocket(socket);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!room || !player) return ack?.({ ok: false, error: '部屋に参加していません。' });
    if (room.phase !== 'night') return ack?.({ ok: false, error: '夜時間ではありません。' });
    if (!player.alive) return ack?.({ ok: false, error: '死亡しているため行動できません。' });
    const targetId = String(payload.targetId || '');
    const target = findPlayer(room, targetId);
    if (!target || !target.alive) return ack?.({ ok: false, error: '対象を選択してください。' });

    if (player.role === 'werewolf') {
      if (target.role === 'werewolf') return ack?.({ ok: false, error: '人狼は人狼を襲撃できません。' });
      if (!room.settings.firstNightAttack && room.day === 1) return ack?.({ ok: false, error: '初日は襲撃なしの設定です。' });
      room.nightActions[`wolf:${player.id}`] = { actorId: player.id, targetId };
      submitPrivate(player, `襲撃先を${target.name}さんに選びました。`, 'action');
    } else if (player.role === 'seer') {
      if (target.id === player.id) return ack?.({ ok: false, error: '自分は占えません。' });
      room.nightActions[`seer:${player.id}`] = { actorId: player.id, targetId };
      submitPrivate(player, `占い先を${target.name}さんに選びました。`, 'action');
    } else if (player.role === 'guard') {
      if (target.id === player.id) return ack?.({ ok: false, error: '自分は護衛できません。' });
      if (!room.settings.consecutiveGuard && room.lastGuardTarget === target.id) return ack?.({ ok: false, error: '連続ガードなしのため、同じ人は護衛できません。' });
      room.nightActions[`guard:${player.id}`] = { actorId: player.id, targetId };
      room.lastGuardTarget = target.id;
      submitPrivate(player, `護衛先を${target.name}さんに選びました。`, 'action');
    } else {
      return ack?.({ ok: false, error: 'この役職は夜行動がありません。' });
    }

    ack?.({ ok: true });
    if (!room.gmMode && allRequiredNightActionsSubmitted(room)) resolveNight(room.code);
    else emitRoom(room);
  });

  socket.on('submitVote', (payload = {}, ack) => {
    const room = getRoomBySocket(socket);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!room || !player) return ack?.({ ok: false, error: '部屋に参加していません。' });
    if (room.phase !== 'vote') return ack?.({ ok: false, error: '投票時間ではありません。' });
    if (!player.alive) return ack?.({ ok: false, error: '死亡しているため投票できません。' });
    const targetId = String(payload.targetId || '');
    if (targetId === 'skip') {
      if (room.skipUsed >= room.settings.allowSkip) return ack?.({ ok: false, error: '処刑見送りはもう使えません。' });
      room.votes[player.id] = { targetId };
    } else {
      const validTargets = getVoteOptions(room, player.id);
      if (!validTargets.includes(targetId)) return ack?.({ ok: false, error: '投票先を選択してください。' });
      room.votes[player.id] = { targetId };
    }
    ack?.({ ok: true });
    if (!room.gmMode && room.settings.skipWhenAllVoted && allVotesSubmitted(room)) resolveVote(room.code);
    else emitRoom(room);
  });

  socket.on('sendMessage', (payload = {}, ack) => {
    const room = getRoomBySocket(socket);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!room || !player) return ack?.({ ok: false, error: '部屋に参加していません。' });
    const text = String(payload.text || '').trim().slice(0, 300);
    if (!text) return ack?.({ ok: false, error: 'メッセージを入力してください。' });
    const channel = ['public', 'wolf', 'grave'].includes(payload.channel) ? payload.channel : 'public';
    if (channel === 'wolf' && player.role !== 'werewolf' && !isHost(socket, room)) return ack?.({ ok: false, error: '人狼チャットは人狼のみ使えます。' });
    if (channel === 'grave' && player.alive && !isHost(socket, room)) return ack?.({ ok: false, error: '墓場チャットは死亡者のみ使えます。' });
    if (channel === 'public' && room.phase === 'night' && room.status === 'playing') return ack?.({ ok: false, error: '夜は全体チャットを使えません。' });
    room.messages.push({ id: makeId('m'), playerId: player.id, name: player.name, text, channel, at: Date.now() });
    if (room.messages.length > 300) room.messages.shift();
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on('kickPlayer', (payload = {}, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ操作できます。' });
    if (room.status !== 'lobby') return ack?.({ ok: false, error: 'ゲーム開始後は退出させられません。' });
    const targetId = String(payload.playerId || '');
    if (targetId === room.hostPlayerId) return ack?.({ ok: false, error: 'ホストは退出させられません。' });
    room.players = room.players.filter((p) => p.id !== targetId);
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on('resetRoom', (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || !isHost(socket, room)) return ack?.({ ok: false, error: 'ホストのみ操作できます。' });
    clearPhaseTimer(room);
    room.status = 'lobby';
    room.phase = 'lobby';
    room.day = 1;
    room.winner = null;
    room.winText = null;
    room.skipUsed = 0;
    room.roleCounts = null;
    room.nightActions = {};
    room.votes = {};
    room.voteCandidates = null;
    room.executedLast = null;
    for (const p of room.players) {
      p.role = null;
      p.alive = true;
      p.privateLogs = [];
    }
    room.log = [];
    room.messages = [];
    addLog(room, '部屋がリセットされました。', true, 'system');
    ack?.({ ok: true });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    room.sockets.delete(socket.id);
    const player = findPlayer(room, socket.data.playerId);
    if (player) player.connected = false;
    if (isHost(socket, room)) {
      // Keep the room for a while; if the host reconnects as a normal player, manual recovery is possible in this prototype.
      addLog(room, 'ホストの接続が切れました。', true, 'system');
    }
    emitRoom(room);
    // Clean up empty rooms after 30 minutes.
    setTimeout(() => {
      const current = rooms.get(room.code);
      if (current && current.sockets.size === 0 && Date.now() - current.createdAt > 30 * 60 * 1000) {
        clearPhaseTimer(current);
        rooms.delete(current.code);
      }
    }, 30 * 60 * 1000);
  });
});

server.listen(PORT, () => {
  console.log(`Snow Mansion Werewolf listening on http://localhost:${PORT}`);
});

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {Set<string>} sockets
 * @property {Array<Object>} players
 */
