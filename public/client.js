'use strict';

const socket = io();
const app = document.querySelector('#app');
const connection = document.querySelector('#connection');
const homeTemplate = document.querySelector('#home-template');

let state = null;
let tickTimer = null;

const qs = new URLSearchParams(location.search);
const saved = {
  playerId: localStorage.getItem('ww_playerId') || '',
  name: localStorage.getItem('ww_name') || '',
  roomCode: qs.get('room') || localStorage.getItem('ww_roomCode') || '',
  password: localStorage.getItem('ww_roomPassword') || '',
};

const ROLE_LABELS = {
  villager: '市民',
  werewolf: '人狼',
  seer: '占い師',
  guard: '狩人',
  medium: '霊能者',
  madman: '狂人',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function emitAck(event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (!res?.ok) toast(res?.error || 'エラーが発生しました。', 'error');
      resolve(res || { ok: false });
    });
  });
}

function formatPhase(phase) {
  return {
    lobby: '待機中',
    night: '夜',
    day: '昼',
    vote: '投票',
    end: '終了',
  }[phase] || phase;
}

function formatTime(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

function alivePlayers() {
  return state?.players?.filter((p) => p.alive) || [];
}

function canUsePublicChat() {
  return !state?.room || state.room.phase !== 'night' || state.room.status !== 'playing';
}

function canUseWolfChat() {
  return state?.me?.role === 'werewolf' || state?.isHost;
}

function canUseGraveChat() {
  return state?.isHost || state?.me?.alive === false;
}

function renderHome() {
  app.innerHTML = '';
  app.appendChild(homeTemplate.content.cloneNode(true));
  const joinCode = app.querySelector('#joinCode');
  const joinName = app.querySelector('#joinName');
  joinCode.value = saved.roomCode || '';
  joinName.value = saved.name || '';
  const joinPassword = app.querySelector('#roomPasswordJoin');
  if (joinPassword) joinPassword.value = saved.password || '';
  const hostName = app.querySelector('#hostName');
  if (hostName && saved.name) hostName.value = saved.name;

  app.querySelector('#createRoom').addEventListener('click', async () => {
    const hostName = app.querySelector('#hostName').value.trim() || 'GM';
    const title = app.querySelector('#roomTitle').value.trim() || '吹雪の屋敷';
    const gmMode = app.querySelector('#gmMode').value === 'true';
    const password = app.querySelector('#roomPasswordCreate')?.value.trim() || '';
    const res = await emitAck('createRoom', { hostName, title, gmMode, password });
    if (res.ok) {
      localStorage.setItem('ww_playerId', res.playerId);
      localStorage.setItem('ww_name', hostName);
      localStorage.setItem('ww_roomCode', res.code);
      if (password) localStorage.setItem('ww_roomPassword', password);
      else localStorage.removeItem('ww_roomPassword');
      history.replaceState(null, '', `?room=${res.code}`);
    }
  });

  app.querySelector('#joinRoom').addEventListener('click', async () => {
    const code = joinCode.value.trim().toUpperCase();
    const name = joinName.value.trim();
    const password = app.querySelector('#roomPasswordJoin')?.value.trim() || '';
    const res = await emitAck('joinRoom', { code, name, password, playerId: saved.playerId });
    if (res.ok) {
      localStorage.setItem('ww_playerId', res.playerId);
      localStorage.setItem('ww_name', name);
      localStorage.setItem('ww_roomCode', res.code);
      if (password) localStorage.setItem('ww_roomPassword', password);
      history.replaceState(null, '', `?room=${res.code}`);
    }
  });
}

function render() {
  if (!state?.room) {
    renderHome();
    return;
  }
  if (tickTimer) clearInterval(tickTimer);
  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="badges">
          <span class="badge important">部屋 ${escapeHtml(state.room.code)}</span>
          <span class="badge">${escapeHtml(state.room.title)}</span>
          <span class="badge">${state.room.gmMode ? 'GMあり' : 'GMなし'}</span>
          <span class="badge">${state.room.day}日目 ${formatPhase(state.room.phase)}</span>
          ${state.me ? `<span class="badge ${state.me.alive ? 'alive' : 'dead'}">${state.me.alive ? '生存' : '死亡'}</span>` : ''}
        </div>
      </div>
      <div class="badges">
        ${state.isHost ? '<span class="badge important">ホスト</span>' : ''}
        <button id="leave" class="small">ホームへ</button>
      </div>
    </div>
    ${state.room.phase === 'lobby' ? renderLobby() : renderGame()}
  `;
  bindCommon();
  if (state.room.phase === 'lobby') bindLobby();
  else bindGame();
  updateTimer();
  tickTimer = setInterval(updateTimer, 500);
}

function renderLobby() {
  const url = joinUrl(state.room.code);
  return `
    <section class="grid two">
      <div class="card">
        <h2>参加用URL・QR</h2>
        <div class="share-layout">
          <div>
            <div class="room-code">${escapeHtml(state.room.code)}</div>
            <div class="badges">
              <span class="badge ${state.room.passwordRequired ? 'important' : ''}">${state.room.passwordRequired ? 'パスワードあり' : 'パスワードなし'}</span>
              <span class="badge">人数：${state.players.length} / 20</span>
            </div>
            <p>URLを共有するか、スマホでQRコードを読み取って参加できます。</p>
            <div class="share-row">
              <input id="shareUrl" readonly value="${escapeHtml(url)}">
              <button id="copyUrl" class="small">コピー</button>
            </div>
            <p class="note">※QRコードには部屋コードだけが入ります。パスワードありの場合は参加時に入力してください。</p>
          </div>
          <div class="qr-wrap">
            <img class="qr" alt="参加用QRコード" src="/qr/${encodeURIComponent(state.room.code)}.svg?v=${state.players.length}-${state.room.passwordRequired ? 1 : 0}">
          </div>
        </div>
      </div>
      <div class="card">
        <h2>参加者</h2>
        ${renderPlayers(false)}
      </div>
    </section>
    ${state.isHost ? renderHostLobby() : `<section class="card"><h2>待機中</h2><p>ホストがゲームを開始するまで待ってください。</p></section>`}
  `;
}

function renderHostLobby() {
  const counts = state.room.roleCounts || suggestedCounts();
  return `
    <section class="card">
      <h2>部屋設定</h2>
      <div class="settings-grid">
        <div>
          <label>モード</label>
          <select id="settingGmMode">
            <option value="true" ${state.room.gmMode ? 'selected' : ''}>GMあり：ホストが進行</option>
            <option value="false" ${!state.room.gmMode ? 'selected' : ''}>GMなし：アプリが自動進行</option>
          </select>
        </div>
        <div>
          <label>昼の長さ（秒）</label>
          <input id="daySeconds" type="number" min="60" max="360" value="${state.room.settings.daySeconds}">
        </div>
        <div>
          <label>夜の長さ（秒）</label>
          <input id="nightSeconds" type="number" min="30" max="120" value="${state.room.settings.nightSeconds}">
        </div>
        <div>
          <label>投票時間（秒）</label>
          <input id="voteSeconds" type="number" min="30" max="120" value="${state.room.settings.voteSeconds}">
        </div>
        <div>
          <label>投票先の公開</label>
          <select id="showVotes">
            <option value="hide" ${state.room.settings.showVotes === 'hide' ? 'selected' : ''}>見せない</option>
            <option value="show" ${state.room.settings.showVotes === 'show' ? 'selected' : ''}>投票後すぐ見せる</option>
            <option value="after" ${state.room.settings.showVotes === 'after' ? 'selected' : ''}>終了後ログ用</option>
          </select>
        </div>
        <div>
          <label>処刑見送り回数</label>
          <select id="allowSkip">
            <option value="0" ${state.room.settings.allowSkip === 0 ? 'selected' : ''}>なし</option>
            <option value="1" ${state.room.settings.allowSkip === 1 ? 'selected' : ''}>1回</option>
            <option value="2" ${state.room.settings.allowSkip === 2 ? 'selected' : ''}>2回</option>
          </select>
        </div>
      </div>
      <div class="settings-grid">
        ${checkbox('runoff', '決選投票あり', state.room.settings.runoff)}
        ${checkbox('randomTie', '同数時ランダム処刑', state.room.settings.randomTie)}
        ${checkbox('allowSelfVote', '自身への投票を許可', state.room.settings.allowSelfVote)}
        ${checkbox('skipWhenAllVoted', '全員投票でスキップ', state.room.settings.skipWhenAllVoted)}
        ${checkbox('firstNightAttack', '初日夜の襲撃あり', state.room.settings.firstNightAttack)}
        ${checkbox('consecutiveGuard', '連続ガードあり', state.room.settings.consecutiveGuard)}
      </div>
      <button id="saveSettings" class="good">設定を保存</button>
    </section>

    <section class="card">
      <h2>セキュリティ</h2>
      <p>現在：${state.room.passwordRequired ? 'パスワードあり' : 'パスワードなし'}</p>
      <div class="settings-grid">
        <div>
          <label>部屋パスワードの設定・変更</label>
          <input id="roomPasswordUpdate" type="password" maxlength="40" placeholder="変更する場合のみ入力">
        </div>
        <div>
          <label class="badge clear-password"><input type="checkbox" id="clearPassword" style="width:auto"> パスワードを解除する</label>
        </div>
      </div>
      <p class="note">公開URLでも、部屋コード＋パスワードで身内だけに絞れます。</p>
    </section>

    <section class="card">
      <h2>初級役職の配役</h2>
      <p>おすすめ配役を自動で入れています。足りない人数は市民に自動調整されます。</p>
      <div class="role-counts">
        ${Object.keys(ROLE_LABELS).map((role) => `
          <div>
            <label>${ROLE_LABELS[role]}</label>
            <input class="roleCount" data-role="${role}" type="number" min="0" max="20" value="${counts[role] || 0}">
          </div>
        `).join('')}
      </div>
      <div class="action-row">
        <button id="autoCounts">おすすめ配役</button>
        <button id="startGame" class="primary">ゲーム開始</button>
      </div>
    </section>
  `;
}

function checkbox(id, label, checked) {
  return `<label class="badge"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="width:auto"> ${label}</label>`;
}

function suggestedCounts() {
  const n = state.players.length;
  const counts = { villager: 0, werewolf: 0, seer: 0, guard: 0, medium: 0, madman: 0 };
  counts.werewolf = n >= 16 ? 4 : n >= 11 ? 3 : n >= 7 ? 2 : 1;
  counts.seer = 1;
  counts.guard = n >= 5 ? 1 : 0;
  counts.medium = n >= 7 ? 1 : 0;
  counts.madman = n >= 6 ? 1 : 0;
  const used = counts.werewolf + counts.seer + counts.guard + counts.medium + counts.madman;
  counts.villager = Math.max(0, n - used);
  return counts;
}

function renderGame() {
  return `
    <section class="grid three">
      <div class="card role-card">
        ${renderRoleCard()}
      </div>
      <div class="card">
        ${renderPhaseCard()}
      </div>
      <div class="card">
        <h2>生存者</h2>
        ${renderPlayers(state.isHost && state.room.status !== 'lobby')}
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        ${renderActionCard()}
      </div>
      <div class="card">
        <h2>ゲームログ</h2>
        ${renderLog(state.publicLog)}
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        <h2>チャット</h2>
        ${renderMessages()}
        ${renderChatForm()}
      </div>
      <div class="card">
        <h2>自分だけの結果</h2>
        ${renderPrivateLog()}
      </div>
    </section>

    ${state.isHost ? renderHostGamePanel() : ''}
  `;
}

function renderRoleCard() {
  if (!state.me) return '<h2>観戦中</h2>';
  const teamClass = state.me.team === 'werewolf' ? 'team-werewolf' : 'team-village';
  const teamName = state.me.team === 'werewolf' ? '人狼陣営' : '市民陣営';
  return `
    <h2>あなたの役職</h2>
    <div class="role-name ${teamClass}">${escapeHtml(state.me.roleName || '未配役')}</div>
    <span class="badge ${state.me.team === 'werewolf' ? 'dead' : 'alive'}">${teamName}</span>
    <p>${escapeHtml(state.me.description || '')}</p>
    ${state.me.role === 'werewolf' ? `<h3>仲間の人狼</h3><p>${state.wolves.map((w) => escapeHtml(w.name)).join('、') || 'なし'}</p>` : ''}
  `;
}

function renderPhaseCard() {
  if (state.room.phase === 'end') {
    return `<h2>ゲーム終了</h2><p class="phase-title">${escapeHtml(state.room.winText || '勝敗が決まりました。')}</p><button id="resetRoom" class="primary">ロビーに戻す</button>`;
  }
  return `
    <h2>現在のフェーズ</h2>
    <p class="phase-title">${state.room.day}日目 ${formatPhase(state.room.phase)}</p>
    <div id="timer" class="timer">--:--</div>
    <p>${phaseHelp()}</p>
    ${state.isHost && state.room.gmMode ? `<button id="hostNext" class="primary">次へ進める</button>` : ''}
  `;
}

function phaseHelp() {
  if (state.room.phase === 'night') return '夜行動のある役職は、下の行動画面から対象を選んでください。';
  if (state.room.phase === 'day') return '話し合いの時間です。GMなしモードでは時間が来ると自動で投票に移ります。';
  if (state.room.phase === 'vote') return state.room.voteCandidates ? '決選投票です。候補者の中から選んでください。' : '処刑したい相手に投票してください。';
  return '';
}

function renderActionCard() {
  if (!state.me?.alive && state.room.phase !== 'end') {
    return `<h2>行動</h2><p>あなたは死亡しています。墓場チャットが使えます。</p>`;
  }
  if (state.room.phase === 'night') return renderNightAction();
  if (state.room.phase === 'vote') return renderVoteAction();
  if (state.room.phase === 'day') return `<h2>昼の話し合い</h2><p>人狼が誰かを話し合ってください。投票時間になるまで待ちます。</p>`;
  return `<h2>行動</h2><p>現在できる行動はありません。</p>`;
}

function targetOptions(filterFn) {
  return alivePlayers().filter(filterFn).map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

function renderNightAction() {
  const role = state.me?.role;
  if (role === 'werewolf') {
    return `
      <h2>夜行動：襲撃</h2>
      <p>襲撃する相手を選んでください。人狼が複数いる場合は最多選択の相手を襲撃します。</p>
      <div class="action-row">
        <select id="nightTarget">${targetOptions((p) => !state.wolves.some((w) => w.id === p.id) && p.id !== state.me.id)}</select>
        <button id="submitNight" class="primary">決定</button>
      </div>
    `;
  }
  if (role === 'seer') {
    return `
      <h2>夜行動：占い</h2>
      <p>占いたい相手を選んでください。結果は自分だけに表示されます。</p>
      <div class="action-row">
        <select id="nightTarget">${targetOptions((p) => p.id !== state.me.id)}</select>
        <button id="submitNight" class="primary">決定</button>
      </div>
    `;
  }
  if (role === 'guard') {
    return `
      <h2>夜行動：護衛</h2>
      <p>護衛したい相手を選んでください。自分は護衛できません。</p>
      <div class="action-row">
        <select id="nightTarget">${targetOptions((p) => p.id !== state.me.id)}</select>
        <button id="submitNight" class="primary">決定</button>
      </div>
    `;
  }
  return `<h2>夜行動</h2><p>この役職には夜行動がありません。朝まで待ってください。</p>`;
}

function renderVoteAction() {
  const alive = alivePlayers();
  let candidates = alive;
  if (state.room.voteCandidates?.length) candidates = alive.filter((p) => state.room.voteCandidates.includes(p.id));
  if (!state.room.settings.allowSelfVote) candidates = candidates.filter((p) => p.id !== state.me.id);
  const options = candidates.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const skipOption = state.room.skipUsed < state.room.settings.allowSkip ? '<option value="skip">処刑見送り</option>' : '';
  return `
    <h2>投票</h2>
    <p>処刑したい相手を選んでください。</p>
    <div class="action-row">
      <select id="voteTarget">${options}${skipOption}</select>
      <button id="submitVote" class="primary">投票する</button>
    </div>
  `;
}

function renderPlayers(includeRole) {
  return `<div class="player-list">
    ${state.players.map((p) => `
      <div class="player ${p.alive ? '' : 'dead'}">
        <div>
          <strong>${escapeHtml(p.name)}</strong>
          <div class="meta">
            <span>${p.alive ? '生存' : '死亡'}</span>
            <span>${p.connected ? '接続中' : '切断'}</span>
            ${includeRole ? `<span>${escapeHtml(p.roleName || '')}</span>` : ''}
          </div>
        </div>
        ${state.isHost && state.room.phase === 'lobby' && p.id !== state.me?.id ? `<button class="small danger kick" data-id="${p.id}">退出</button>` : ''}
      </div>
    `).join('')}
  </div>`;
}

function renderLog(items) {
  if (!items?.length) return '<p>まだログはありません。</p>';
  return `<div class="log">${items.map((item) => `<div class="log-item ${escapeHtml(item.type)}">${escapeHtml(item.text)}</div>`).join('')}</div>`;
}

function renderMessages() {
  if (!state.messages?.length) return '<p>まだメッセージはありません。</p>';
  return `<div class="chat-box">${state.messages.map((m) => `
    <div class="msg ${escapeHtml(m.channel)}">
      <span class="channel">${m.channel === 'wolf' ? '人狼' : m.channel === 'grave' ? '墓場' : '全体'}</span><br>
      <strong>${escapeHtml(m.name)}</strong>：${escapeHtml(m.text)}
    </div>
  `).join('')}</div>`;
}

function renderChatForm() {
  const channels = [canUsePublicChat() ? '<option value="public">全体</option>' : '', canUseWolfChat() ? '<option value="wolf">人狼</option>' : '', canUseGraveChat() ? '<option value="grave">墓場</option>' : ''].join('');
  if (!channels.trim()) return '<p>現在使えるチャットはありません。</p>';
  return `
    <div class="chat-form">
      <select id="chatChannel">${channels}</select>
      <input id="chatText" maxlength="300" placeholder="メッセージ">
      <button id="sendChat">送信</button>
    </div>
  `;
}

function renderPrivateLog() {
  const logs = state.me?.privateLogs || [];
  if (!logs.length) return '<p>まだ個人結果はありません。</p>';
  return `<div class="private-log">${logs.map((l) => `<div class="private-item">${escapeHtml(l.text)}</div>`).join('')}</div>`;
}

function renderHostGamePanel() {
  return `
    <section class="grid two">
      <div class="card">
        <h2>GM用：全ログ</h2>
        ${renderLog(state.hostLog)}
      </div>
      <div class="card">
        <h2>GM用：役職一覧</h2>
        ${renderPlayers(true)}
        <button id="resetRoom2" class="danger" style="margin-top:12px">ゲームをリセット</button>
      </div>
    </section>
  `;
}

function bindCommon() {
  const leave = app.querySelector('#leave');
  if (leave) {
    leave.addEventListener('click', () => {
      localStorage.removeItem('ww_roomCode');
      history.replaceState(null, '', location.pathname);
      state = null;
      renderHome();
    });
  }
}

function collectRoomUpdatePayload() {
  const payload = {
    gmMode: app.querySelector('#settingGmMode')?.value === 'true',
    settings: collectSettings(),
    roleCounts: collectRoleCounts(),
  };
  const password = app.querySelector('#roomPasswordUpdate')?.value.trim() || '';
  const clearPassword = Boolean(app.querySelector('#clearPassword')?.checked);
  if (clearPassword) payload.clearPassword = true;
  else if (password) payload.password = password;
  return payload;
}

function collectSettings() {
  return {
    daySeconds: Number(app.querySelector('#daySeconds')?.value || state.room.settings.daySeconds),
    nightSeconds: Number(app.querySelector('#nightSeconds')?.value || state.room.settings.nightSeconds),
    voteSeconds: Number(app.querySelector('#voteSeconds')?.value || state.room.settings.voteSeconds),
    showVotes: app.querySelector('#showVotes')?.value || state.room.settings.showVotes,
    allowSkip: Number(app.querySelector('#allowSkip')?.value || state.room.settings.allowSkip),
    runoff: Boolean(app.querySelector('#runoff')?.checked),
    randomTie: Boolean(app.querySelector('#randomTie')?.checked),
    allowSelfVote: Boolean(app.querySelector('#allowSelfVote')?.checked),
    skipWhenAllVoted: Boolean(app.querySelector('#skipWhenAllVoted')?.checked),
    firstNightAttack: Boolean(app.querySelector('#firstNightAttack')?.checked),
    consecutiveGuard: Boolean(app.querySelector('#consecutiveGuard')?.checked),
  };
}

function collectRoleCounts() {
  const counts = {};
  app.querySelectorAll('.roleCount').forEach((input) => {
    counts[input.dataset.role] = Number(input.value || 0);
  });
  return counts;
}

function bindLobby() {
  app.querySelector('#copyUrl')?.addEventListener('click', async () => {
    const url = app.querySelector('#shareUrl').value;
    try {
      await navigator.clipboard.writeText(url);
      toast('参加用URLをコピーしました。');
    } catch {
      toast('コピーできませんでした。URLを手動でコピーしてください。', 'error');
    }
  });
  app.querySelector('#saveSettings')?.addEventListener('click', async () => {
    await emitAck('updateRoom', collectRoomUpdatePayload());
  });
  app.querySelector('#autoCounts')?.addEventListener('click', async () => {
    await emitAck('autoRoleCounts');
  });
  app.querySelector('#startGame')?.addEventListener('click', async () => {
    const savedSettings = await emitAck('updateRoom', collectRoomUpdatePayload());
    if (savedSettings.ok) await emitAck('startGame');
  });
  app.querySelectorAll('.kick').forEach((button) => {
    button.addEventListener('click', () => emitAck('kickPlayer', { playerId: button.dataset.id }));
  });
}

function bindGame() {
  app.querySelector('#hostNext')?.addEventListener('click', () => emitAck('hostNext'));
  app.querySelector('#resetRoom')?.addEventListener('click', () => emitAck('resetRoom'));
  app.querySelector('#resetRoom2')?.addEventListener('click', () => emitAck('resetRoom'));
  app.querySelector('#submitNight')?.addEventListener('click', () => {
    const targetId = app.querySelector('#nightTarget')?.value;
    emitAck('submitNightAction', { targetId });
  });
  app.querySelector('#submitVote')?.addEventListener('click', () => {
    const targetId = app.querySelector('#voteTarget')?.value;
    emitAck('submitVote', { targetId });
  });
  const sendChat = () => {
    const textInput = app.querySelector('#chatText');
    const channel = app.querySelector('#chatChannel')?.value || 'public';
    const text = textInput?.value || '';
    emitAck('sendMessage', { channel, text }).then((res) => {
      if (res.ok && textInput) textInput.value = '';
    });
  };
  app.querySelector('#sendChat')?.addEventListener('click', sendChat);
  app.querySelector('#chatText')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChat();
  });
}

function updateTimer() {
  const el = document.querySelector('#timer');
  if (!el || !state?.room) return;
  if (!state.room.phaseEndsAt) {
    el.textContent = state.room.gmMode ? 'GM進行' : '--:--';
    el.classList.remove('warn', 'danger');
    return;
  }
  const remaining = state.room.phaseEndsAt - Date.now();
  el.textContent = formatTime(remaining);
  el.classList.toggle('warn', remaining <= 30000 && remaining > 10000);
  el.classList.toggle('danger', remaining <= 10000);
}

socket.on('connect', () => {
  connection.textContent = '接続済み';
  connection.className = 'connection ok';
  const code = qs.get('room');
  if (code && saved.name && saved.playerId) {
    emitAck('joinRoom', { code, name: saved.name, password: saved.password, playerId: saved.playerId });
  } else {
    renderHome();
  }
});

socket.on('disconnect', () => {
  connection.textContent = '切断中';
  connection.className = 'connection ng';
});

socket.on('state', (nextState) => {
  state = nextState;
  if (state?.me) {
    localStorage.setItem('ww_playerId', state.me.id);
    localStorage.setItem('ww_name', state.me.name);
    localStorage.setItem('ww_roomCode', state.room.code);
  }
  render();
});

renderHome();
