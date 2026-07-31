const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// Game state per room
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// 26種類のキャラ × 4枚 = 104枚
function createDeck() {
  const deck = [];
  for (let tile = 0; tile < 26; tile++) {
    for (let copy = 0; copy < 4; copy++) {
      deck.push({ tile, id: tile * 4 + copy });
    }
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function initGame() {
  const deck = createDeck();
  return {
    deck,
    deckIndex: 26, // 最初に各13枚配る
    hands: {
      0: deck.slice(0, 13).map(t => t.id),
      1: deck.slice(13, 26).map(t => t.id),
    },
    discards: { 0: [], 1: [] },
    currentTurn: 0,
    drawnTile: null,
    lastDiscard: null,
    lastDiscardPlayer: null,
    callPending: null, // { type, player }
    riichi: { 0: false, 1: false },
    started: true,
  };
}

function getTileFromId(id) {
  return Math.floor(id / 4); // tile index 0-25
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('create_room', () => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      players: [socket.id],
      playerIndex: { [socket.id]: 0 },
      game: null,
      spectators: [],
    };
    socket.join(code);
    socket.emit('room_created', { code, playerIndex: 0 });
    console.log('Room created:', code);
  });

  socket.on('join_room', async ({ code }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('error', { message: 'ルームが見つかりません' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'ルームが満員です' });
      return;
    }
    room.players.push(socket.id);
    room.playerIndex[socket.id] = 1;
    await socket.join(code);
    socket.emit('room_joined', { code, playerIndex: 1 });
    // 2人揃ったら即ゲーム開始（start_gameイベント不要）
    room.game = initGame();
    const g = room.game;
    room.players.forEach((pid, idx) => {
      io.to(pid).emit('game_start', {
        myHand: g.hands[idx].map(id => ({ id, tile: getTileFromId(id) })),
        opponentCount: g.hands[1 - idx].length,
        currentTurn: g.currentTurn,
        myIndex: idx,
        deckRemaining: g.deck.length - g.deckIndex,
      });
    });
    console.log('Game started in room:', code);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.players.length < 2) return;
    room.game = initGame();
    
    // Send each player their own hand
    room.players.forEach((pid, idx) => {
      const g = room.game;
      io.to(pid).emit('game_start', {
        myHand: g.hands[idx].map(id => ({ id, tile: getTileFromId(id) })),
        opponentCount: g.hands[1 - idx].length,
        currentTurn: g.currentTurn,
        myIndex: idx,
        deckRemaining: g.deck.length - g.deckIndex,
      });
    });
    console.log('Game started in room:', code);
  });

  socket.on('draw_tile', ({ code }) => {
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    const myIdx = room.playerIndex[socket.id];
    if (g.currentTurn !== myIdx) return;
    if (g.drawnTile !== null) return;
    if (g.deckIndex >= g.deck.length) {
      io.to(code).emit('game_over', { reason: '流局' });
      return;
    }
    const drawn = g.deck[g.deckIndex++];
    g.drawnTile = drawn.id;
    g.hands[myIdx].push(drawn.id);

    socket.emit('tile_drawn', {
      tile: { id: drawn.id, tile: getTileFromId(drawn.id) },
      deckRemaining: g.deck.length - g.deckIndex,
    });
    // Tell opponent a tile was drawn (not which tile)
    const opponentId = room.players[1 - myIdx];
    io.to(opponentId).emit('opponent_drew', { deckRemaining: g.deck.length - g.deckIndex });
  });

  socket.on('discard_tile', ({ code, tileId }) => {
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    const myIdx = room.playerIndex[socket.id];
    if (g.currentTurn !== myIdx) return;

    // Remove from hand
    const idx = g.hands[myIdx].indexOf(tileId);
    if (idx === -1) return;
    g.hands[myIdx].splice(idx, 1);
    g.discards[myIdx].push(tileId);
    g.drawnTile = null;
    g.lastDiscard = tileId;
    g.lastDiscardPlayer = myIdx;

    // Notify both players
    io.to(code).emit('tile_discarded', {
      player: myIdx,
      tileId,
      tile: getTileFromId(tileId),
      discards: {
        0: g.discards[0].map(id => ({ id, tile: getTileFromId(id) })),
        1: g.discards[1].map(id => ({ id, tile: getTileFromId(id) })),
      },
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length },
    });

    // Switch turn
    g.currentTurn = 1 - myIdx;
    io.to(code).emit('turn_changed', { currentTurn: g.currentTurn });
  });

  socket.on('call_action', ({ code, action }) => {
    // action: 'pon', 'chi', 'kan', 'riichi', 'ron', 'tsumo', 'skip'
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    const myIdx = room.playerIndex[socket.id];

    if (action === 'riichi') {
      g.riichi[myIdx] = true;
    }

    io.to(code).emit('action_called', {
      player: myIdx,
      action,
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length },
    });

    if (action === 'pon' || action === 'chi' || action === 'kan') {
      // Add last discard to caller's hand (they'll discard manually)
      if (g.lastDiscard !== null && g.lastDiscardPlayer !== myIdx) {
        g.hands[myIdx].push(g.lastDiscard);
        // Remove from opponent's discards
        const oppDiscards = g.discards[g.lastDiscardPlayer];
        const dIdx = oppDiscards.lastIndexOf(g.lastDiscard);
        if (dIdx !== -1) oppDiscards.splice(dIdx, 1);
        
        // Update caller's hand
        socket.emit('hand_updated', {
          myHand: g.hands[myIdx].map(id => ({ id, tile: getTileFromId(id) })),
          discards: {
            0: g.discards[0].map(id => ({ id, tile: getTileFromId(id) })),
            1: g.discards[1].map(id => ({ id, tile: getTileFromId(id) })),
          },
        });
        
        g.currentTurn = myIdx;
        io.to(code).emit('turn_changed', { currentTurn: myIdx });
      }
    }
  });


  // 公開: 相手に牌を見せる
  socket.on('reveal_tiles', ({ code, tiles }) => {
    const room = rooms[code];
    if (!room || !room.game) return;
    const myIdx = room.playerIndex[socket.id];
    io.to(code).emit('tiles_revealed', { player: myIdx, tiles });
  });

  // 相手の捨て牌を手牌に取る
  socket.on('take_opp_discard', ({ code, tileId }) => {
    const room = rooms[code];
    if (!room || !room.game) return;
    const g = room.game;
    const myIdx = room.playerIndex[socket.id];
    const oppIdx = 1 - myIdx;
    const di = g.discards[oppIdx].lastIndexOf(tileId);
    if (di === -1) return;
    g.discards[oppIdx].splice(di, 1);
    g.hands[myIdx].push(tileId);
    socket.emit('opp_discard_taken', {
      tileId,
      tile: getTileFromId(tileId),
      discards: {
        0: g.discards[0].map(id => ({ id, tile: getTileFromId(id) })),
        1: g.discards[1].map(id => ({ id, tile: getTileFromId(id) })),
      },
      handCounts: { 0: g.hands[0].length, 1: g.hands[1].length },
    });
  });

  socket.on('reset_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.game = initGame();
    const g = room.game;
    
    room.players.forEach((pid, idx) => {
      io.to(pid).emit('game_start', {
        myHand: g.hands[idx].map(id => ({ id, tile: getTileFromId(id) })),
        opponentCount: g.hands[1 - idx].length,
        currentTurn: g.currentTurn,
        myIndex: idx,
        deckRemaining: g.deck.length - g.deckIndex,
      });
    });
  });

  socket.on('disconnect', () => {
    // Notify rooms
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players.includes(socket.id)) {
        io.to(code).emit('player_left');
        // Clean up after a delay
        setTimeout(() => {
          if (rooms[code]) delete rooms[code];
        }, 60000);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`麻雀サーバー起動中: http://localhost:${PORT}`);
});
