/**
 * Skyjo Server — built with partyserver on Cloudflare Workers
 *
 * partyserver wraps Durable Objects with a clean WebSocket API.
 * Routing: partysocket on the client hits  /parties/skyjo-room/:roomCode
 * which routePartykitRequest maps to the SkyjoRoom DO by name.
 *
 * Cost savers:
 *  • hibernate: true  → DO sleeps between messages, zero duration charges
 *  • Outgoing broadcasts are FREE on Cloudflare
 *  • Incoming messages billed 20:1 (a full game ≈ 5-10 billed requests)
 *  • No storage writes during gameplay (game state is in-memory JS)
 *  • ctx.storage.setAlarm() closes abandoned rooms after 10 min
 */

import { Server, routePartykitRequest } from "partyserver";

// ─── Tiny Game Engine (server is authoritative) ──────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  const d = [];
  for (let i = 0; i < 5; i++) d.push(-2);
  for (let i = 0; i < 10; i++) d.push(-1);
  for (let i = 0; i < 15; i++) d.push(0);
  for (let v = 1; v <= 12; v++) for (let i = 0; i < 10; i++) d.push(v);
  return shuffle(d);
}

class GameEngine {
  constructor(names) {
    this.players = names.map(n => ({
      name: n,
      board: Array.from({ length: 12 }, () => ({ value: 0, revealed: false, cleared: false })),
      roundScore: 0, totalScore: 0, revealCount: 0,
    }));
    this.deck = []; this.discard = [];
    this.phase = 'LOBBY'; this.round = 1;
    this.currentPlayer = 0; this.roundEnder = -1; this.finalTurnsLeft = 0;
    this.drawnCard = null; this.turnAction = null;
    this.tiebreakerPlayers = []; this.pendingTransition = null;
  }

  _deal() {
    this.deck = createDeck();
    for (const p of this.players) {
      for (const c of p.board) { c.value = this.deck.pop(); c.revealed = false; c.cleared = false; }
      p.revealCount = 0; p.roundScore = 0;
    }
    this.discard = [this.deck.pop()];
    this.roundEnder = -1; this.finalTurnsLeft = 0;
    this.currentPlayer = 0; this.drawnCard = null; this.turnAction = null;
    this.tiebreakerPlayers = []; this.pendingTransition = null;
  }

  start() { this._deal(); this.phase = 'REVEAL'; this.round = 1; }
  nextRound() { this.round++; this._deal(); this.phase = 'REVEAL'; }

  revealInitial(pi, ci) {
    if (this.phase !== 'REVEAL') return false;
    const p = this.players[pi]; if (p.revealCount >= 2) return false;
    const c = p.board[ci]; if (c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++;
    if (this.players.every(pl => pl.revealCount >= 2)) this._pickStarter();
    return true;
  }

  _pickStarter() {
    const sums = this.players.map((p, i) => ({ i, s: p.board.filter(c => c.revealed).reduce((a, c) => a + c.value, 0) }));
    const max = Math.max(...sums.map(x => x.s));
    const tied = sums.filter(x => x.s === max).map(x => x.i);
    this.turnAction = 'turn_end_delay';
    this.pendingTransition = { type: 'starter', tied };
  }

  revealTiebreaker(pi, ci) {
    if (!this.tiebreakerPlayers.includes(pi)) return false;
    const p = this.players[pi]; const c = p.board[ci];
    if (c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++;
    if (this.tiebreakerPlayers.every(i => this.players[i].revealCount >= 2)) {
      const sums = this.tiebreakerPlayers.map(i => ({ i, s: this.players[i].board.filter(c => c.revealed).reduce((a, c) => a + c.value, 0) }));
      const max = Math.max(...sums.map(x => x.s)); const tied = sums.filter(x => x.s === max).map(x => x.i);
      this.turnAction = 'turn_end_delay'; this.pendingTransition = { type: 'starter', tied };
    }
    return true;
  }

  drawDeck(pi) {
    if (!['PLAY','FINAL_TURNS'].includes(this.phase)) return null;
    if (this.currentPlayer !== pi || this.turnAction !== null) return null;
    if (this.deck.length === 0) { this.deck = shuffle(this.discard.slice(0,-1)); this.discard = [this.discard[this.discard.length-1]]; }
    this.drawnCard = this.deck.pop(); this.turnAction = 'deck';
    return this.drawnCard;
  }

  takeDiscard(pi) {
    if (!['PLAY','FINAL_TURNS'].includes(this.phase)) return null;
    if (this.currentPlayer !== pi || this.turnAction !== null) return null;
    if (!this.discard.length) return null;
    const val = this.discard[this.discard.length - 1]; // capture BEFORE pop
    this.drawnCard = this.discard.pop(); this.turnAction = 'discard';
    return val; // return captured value (same as drawnCard now, but semantically clear)
  }

  swap(pi, bi) {
    if (!['PLAY','FINAL_TURNS'].includes(this.phase) || this.currentPlayer !== pi || !this.turnAction) return false;
    const p = this.players[pi]; const old = p.board[bi]; if (old.cleared) return false;
    this.discard.push(old.value);
    p.board[bi] = { value: this.drawnCard, revealed: true, cleared: false };
    this._checkTriplets(pi); this._finishTurn(); return true;
  }

  discardDrawn(pi) {
    if (!['PLAY','FINAL_TURNS'].includes(this.phase) || this.currentPlayer !== pi || this.turnAction !== 'deck') return false;
    this.discard.push(this.drawnCard); this.drawnCard = null; this.turnAction = 'must_reveal'; return true;
  }

  revealAfterDiscard(pi, bi) {
    if (!['PLAY','FINAL_TURNS'].includes(this.phase) || this.currentPlayer !== pi || this.turnAction !== 'must_reveal') return false;
    const c = this.players[pi].board[bi]; if (c.revealed || c.cleared) return false;
    c.revealed = true; this._checkTriplets(pi); this._finishTurn(); return true;
  }

  _checkTriplets(pi) {
    const p = this.players[pi];
    for (let col = 0; col < 4; col++) {
      const idxs = [col, col+4, col+8]; const cards = idxs.map(i => p.board[i]);
      if (cards.every(c => c.revealed && !c.cleared) && cards[0].value === cards[1].value && cards[1].value === cards[2].value) {
        idxs.forEach(i => { p.board[i].cleared = true; this.discard.push(cards[0].value); });
      }
    }
  }

  _finishTurn() { this.drawnCard = null; this.turnAction = 'turn_end_delay'; }

  completeTurnEnd() {
    if (this.turnAction !== 'turn_end_delay') return;
    this.turnAction = null;
    if (this.pendingTransition) {
      const { tied } = this.pendingTransition; this.pendingTransition = null;
      if (tied.length === 1) { this.currentPlayer = tied[0]; this.phase = 'PLAY'; this.tiebreakerPlayers = []; }
      else { this.tiebreakerPlayers = tied; for (const i of tied) this.players[i].revealCount = 1; }
      return;
    }
    const p = this.players[this.currentPlayer];
    if (p.board.every(c => c.cleared || c.revealed) && this.phase === 'PLAY') {
      this.phase = 'FINAL_TURNS'; this.roundEnder = this.currentPlayer; this.finalTurnsLeft = this.players.length - 1;
    }
    if (this.phase === 'FINAL_TURNS') {
      if (this.currentPlayer !== this.roundEnder) this.finalTurnsLeft--;
      if (this.finalTurnsLeft <= 0) { this._calcScores(); return; }
    }
    this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
  }

  _calcScores() {
    for (const p of this.players) {
      for (const c of p.board) if (!c.cleared) c.revealed = true;
      this._checkTriplets(this.players.indexOf(p));
      p.roundScore = p.board.filter(c => !c.cleared).reduce((s, c) => s + c.value, 0);
    }
    const ender = this.players[this.roundEnder];
    const minOther = Math.min(...this.players.filter((_,i) => i !== this.roundEnder).map(o => o.roundScore));
    if (ender.roundScore >= minOther && ender.roundScore > 0) ender.roundScore *= 2;
    for (const p of this.players) p.totalScore += p.roundScore;
    this.phase = this.players.some(p => p.totalScore >= 100) ? 'GAME_OVER' : 'ROUND_END';
  }

  publicState() {
    const s = JSON.parse(JSON.stringify(this));
    s.deckCount = this.deck.length; delete s.deck;
    s.discardTop = this.discard.length ? this.discard[this.discard.length - 1] : null;
    for (const p of s.players) for (const c of p.board) if (!c.revealed && !c.cleared) c.value = null;
    return s;
  }
}

// ─── PartyServer Room ────────────────────────────────────────────────────────

const INACTIVITY_MS = 10 * 60 * 1000;
const TURN_DELAY_MS = 1500;

export class SkyjoRoom extends Server {
  static options = { hibernate: true }; // free-tier saver: sleep between messages

  constructor(ctx, env) {
    super(ctx, env);
    this.game = null;
    this.lobby = {}; // name -> connId
    this.hostName = null;
    this.isPublic = false;
  }

  onStart() {
    // Reset inactivity alarm on wake
    this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);
  }

  onConnect(conn, ctx) {
    const url = new URL(ctx.request.url);
    const playerName = decodeURIComponent(url.searchParams.get('name') || 'Player');
    const wantsPublic = url.searchParams.get('public') === '1';

    conn.setState({ name: playerName });

    if (!this.hostName) { this.hostName = playerName; this.isPublic = wantsPublic; }
    this.lobby[playerName] = conn.id;

    this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);

    // Send lobby state to all (including newcomer)
    this._broadcastLobby();

    // If game is running, send current state to the new connection
    if (this.game && this.game.phase !== 'LOBBY') {
      conn.send(JSON.stringify({ type: 'state', state: this.game.publicState() }));
    }
  }

  onMessage(conn, raw) {
    this.ctx.storage.setAlarm(Date.now() + INACTIVITY_MS);

    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const playerName = conn.state?.name;
    if (!playerName) return;

    switch (msg.type) {
      case 'ping': conn.send(JSON.stringify({ type: 'pong' })); break;

      case 'set_public': {
        if (playerName !== this.hostName) return;
        this.isPublic = !!msg.value;
        this._broadcastLobby();
        break;
      }

      case 'host_start': {
        if (playerName !== this.hostName) return;
        const names = Object.keys(this.lobby);
        if (names.length < 2) { conn.send(JSON.stringify({ type: 'error', msg: 'Need at least 2 players' })); return; }
        this.game = new GameEngine(names);
        this.game.start();
        this._broadcastState();
        break;
      }

      case 'action': {
        if (!this.game) return;
        const g = this.game;
        const pi = g.players.findIndex(p => p.name === playerName);
        if (pi < 0) return;

        switch (msg.action) {
          case 'reveal':               g.revealInitial(pi, msg.index); break;
          case 'tiebreaker':           g.revealTiebreaker(pi, msg.index); break;
          case 'draw_deck': {
            const val = g.drawDeck(pi);
            if (val !== null) conn.send(JSON.stringify({ type: 'your_draw', value: val, source: 'deck' }));
            break;
          }
          case 'take_discard': {
            const val = g.takeDiscard(pi); // returns the value that was on top
            if (val !== null) conn.send(JSON.stringify({ type: 'your_draw', value: val, source: 'discard' }));
            break;
          }
          case 'swap':                 g.swap(pi, msg.index); break;
          case 'discard_drawn':        g.discardDrawn(pi); break;
          case 'reveal_after_discard': g.revealAfterDiscard(pi, msg.index); break;
          case 'next_round':
            if (g.phase === 'ROUND_END' || g.phase === 'GAME_OVER') {
              g.nextRound(); this._broadcastState(); return;
            }
            break;
        }
        this._broadcastState();
        break;
      }

      case 'close_room': {
        if (playerName === this.hostName) this._closeRoom('Host closed the room.');
        break;
      }
    }
  }

  onClose(conn) {
    const playerName = conn.state?.name; if (!playerName) return;
    delete this.lobby[playerName];
    if (Object.keys(this.lobby).length === 0) return;
    if (playerName === this.hostName) this.hostName = Object.keys(this.lobby)[0] ?? null;
    this._broadcastLobby();
  }

  async alarm() {
    await this._closeRoom('Room closed due to inactivity.');
  }

  // ── helpers ──

  _broadcastLobby() {
    this.broadcast(JSON.stringify({
      type: 'lobby',
      players: Object.keys(this.lobby),
      hostName: this.hostName,
      isPublic: this.isPublic,
    }));
  }

  _broadcastState() {
    if (!this.game) return;
    const state = this.game.publicState();
    this.broadcast(JSON.stringify({ type: 'state', state }));

    // After broadcasting turn_end_delay, schedule completeTurnEnd
    if (state.turnAction === 'turn_end_delay') {
      this.ctx.waitUntil(
        new Promise(r => setTimeout(r, TURN_DELAY_MS)).then(() => {
          if (this.game?.turnAction === 'turn_end_delay') {
            this.game.completeTurnEnd();
            this._broadcastState();
          }
        })
      );
    }
  }

  async _closeRoom(reason) {
    this.broadcast(JSON.stringify({ type: 'room_closed', reason }));
    for (const conn of this.getConnections()) { try { conn.close(1000, reason); } catch {} }
    await this.ctx.storage.deleteAlarm();
    this.game = null; this.lobby = {}; this.hostName = null;
  }
}

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      }});
    }

    const response = await routePartykitRequest(request, env, {
      cors: { origin: '*' },  // allow cross-origin WebSocket upgrades
    }) ?? new Response('Not found', { status: 404 });

    return response;
  },
};
