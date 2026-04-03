const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const port = process.env.PORT || 3000;
const { v4: uuidv4 } = require('uuid');

app.use(express.static(__dirname + '/public'));

// Serve lobby for root
app.get('/', (req, res) => res.sendFile(__dirname + '/public/lobby.html'));

// Serve game for room URLs
app.get('/room/:roomId', (req, res) => res.sendFile(__dirname + '/public/index.html'));

http.listen(port, () => console.log('listening on port ' + port));

// rooms map: roomId -> room data
const rooms = {};

// ─── Deck helpers ────────────────────────────────────────────────────────────

let baseDeck = Array.apply(null, Array(112)).map((_, i) => i);
baseDeck.splice(56, 1);
baseDeck.splice(69, 1);
baseDeck.splice(82, 1);
baseDeck.splice(95, 1);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

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
    default: return 'Number ' + (num % 14);
  }
}

function cardScore(num) {
  switch (num % 14) {
    case 10: case 11: case 12: return 20;
    case 13: return 50;
    default: return num % 14;
  }
}

// ─── Room creation ────────────────────────────────────────────────────────────

app.post('/api/create-room', express.json(), (req, res) => {
  const maxPlayers = Math.min(4, Math.max(2, parseInt(req.body.maxPlayers) || 2));
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    maxPlayers,
    players: [],       // { id, name, hand, connected }
    deck: [],
    cardOnBoard: null,
    activeColor: null, // tracks color after wild is played
    turn: 0,
    reverse: false,
    started: false,
    reactionHolder: null, // who holds the chemical reaction button
  };
  console.log(`>> Room ${roomId} created (max ${maxPlayers} players)`);
  res.json({ roomId });
});

// ─── Socket logic ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // Join a room by ID
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('joinError', 'Room not found.');
      return;
    }
    if (room.started) {
      socket.emit('joinError', 'Game already started.');
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit('joinError', 'Room is full.');
      return;
    }

    socket.playerName = playerName;
    socket.roomId = roomId;
    socket.join(roomId);

    room.players.push({ id: socket.id, name: playerName, hand: [], connected: true });
    console.log(`>> ${playerName} joined room ${roomId} (${room.players.length}/${room.maxPlayers})`);

    // Notify everyone in room of updated lobby
    io.to(roomId).emit('lobbyUpdate', {
      players: room.players.map(p => ({ name: p.name, id: p.id })),
      maxPlayers: room.maxPlayers,
      roomId,
    });

    // Tell joiner their position
    socket.emit('joinedRoom', {
      roomId,
      playerIndex: room.players.length - 1,
      players: room.players.map(p => ({ name: p.name, id: p.id })),
      maxPlayers: room.maxPlayers,
    });

    // Auto-start when full
    if (room.players.length === room.maxPlayers) {
      setTimeout(() => startGame(roomId), 1500);
    }
  });

  // Host can also manually start if room has >= 2 players
  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.started) return;
    if (room.players.length < 2) {
      socket.emit('joinError', 'Need at least 2 players to start.');
      return;
    }
    startGame(roomId);
  });

  // Draw a card
  socket.on('drawCard', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const currentPlayer = room.players[room.turn];
    if (currentPlayer.id !== socket.id) return;

    const card = drawFromDeck(room);
    currentPlayer.hand.push(card);
    socket.emit('haveCard', currentPlayer.hand);
    io.to(roomId).emit('cardDrawn', { playerIndex: room.turn, playerName: currentPlayer.name });

    advanceTurn(room, roomId);
  });

  // Play a card
  socket.on('playCard', ({ roomId, card, chosenColor }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    const currentPlayer = room.players[room.turn];
    if (currentPlayer.id !== socket.id) return;

    const cardIdx = currentPlayer.hand.indexOf(card);
    if (cardIdx === -1) return;

    const type = cardType(card);
    const color = cardColor(card);
    const boardColor = room.activeColor || cardColor(room.cardOnBoard);
    const boardNumber = room.cardOnBoard % 14;

    // Validate move
    const isWild = color === 'black';
    const colorMatch = color === boardColor;
    const numberMatch = card % 14 === boardNumber;
    const boardWild = boardColor === 'black'; // after wild, activeColor handles it

    if (!isWild && !colorMatch && !numberMatch && !boardWild) return;

    // Remove from hand
    currentPlayer.hand.splice(cardIdx, 1);

    // Update board
    room.cardOnBoard = card;
    room.activeColor = isWild ? (chosenColor || 'red') : color;

    io.to(roomId).emit('cardPlayed', {
      playerIndex: room.turn,
      playerName: currentPlayer.name,
      card,
      activeColor: room.activeColor,
    });

    // Send updated hand to player
    socket.emit('haveCard', currentPlayer.hand);

    // Check win
    if (currentPlayer.hand.length === 0) {
      io.to(roomId).emit('gameOver', { winner: currentPlayer.name });
      room.started = false;
      return;
    }

    // UNO call
    if (currentPlayer.hand.length === 1) {
      io.to(roomId).emit('unoAlert', { playerName: currentPlayer.name });
    }

    // Handle special cards
    if (type === 'Reverse') {
      room.reverse = !room.reverse;
      if (room.players.length === 2) {
        // In 2-player, reverse acts as skip
        advanceTurn(room, roomId);
        advanceTurn(room, roomId);
      } else {
        advanceTurn(room, roomId);
      }
    } else if (type === 'Skip') {
      advanceTurn(room, roomId); // skip next
      advanceTurn(room, roomId);
    } else if (type === 'Draw2') {
      const nextIdx = getNextPlayerIndex(room);
      const nextPlayer = room.players[nextIdx];
      const drawn = [drawFromDeck(room), drawFromDeck(room)];
      drawn.forEach(c => nextPlayer.hand.push(c));
      io.to(nextPlayer.id).emit('haveCard', nextPlayer.hand);
      io.to(roomId).emit('forceDraw', { playerName: nextPlayer.name, count: 2 });
      advanceTurn(room, roomId); // skip them
      advanceTurn(room, roomId);
    } else if (type === 'Draw4') {
      const nextIdx = getNextPlayerIndex(room);
      const nextPlayer = room.players[nextIdx];
      const drawn = [drawFromDeck(room), drawFromDeck(room), drawFromDeck(room), drawFromDeck(room)];
      drawn.forEach(c => nextPlayer.hand.push(c));
      io.to(nextPlayer.id).emit('haveCard', nextPlayer.hand);
      io.to(roomId).emit('forceDraw', { playerName: nextPlayer.name, count: 4 });
      advanceTurn(room, roomId);
      advanceTurn(room, roomId);
    } else {
      advanceTurn(room, roomId);
    }
  });

  // Wild color chosen separately (if needed by UI flow)
  socket.on('chooseColor', ({ roomId, color }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.activeColor = color;
    io.to(roomId).emit('colorChosen', { color, playerName: socket.playerName });
    advanceTurn(room, roomId);
  });

  // ── Chemical Reaction Button ──────────────────────────────────────────────
  socket.on('reactionButton', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.started) return;
    if (room.reactionHolder !== socket.id) return; // only holder can press

    // Shuffle hands randomly among players
    const hands = room.players.map(p => [...p.hand]);
    shuffle(hands);
    room.players.forEach((p, i) => {
      p.hand = hands[i];
      io.to(p.id).emit('haveCard', p.hand);
    });

    // Remove button from this player, don't reassign (one-time use per game, or reassign randomly)
    room.reactionHolder = null;
    io.to(roomId).emit('reactionFired', { playerName: socket.playerName });
    console.log(`>> Chemical Reaction fired by ${socket.playerName} in room ${roomId}`);
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnecting', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      io.to(roomId).emit('playerDisconnect', { playerName: player.name });
      console.log(`>> ${player.name} disconnected from room ${roomId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`>> Socket ${socket.id} disconnected`);
  });
});

// ─── Game helpers ─────────────────────────────────────────────────────────────

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.started || room.players.length < 2) return;
  room.started = true;

  // Fresh deck
  const newDeck = [...baseDeck];
  shuffle(newDeck);
  room.deck = newDeck;

  // Deal 8 cards (QEMY rules) to each player
  room.players.forEach(p => { p.hand = []; });
  for (let i = 0; i < room.players.length * 8; i++) {
    room.players[i % room.players.length].hand.push(drawFromDeck(room));
  }

  // Starting card (no blacks)
  let startCard;
  do {
    startCard = drawFromDeck(room);
  } while (cardColor(startCard) === 'black');
  room.cardOnBoard = startCard;
  room.activeColor = cardColor(startCard);
  room.turn = 0;
  room.reverse = false;

  // Assign reaction button to a random player
  room.reactionHolder = room.players[Math.floor(Math.random() * room.players.length)].id;

  console.log(`>> Game started in room ${roomId} with ${room.players.length} players`);

  // Send each player their hand
  room.players.forEach((p, i) => {
    io.to(p.id).emit('haveCard', p.hand);
    io.to(p.id).emit('reactionButton', { hasButton: room.reactionHolder === p.id });
  });

  io.to(roomId).emit('gameStart', {
    players: room.players.map(p => ({ name: p.name, id: p.id, handSize: p.hand.length })),
    cardOnBoard: room.cardOnBoard,
    activeColor: room.activeColor,
    currentTurn: room.players[room.turn].id,
    reactionHolder: room.reactionHolder,
  });
}

function drawFromDeck(room) {
  if (room.deck.length === 0) {
    // Reshuffle all but top card
    const top = room.cardOnBoard;
    room.deck = [...baseDeck].filter(c => c !== top);
    shuffle(room.deck);
  }
  return parseInt(room.deck.shift());
}

function getNextPlayerIndex(room) {
  const step = room.reverse ? -1 : 1;
  return (room.turn + step + room.players.length) % room.players.length;
}

function advanceTurn(room, roomId) {
  room.turn = getNextPlayerIndex(room);
  io.to(roomId).emit('turnChanged', {
    currentTurn: room.players[room.turn].id,
    playerName: room.players[room.turn].name,
    playerIndex: room.turn,
  });
}
