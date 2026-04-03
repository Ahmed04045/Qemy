// ── State ────────────────────────────────────────────────────────────────────
const socket = io();
const roomId = window.location.pathname.split('/room/')[1];
const playerName = sessionStorage.getItem('playerName') || 'Player';

let myIndex = -1;
let myHand = [];
let players = [];       // { name, id, handSize }
let myTurn = false;
let activeColor = null;
let pendingWildCard = null; // card waiting for color choice
let hasReactionBtn = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const lobbyScreen   = document.getElementById('lobbyScreen');
const gameScreen    = document.getElementById('gameScreen');
const myHandEl      = document.getElementById('myHand');
const myLabelEl     = document.getElementById('myLabel');
const topZone       = document.getElementById('topZone');
const leftZone      = document.getElementById('leftZone');
const rightZone     = document.getElementById('rightZone');
const turnBanner    = document.getElementById('turnBanner');
const boardCardInner= document.getElementById('boardCardInner');
const activeColorDot= document.getElementById('activeColorDot');
const reactionBtn   = document.getElementById('reactionBtn');
const colorChooser  = document.getElementById('colorChooser');
const toastContainer= document.getElementById('toastContainer');
const gameOverlay   = document.getElementById('gameOverlay');

// ── Init lobby ────────────────────────────────────────────────────────────────
document.getElementById('shareUrl').textContent = window.location.href;
document.getElementById('roomTag').textContent = 'ROOM ' + roomId;

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  showToast('Link copied!', 'orange-border');
}

function requestEarlyStart() {
  socket.emit('startGame', { roomId });
}

// ── Join room on connect ──────────────────────────────────────────────────────
socket.on('connect', () => {
  socket.emit('joinRoom', { roomId, playerName });
});

socket.on('joinError', (msg) => {
  alert(msg);
  window.location.href = '/';
});

socket.on('joinedRoom', ({ playerIndex, players: pl, maxPlayers }) => {
  myIndex = playerIndex;
  players = pl;
  myLabelEl.textContent = playerName;
  updateLobbyPlayers(pl, maxPlayers);

  // Show "start early" button to host (index 0) once 2+ players
  if (myIndex === 0 && pl.length >= 2) {
    document.getElementById('startEarlyBtn').style.display = 'block';
  }
});

socket.on('lobbyUpdate', ({ players: pl, maxPlayers }) => {
  players = pl;
  updateLobbyPlayers(pl, maxPlayers);
  if (myIndex === 0 && pl.length >= 2) {
    document.getElementById('startEarlyBtn').style.display = 'block';
  }
});

function updateLobbyPlayers(pl, maxPlayers) {
  const container = document.getElementById('waitingPlayers');
  container.innerHTML = '';
  pl.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'waiting-player-chip';
    chip.textContent = p.name;
    container.appendChild(chip);
  });
  const msg = document.getElementById('waitingMsg');
  msg.textContent = `${pl.length} / ${maxPlayers} players joined`;
}

// ── Game start ────────────────────────────────────────────────────────────────
socket.on('gameStart', ({ players: pl, cardOnBoard, activeColor: ac, currentTurn, reactionHolder }) => {
  players = pl;
  activeColor = ac;
  hasReactionBtn = (reactionHolder === socket.id);

  // Transition screens
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');

  // Setup layout based on player count
  setupLayout(pl);

  // Show board card
  renderBoardCard(cardOnBoard, ac);

  // Reaction button
  if (hasReactionBtn) {
    reactionBtn.classList.remove('hidden');
  }

  // Initial turn
  handleTurnChanged(currentTurn);
});

// ── Layout setup ──────────────────────────────────────────────────────────────
function setupLayout(pl) {
  const count = pl.length;

  // Clear zones
  topZone.innerHTML = '';
  leftZone.innerHTML = '';
  rightZone.innerHTML = '';

  // 2 players: top = opponent
  // 3 players: top = opponent[1], left = opponent[2]
  // 4 players: top = opposite, left = left, right = right
  // "me" is always index myIndex; opponents are relative to that

  const opponents = getOpponentLayout(pl, count);

  // Top
  if (opponents.top) {
    topZone.appendChild(makeOppZone(opponents.top.name, opponents.top.index, 'horizontal'));
  }

  // Left
  if (opponents.left) {
    leftZone.classList.remove('hidden');
    leftZone.appendChild(makeOppZone(opponents.left.name, opponents.left.index, 'vertical'));
  }

  // Right
  if (opponents.right) {
    rightZone.classList.remove('hidden');
    rightZone.appendChild(makeOppZone(opponents.right.name, opponents.right.index, 'vertical'));
  }

  myLabelEl.textContent = playerName;
}

function getOpponentLayout(pl, count) {
  // Build opponent list relative to my seat
  const opps = [];
  for (let i = 1; i < count; i++) {
    const idx = (myIndex + i) % count;
    opps.push({ name: pl[idx].name, index: idx });
  }

  if (count === 2) return { top: opps[0] };
  if (count === 3) return { top: opps[0], left: opps[1] };
  if (count === 4) return { left: opps[0], top: opps[1], right: opps[2] };
  return {};
}

function makeOppZone(name, playerIdx, direction) {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = direction === 'vertical' ? 'column' : 'column';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '6px';

  const label = document.createElement('div');
  label.className = 'opp-label';
  label.id = `opp-label-${playerIdx}`;
  label.textContent = name;

  const handEl = document.createElement('div');
  handEl.className = 'opp-hand';
  handEl.id = `opp-hand-${playerIdx}`;
  if (direction === 'vertical') {
    handEl.style.flexDirection = 'column';
  }

  const badge = document.createElement('div');
  badge.className = 'card-count-badge';
  badge.id = `opp-count-${playerIdx}`;
  badge.textContent = '8 cards';

  wrap.appendChild(label);
  wrap.appendChild(handEl);
  wrap.appendChild(badge);
  return wrap;
}

// ── Receive own hand ──────────────────────────────────────────────────────────
socket.on('haveCard', (hand) => {
  const prevLen = myHand.length;
  myHand = hand;
  renderMyHand(hand, prevLen < hand.length);
});

function renderMyHand(hand, isNew) {
  myHandEl.innerHTML = '';
  hand.forEach((cardNum, i) => {
    const cardEl = makeCardFront(cardNum);
    cardEl.dataset.card = cardNum;
    if (isNew && i === hand.length - 1) {
      cardEl.classList.add('dealing');
    } else {
      cardEl.classList.add('dealing');
      cardEl.style.animationDelay = `${i * 40}ms`;
    }

    // Mark playable
    if (myTurn && isPlayable(cardNum)) {
      cardEl.classList.add('playable');
    }

    cardEl.addEventListener('click', () => onPlayCard(cardNum));
    myHandEl.appendChild(cardEl);
  });
}

function isPlayable(cardNum) {
  const type = cardType(cardNum);
  const color = cardColor(cardNum);
  if (color === 'black') return true;
  if (color === activeColor) return true;
  // number match against board uses activeColor
  return false;
}

function onPlayCard(cardNum) {
  if (!myTurn) return;
  const color = cardColor(cardNum);
  if (color === 'black') {
    // Need color choice
    pendingWildCard = cardNum;
    colorChooser.classList.remove('hidden');
  } else {
    if (!isPlayable(cardNum)) return;
    animateCardPlay(cardNum);
    socket.emit('playCard', { roomId, card: cardNum });
  }
}

function pickColor(color) {
  colorChooser.classList.add('hidden');
  if (pendingWildCard !== null) {
    animateCardPlay(pendingWildCard);
    socket.emit('playCard', { roomId, card: pendingWildCard, chosenColor: color });
    pendingWildCard = null;
  }
}

function animateCardPlay(cardNum) {
  const cardEl = myHandEl.querySelector(`[data-card="${cardNum}"]`);
  if (cardEl) {
    cardEl.classList.add('playing');
    setTimeout(() => cardEl.remove(), 350);
  }
}

function onDrawCard() {
  if (!myTurn) return;
  socket.emit('drawCard', { roomId });
  // Pulse animation on deck
  const deck = document.getElementById('deckPile');
  deck.style.animation = 'none';
  void deck.offsetWidth;
  deck.style.animation = 'drawPulse 0.5s ease';
}

// ── Board card ────────────────────────────────────────────────────────────────
socket.on('cardPlayed', ({ playerIndex, playerName: pn, card, activeColor: ac }) => {
  activeColor = ac;
  renderBoardCard(card, ac);
  updateOppHandSize(playerIndex, -1);
  showToast(`${pn} played a card`, '');

  // Update color dot
  updateColorDot(ac);
});

socket.on('cardDrawn', ({ playerIndex, playerName: pn }) => {
  if (playerIndex !== myIndex) {
    updateOppHandSize(playerIndex, 1);
    showToast(`${pn} drew a card`, '');
  }
});

socket.on('forceDraw', ({ playerName: pn, count }) => {
  showToast(`${pn} draws ${count} cards! 😬`, 'red-border');
  // If it's me, hand update comes via haveCard event
});

function renderBoardCard(cardNum, color) {
  const front = makeCardFront(cardNum);
  front.classList.add('playing');
  boardCardInner.innerHTML = '';
  boardCardInner.appendChild(front);

  // Active color dot
  updateColorDot(color || cardColor(cardNum));
}

function updateColorDot(color) {
  activeColorDot.classList.remove('hidden');
  const colorMap = {
    red: '#e63946', yellow: '#f4c430',
    green: '#2a9d8f', blue: '#457b9d', black: '#333'
  };
  activeColorDot.style.background = colorMap[color] || '#333';
}

// ── Opponent hand rendering ───────────────────────────────────────────────────
function renderOppHand(playerIndex, count) {
  const handEl = document.getElementById(`opp-hand-${playerIndex}`);
  const countEl = document.getElementById(`opp-count-${playerIndex}`);
  if (!handEl) return;

  handEl.innerHTML = '';
  const max = Math.min(count, 14); // cap visual cards
  for (let i = 0; i < max; i++) {
    const card = document.createElement('div');
    card.className = 'opp-card sliding';
    card.style.animationDelay = `${i * 30}ms`;
    handEl.appendChild(card);
  }
  if (countEl) {
    countEl.textContent = count === 1 ? '1 card — UNO!' : `${count} cards`;
    countEl.className = count === 1 ? 'uno-badge' : 'card-count-badge';
  }
}

function updateOppHandSize(playerIndex, delta) {
  const countEl = document.getElementById(`opp-count-${playerIndex}`);
  if (!countEl) return;
  const cur = parseInt(countEl.textContent) || 0;
  const next = Math.max(0, cur + delta);
  renderOppHand(playerIndex, next);
}

// ── Game start — set initial opp hands ───────────────────────────────────────
socket.on('gameStart', ({ players: pl }) => {
  // Set all opponents to 8 cards
  pl.forEach((p, i) => {
    if (i !== myIndex) renderOppHand(i, 8);
  });
});

// ── Turn handling ─────────────────────────────────────────────────────────────
socket.on('turnChanged', ({ currentTurn, playerName: pn, playerIndex }) => {
  handleTurnChanged(currentTurn, pn);
});

function handleTurnChanged(currentTurnSocketId, pn) {
  myTurn = (currentTurnSocketId === socket.id);

  if (myTurn) {
    turnBanner.textContent = 'Your turn';
    turnBanner.classList.add('my-turn');
    // Highlight playable cards
    myHandEl.querySelectorAll('.card').forEach(cardEl => {
      const cn = parseInt(cardEl.dataset.card);
      if (isPlayable(cn)) cardEl.classList.add('playable');
      else cardEl.classList.remove('playable');
    });
  } else {
    turnBanner.textContent = `${pn || '...'}'s turn`;
    turnBanner.classList.remove('my-turn');
    myHandEl.querySelectorAll('.card').forEach(c => c.classList.remove('playable'));
  }
}

// ── UNO alert ────────────────────────────────────────────────────────────────
socket.on('unoAlert', ({ playerName: pn }) => {
  showToast(`${pn} has UNO! 🔴`, 'red-border');
});

// ── Color chosen (by opponent) ────────────────────────────────────────────────
socket.on('colorChosen', ({ color, playerName: pn }) => {
  activeColor = color;
  updateColorDot(color);
  showToast(`${pn} chose ${color}`, '');
});

// ── Chemical Reaction ─────────────────────────────────────────────────────────
socket.on('reactionButton', ({ hasButton }) => {
  hasReactionBtn = hasButton;
  if (hasButton) reactionBtn.classList.remove('hidden');
  else reactionBtn.classList.add('hidden');
});

socket.on('reactionFired', ({ playerName: pn }) => {
  // Shake all hands
  myHandEl.classList.add('shake');
  setTimeout(() => myHandEl.classList.remove('shake'), 500);
  showToast(`⚗️ ${pn} triggered a Chemical Reaction! Hands swapped!`, 'purple-border');
  reactionBtn.classList.add('hidden');
});

function fireReaction() {
  if (!hasReactionBtn) return;
  socket.emit('reactionButton', { roomId });
  hasReactionBtn = false;
}

// ── Disconnect ────────────────────────────────────────────────────────────────
socket.on('playerDisconnect', ({ playerName: pn }) => {
  showToast(`${pn} left the game`, 'red-border');
});

// ── Game over ─────────────────────────────────────────────────────────────────
socket.on('gameOver', ({ winner }) => {
  const isMe = winner === playerName;
  document.getElementById('goEmoji').textContent = isMe ? '🏆' : '😢';
  document.getElementById('goTitle').textContent = isMe ? 'You Win!' : 'Game Over';
  document.getElementById('goName').textContent = isMe ? '' : `${winner} wins`;
  gameOverlay.classList.remove('hidden');
});

// ── Card helpers ──────────────────────────────────────────────────────────────
function cardColor(num) {
  if (num % 14 === 13) return 'black';
  switch (Math.floor(num / 14)) {
    case 0: case 4: return 'red';
    case 1: case 5: return 'yellow';
    case 2: case 6: return 'green';
    case 3: case 7: return 'blue';
  }
}

function cardType(num) {
  switch (num % 14) {
    case 10: return 'Skip';
    case 11: return 'Reverse';
    case 12: return 'Draw2';
    case 13: return Math.floor(num / 14) >= 4 ? 'Draw4' : 'Wild';
    default: return 'Number';
  }
}

function cardLabel(num) {
  const t = num % 14;
  switch (t) {
    case 10: return '⊘';   // Skip
    case 11: return '⇄';   // Reverse
    case 12: return '+2';
    case 13: return Math.floor(num / 14) >= 4 ? '+4' : '★';
    default: return String(t);
  }
}

function makeCardFront(num) {
  const color = cardColor(num);
  const label = cardLabel(num);

  const card = document.createElement('div');
  card.className = `card card-front card-${color}`;

  const tl = document.createElement('div');
  tl.className = 'card-top-left';
  tl.textContent = label;

  const num2 = document.createElement('div');
  num2.className = 'card-number';
  num2.textContent = label;

  const br = document.createElement('div');
  br.className = 'card-bot-right';
  br.textContent = label;

  card.appendChild(tl);
  card.appendChild(num2);
  card.appendChild(br);
  return card;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, cls) {
  const toast = document.createElement('div');
  toast.className = `toast ${cls}`;
  toast.textContent = msg;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}
