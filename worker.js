// Complete Backend for Skyjo Pro (Cloudflare Worker + Durable Objects)

function createDeck() {
  const d = [];
  for(let i=0; i<5; i++) d.push(-2);
  for(let i=0; i<10; i++) d.push(-1);
  for(let i=0; i<15; i++) d.push(0);
  for(let v=1; v<=12; v++) { for(let i=0; i<10; i++) d.push(v); }
  for(let i=d.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

class GameEngine {
  constructor(names) {
    this.players = names.map(n => ({ name: n, board: Array.from({length: 12}, () => ({ value: 0, revealed: false, cleared: false })), roundScore: 0, totalScore: 0, revealCount: 0 }));
    this.deck = []; this.discard = []; this.phase = 'LOBBY'; this.round = 1; this.currentPlayer = 0;
    this.roundEnder = -1; this.finalTurnsLeft = 0; this.drawnCard = null; this.turnAction = null;
    this.tiebreakerPlayers = []; this.lastAction = null; this.pendingTransition = null;
  }
  start() {
    this.deck = createDeck();
    for (const p of this.players) { for (const c of p.board) { c.value = this.deck.pop(); c.revealed = false; c.cleared = false; } p.revealCount = 0; p.roundScore = 0; }
    this.discard = [this.deck.pop()]; this.phase = 'REVEAL'; this.roundEnder = -1; this.finalTurnsLeft = 0;
    this.currentPlayer = 0; this.drawnCard = null; this.turnAction = null; this.tiebreakerPlayers = []; this.lastAction = null; this.pendingTransition = null;
  }
  nextRound() {
    if (this.phase === 'GAME_OVER') {
      for (const p of this.players) p.totalScore = 0;
      this.round = 1;
    } else {
      this.round++;
    }
    this.deck = createDeck();
    for (const p of this.players) { for (const c of p.board) { c.value = this.deck.pop(); c.revealed = false; c.cleared = false; } p.revealCount = 0; p.roundScore = 0; }
    this.discard = [this.deck.pop()]; this.phase = 'REVEAL'; this.roundEnder = -1; this.finalTurnsLeft = 0;
    this.currentPlayer = 0; this.drawnCard = null; this.turnAction = null; this.tiebreakerPlayers = []; this.lastAction = null; this.pendingTransition = null;
  }
  revealInitial(playerIndex, cardIndex) {
    if (this.phase !== 'REVEAL') return false;
    const p = this.players[playerIndex]; if (p.revealCount >= 2) return false;
    const c = p.board[cardIndex]; if (c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++; this.lastAction = { type: 'reveal', player: playerIndex, card: cardIndex, value: c.value };
    if (this.players.every(pl => pl.revealCount >= 2)) this.determineStarter();
    return true;
  }
  determineStarter() {
    const sums = this.players.map((p, i) => ({ i, sum: p.board.filter(c => c.revealed && !c.cleared).reduce((a, c) => a + c.value, 0) }));
    const max = Math.max(...sums.map(s => s.sum)); const tied = sums.filter(s => s.sum === max).map(s => s.i);
    this.turnAction = 'turn_end_delay';
    this.pendingTransition = { type: 'starter', tied };
  }
  revealTiebreaker(playerIndex, cardIndex) {
    if (!this.tiebreakerPlayers.includes(playerIndex)) return false;
    const p = this.players[playerIndex]; if (p.revealCount >= 2) return false;
    const c = p.board[cardIndex]; if (c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++; this.lastAction = { type: 'reveal', player: playerIndex, card: cardIndex, value: c.value };
    if (this.tiebreakerPlayers.every(i => this.players[i].revealCount >= 2)) {
      const sums = this.tiebreakerPlayers.map(i => ({ i, sum: this.players[i].board.filter(c => c.revealed && !c.cleared).reduce((a, c) => a + c.value, 0) }));
      const max = Math.max(...sums.map(s => s.sum)); const stillTied = sums.filter(s => s.sum === max).map(s => s.i);
      this.turnAction = 'turn_end_delay';
      this.pendingTransition = { type: 'starter', tied: stillTied };
    }
    return true;
  }
  drawDeck(playerIndex) {
    if (this.phase !== 'PLAY' && this.phase !== 'FINAL_TURNS') return null;
    if (this.currentPlayer !== playerIndex || this.turnAction !== null) return null;
    if (this.deck.length === 0) {
      this.deck = this.discard.slice(0, -1); this.discard = [this.discard[this.discard.length - 1]];
      for(let i=this.deck.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]]; }
    }
    this.drawnCard = this.deck.pop(); this.turnAction = 'deck'; return this.drawnCard;
  }
  takeDiscard(playerIndex) {
    if (this.phase !== 'PLAY' && this.phase !== 'FINAL_TURNS') return false;
    if (this.currentPlayer !== playerIndex || this.turnAction !== null) return false;
    if (this.discard.length === 0) return false;
    this.drawnCard = this.discard.pop(); this.turnAction = 'discard'; return true;
  }
  swap(playerIndex, boardIndex) {
    if (this.phase !== 'PLAY' && this.phase !== 'FINAL_TURNS') return false;
    if (this.currentPlayer !== playerIndex || this.turnAction === null) return false;
    const p = this.players[playerIndex]; const oldCard = p.board[boardIndex];
    if (oldCard.cleared) return false;
    const wasRevealed = oldCard.revealed; const oldVal = oldCard.value;
    this.discard.push(oldCard.value);
    p.board[boardIndex] = { value: this.drawnCard, revealed: true, cleared: false };
    const diff = wasRevealed ? (oldVal - this.drawnCard) : null;
    this.lastAction = { type: 'swap', player: playerIndex, index: boardIndex, good: wasRevealed ? (diff > 0) : null, diff, oldVal, wasRevealed };
    this.endTurn(); return true;
  }
  discardDrawnCard(playerIndex) {
    if (this.phase !== 'PLAY' && this.phase !== 'FINAL_TURNS') return false;
    if (this.currentPlayer !== playerIndex || this.turnAction !== 'deck') return false;
    this.discard.push(this.drawnCard);
    this.drawnCard = null;
    this.turnAction = 'must_reveal';
    this.lastAction = { type: 'discard_drawn', player: playerIndex };
    return true;
  }
  revealAfterDiscard(playerIndex, boardIndex) {
    if (this.phase !== 'PLAY' && this.phase !== 'FINAL_TURNS') return false;
    if (this.currentPlayer !== playerIndex || this.turnAction !== 'must_reveal') return false;
    const p = this.players[playerIndex];
    const targetCard = p.board[boardIndex];
    if (targetCard.revealed || targetCard.cleared) return false;
    
    targetCard.revealed = true;
    this.lastAction = { type: 'reveal_after_discard', player: playerIndex, index: boardIndex, value: targetCard.value };
    this.endTurn();
    return true;
  }
  checkTriplets(playerIndex) {
    const p = this.players[playerIndex]; let clearedAny = false;
    for (let col = 0; col < 4; col++) {
      const idxs = [col, col+4, col+8]; const cards = idxs.map(i => p.board[i]);
      if (cards.every(c => c.revealed && !c.cleared) && cards[0].value === cards[1].value && cards[1].value === cards[2].value) {
        idxs.forEach(i => p.board[i].cleared = true); for(let i=0; i<3; i++) this.discard.push(cards[0].value);
        clearedAny = true; this.lastAction = { type: 'triplet', player: playerIndex, value: cards[0].value, indices: idxs };
      }
    }
    return clearedAny;
  }
  endTurn() {
    this.checkTriplets(this.currentPlayer);
    this.drawnCard = null; this.turnAction = 'turn_end_delay';
  }
  completeTurnEnd() {
    if (this.turnAction !== 'turn_end_delay') return;
    this.turnAction = null;

    if (this.pendingTransition) {
      const tied = this.pendingTransition.tied;
      if (tied.length === 1) { this.currentPlayer = tied[0]; this.phase = 'PLAY'; this.lastAction = { type: 'starter', player: tied[0] }; this.tiebreakerPlayers = []; }
      else { this.tiebreakerPlayers = tied; for (const i of tied) this.players[i].revealCount = 1; }
      this.pendingTransition = null;
      return;
    }

    const p = this.players[this.currentPlayer];
    if (p.board.every(c => c.cleared || c.revealed) && this.phase === 'PLAY') {
      this.phase = 'FINAL_TURNS'; this.roundEnder = this.currentPlayer; this.finalTurnsLeft = this.players.length - 1;
      this.lastAction = { type: 'last_round', player: this.currentPlayer };
    }
    if (this.phase === 'FINAL_TURNS') {
      if (this.currentPlayer !== this.roundEnder) this.finalTurnsLeft--;
      if (this.finalTurnsLeft <= 0) { this.calculateScores(); return; }
    }
    this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
  }
  calculateScores() {
    for (const p of this.players) {
      for (const c of p.board) { if (!c.cleared) c.revealed = true; }
      this.checkTriplets(this.players.indexOf(p));
      p.roundScore = p.board.filter(c => !c.cleared).reduce((sum, c) => sum + c.value, 0);
    }
    const ender = this.players[this.roundEnder];
    const minOther = Math.min(...this.players.filter((_, i) => i !== this.roundEnder).map(o => o.roundScore));
    if (ender.roundScore >= minOther && ender.roundScore > 0) ender.roundScore *= 2;
    for (const p of this.players) p.totalScore += p.roundScore;
    this.phase = this.players.some(p => p.totalScore >= 100) ? 'GAME_OVER' : 'ROUND_END';
  }
  getPublicState() {
    const s = JSON.parse(JSON.stringify(this));
    s.deckCount = this.deck.length; delete s.deck;
    s.discardTop = this.discard.length > 0 ? this.discard[this.discard.length - 1] : null;
    for (const p of s.players) { for (const c of p.board) { if (!c.revealed && !c.cleared) c.value = null; } }
    return s;
  }
}

// ============================================================================
// DURABLE OBJECT: Manages the room state and WebSockets
// ============================================================================
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.game = new GameEngine([]);
    
    this.state.blockConcurrencyWhile(async () => {
      let stored = await this.state.storage.get("gameState");
      if (stored) {
        Object.assign(this.game, stored);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.endsWith('/ws')) {
      const resp = {
        hostName: this.sessions.length > 0 ? this.sessions[0].name : "Waiting...",
        inGame: this.game.phase !== 'LOBBY' && this.game.phase !== 'GAME_OVER',
        players: this.sessions.map(s => s.name)
      };
      return new Response(JSON.stringify(resp), { 
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const playerName = url.searchParams.get("name") || "Unknown";
    const isPublic = url.searchParams.get("public") === "1";

    this.state.acceptWebSocket(server);
    this.sessions.push({ ws: server, name: playerName, isPublic });

    if (this.game.phase !== 'LOBBY' && this.game.phase !== 'GAME_OVER') {
        this.broadcastState();
    } else {
        this.broadcastLobby();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const data = JSON.parse(msg);
    if (data.type === 'ping') return;

    const session = this.sessions.find(s => s.ws === ws);
    if (!session) return;
    const playerIndex = this.sessions.indexOf(session);

    if (data.type === 'host_start' && playerIndex === 0) {
      this.game = new GameEngine(this.sessions.map(s => s.name));
      this.game.start();
      this.saveState();
      this.broadcastState();
      return;
    }

    if (data.type === 'action') {
      const action = data.action;
      
      if (action === 'draw_deck') {
        const drawn = this.game.drawDeck(playerIndex);
        if (drawn !== null) ws.send(JSON.stringify({ type: 'your_draw', value: drawn }));
      }
      else if (action === 'take_discard') {
        const success = this.game.takeDiscard(playerIndex);
        if (success) ws.send(JSON.stringify({ type: 'your_draw', value: this.game.drawnCard }));
      }
      else if (action === 'reveal') this.game.revealInitial(playerIndex, data.index);
      else if (action === 'tiebreaker') this.game.revealTiebreaker(playerIndex, data.index);
      else if (action === 'swap') this.game.swap(playerIndex, data.index);
      else if (action === 'discard_drawn') this.game.discardDrawnCard(playerIndex);
      else if (action === 'reveal_after_discard') this.game.revealAfterDiscard(playerIndex, data.index);
      else if (action === 'complete_turn_end') this.game.completeTurnEnd();
      else if (action === 'next_round') this.game.nextRound();

      this.saveState();
      this.broadcastState();
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    this.sessions = this.sessions.filter(s => s.ws !== ws);
    if (this.game.phase === 'LOBBY' || this.game.phase === 'GAME_OVER') {
      this.broadcastLobby();
    }
  }

  saveState() {
    this.state.storage.put("gameState", this.game);
  }

  broadcastState() {
    const publicState = this.game.getPublicState();
    this.broadcast({ type: 'state', state: publicState });
  }

  broadcastLobby() {
    this.broadcast({
      type: 'lobby',
      players: this.sessions.map(s => s.name),
      hostName: this.sessions.length > 0 ? this.sessions[0].name : "",
      isPublic: this.sessions.some(s => s.isPublic)
    });
  }

  broadcast(messageObj) {
    const str = JSON.stringify(messageObj);
    this.sessions.forEach(session => {
      try { session.ws.send(str); } catch (err) {}
    });
  }
}

// ============================================================================
// MAIN WORKER ROUTER
// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname.startsWith('/room/')) {
      const parts = url.pathname.split('/');
      const code = parts[2];
      
      if (!env.GAME_ROOM) {
        return new Response(
          "Server configuration error: GAME_ROOM Durable Object is not bound.", 
          { status: 500, headers: {"Access-Control-Allow-Origin": "*"} }
        );
      }

      const id = env.GAME_ROOM.idFromName(code);
      const room = env.GAME_ROOM.get(id);
      
      let response = await room.fetch(request);
      response = new Response(response.body, response);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    return new Response("Skyjo Pro Server is running. Connect via the game client.", {
        headers: {"Access-Control-Allow-Origin": "*"}
    });
  }
};
