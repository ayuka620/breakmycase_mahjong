const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createDeck() {
  const deck = [];
  for (let tile = 0; tile < 26; tile++)
    for (let copy = 0; copy < 4; copy++)
      deck.push({ tile, id: tile * 4 + copy });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getTile(id) { return Math.floor(id / 4); }

function initGame() {
  const deck = createDeck();
  // Player0は14枚（13+ツモ済み1枚）、Player1は13枚
  // drawnTileIdはPlayer0の14枚目
  return {
    deck,
    deckIndex: 27,
    hands: {
      0: deck.slice(0, 14).map(t => t.id),
      1: deck.slice(14, 27).map(t => t.id),
    },
    discards: { 0: [], 1: [] },
    currentTurn: 0,
    drawnTileId: deck[13].id, // Player0の最初のツモ牌
    lastDiscard: null,
    lastDiscardPlayer: null,
  };
}

function sendStart(room) {
  const g = room.game;
  room.players.forEach((pid, idx) => {
    io.to(pid).emit('game_start', {
      myHand: g.hands[idx].map(id => ({ id, tile: getTile(id) })),
      opponentCount: g.hands[1 - idx].length,
      currentTurn: g.currentTurn,
      myIndex: idx,
      deckRemaining: g.deck.length - g.deckIndex,
      drawnTileId: idx === 0 ? g.drawnTileId : null,
    });
  });
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', () => {
    const code = generateRoomCode();
    rooms[code] = { code, players: [socket.id], playerIndex: { [socket.id]: 0 }, game: null };
    socket.join(code);
    socket.emit('room_created', { code, playerIndex: 0 });
    console.log('Room created:', code);
  });

  socket.on('join_room', async ({ code }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', { message: 'ルームが見つかりません' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { message: 'ルームが満員です' }); return; }
    room.players.push(socket.id);
    room.playerIndex[socket.id] = 1;
    await socket.join(code);
    room.game = initGame();
    console.log('Game started:', code);
    sendStart(room);
  });

  socket.on('discard_tile', ({ code, tileId }) => {
    const room = rooms[code];
    if (!room?.game) return;
    const g = room.game;
    const me = room.playerIndex[socket.id];
    if (g.currentTurn !== me) return;

    const idx = g.hands[me].indexOf(tileId);
    if (idx === -1) return;
    g.hands[me].splice(idx, 1);
    g.discards[me].push(tileId);
    g.lastDiscard = tileId;
    g.lastDiscardPlayer = me;

    const opp = 1 - me;

    // 相手に次のツモ牌を配る
    if (g.deckIndex >= g.deck.length) {
      io.to(code).emit('game_over', { reason: '流局' });
      return;
    }
    const drawn = g.deck[g.deckIndex++];
    g.hands[opp].push(drawn.id);
    g.drawnTileId = drawn.id;
    g.currentTurn = opp;

    // 自分の捨て牌を両者に通知
    io.to(code).emit('tile_discarded', {
      player: me,
      tileId,
      discards: {
        0: g.discards[0].map(id => ({ id, tile: getTile(id) })),
        1: g.discards[1].map(id => ({ id, tile: getTile(id) })),
      },
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length },
    });

    // 相手にツモ牌を通知
    const oppId = room.players[opp];
    io.to(oppId).emit('tile_drawn', {
      tile: { id: drawn.id, tile: getTile(drawn.id) },
      deckRemaining: g.deck.length - g.deckIndex,
    });
    // ターン変更
    io.to(code).emit('turn_changed', { currentTurn: opp });
  });

  socket.on('call_action', ({ code, action }) => {
    const room = rooms[code];
    if (!room?.game) return;
    const g = room.game;
    const me = room.playerIndex[socket.id];
    io.to(code).emit('action_called', { player: me, action,
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length } });
  });

  socket.on('reveal_tiles', ({ code, tiles }) => {
    const room = rooms[code];
    if (!room?.game) return;
    const me = room.playerIndex[socket.id];
    io.to(code).emit('tiles_revealed', { player: me, tiles });
  });

  socket.on('take_opp_discard', ({ code, tileId }) => {
    const room = rooms[code];
    if (!room?.game) return;
    const g = room.game;
    const me = room.playerIndex[socket.id];
    const opp = 1 - me;
    const di = g.discards[opp].lastIndexOf(tileId);
    if (di === -1) return;
    g.discards[opp].splice(di, 1);
    g.hands[me].push(tileId);
    g.drawnTileId = tileId;
    g.currentTurn = me;
    socket.emit('opp_discard_taken', {
      tileId, tile: getTile(tileId),
      discards: {
        0: g.discards[0].map(id => ({ id, tile: getTile(id) })),
        1: g.discards[1].map(id => ({ id, tile: getTile(id) })),
      },
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length },
    });
  });

  socket.on('reset_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.game = initGame();
    sendStart(room);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      if (rooms[code].players.includes(socket.id)) {
        io.to(code).emit('player_left');
        setTimeout(() => { delete rooms[code]; }, 60000);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`起動: http://localhost:${PORT}`));
