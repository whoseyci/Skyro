// engine.ts — Authoritative Skyjo game logic (server-side, framework-free).

export interface Card { value: number; revealed: boolean; cleared: boolean; }
export interface Player {
  name: string;
  board: Card[];
  roundScore: number;
  totalScore: number;
  revealCount: number;
}
export type Phase = "REVEAL" | "PLAY" | "FINAL_TURNS" | "ROUND_END" | "GAME_OVER";
export type TurnAction = null | "deck" | "discard" | "must_reveal" | "turn_end_delay";

export function createDeck(): number[] {
  const d: number[] = [];
  for (let i = 0; i < 5; i++) d.push(-2);
  for (let i = 0; i < 10; i++) d.push(-1);
  for (let i = 0; i < 15; i++) d.push(0);
  for (let v = 1; v <= 12; v++) for (let i = 0; i < 10; i++) d.push(v);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export class GameEngine {
  players: Player[];
  deck: number[] = [];
  discard: number[] = [];
  phase: Phase = "REVEAL";
  round = 1;
  currentPlayer = 0;
  roundEnder = -1;
  finalTurnsLeft = 0;
  drawnCard: number | null = null;
  turnAction: TurnAction = null;
  tiebreakerPlayers: number[] = [];
  lastAction: any = null;
  pendingTransition: any = null;

  constructor(names: string[]) {
    this.players = names.map((n) => ({
      name: n,
      board: Array.from({ length: 12 }, () => ({ value: 0, revealed: false, cleared: false })),
      roundScore: 0,
      totalScore: 0,
      revealCount: 0,
    }));
  }

  // Rehydrate from a stored plain object.
  static fromJSON(obj: any): GameEngine {
    const g = new GameEngine([]);
    Object.assign(g, obj);
    return g;
  }

  private deal() {
    this.deck = createDeck();
    for (const p of this.players) {
      for (const c of p.board) { c.value = this.deck.pop()!; c.revealed = false; c.cleared = false; }
      p.revealCount = 0; p.roundScore = 0;
    }
    this.discard = [this.deck.pop()!];
    this.phase = "REVEAL"; this.roundEnder = -1; this.finalTurnsLeft = 0;
    this.currentPlayer = 0; this.drawnCard = null; this.turnAction = null;
    this.tiebreakerPlayers = []; this.lastAction = null; this.pendingTransition = null;
  }
  start() { this.deal(); }
  nextRound() { this.round++; this.deal(); }
  newGame() { this.round = 1; for (const p of this.players) p.totalScore = 0; this.deal(); }

  // Add a player mid-game (e.g. a late joiner who spectated). They start with the
  // supplied total score (typically the average of active players, rounded).
  // Their board is dealt on the next deal()/nextRound().
  addPlayer(name: string, startingTotal: number) {
    this.players.push({
      name,
      board: Array.from({ length: 12 }, () => ({ value: 0, revealed: false, cleared: false })),
      roundScore: 0,
      totalScore: Math.round(startingTotal) || 0,
      revealCount: 0,
    });
  }
  averageTotal(): number {
    if (!this.players.length) return 0;
    return this.players.reduce((s, p) => s + p.totalScore, 0) / this.players.length;
  }

  revealInitial(pi: number, ci: number): boolean {
    if (this.phase !== "REVEAL") return false;
    const p = this.players[pi]; if (!p || p.revealCount >= 2) return false;
    const c = p.board[ci]; if (!c || c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++;
    this.lastAction = { type: "reveal", player: pi, card: ci, value: c.value, t: Date.now() };
    if (this.players.every((pl) => pl.revealCount >= 2)) this.determineStarter();
    return true;
  }
  private determineStarter() {
    const sums = this.players.map((p, i) => ({
      i, sum: p.board.filter((c) => c.revealed && !c.cleared).reduce((a, c) => a + c.value, 0),
    }));
    const max = Math.max(...sums.map((s) => s.sum));
    const tied = sums.filter((s) => s.sum === max).map((s) => s.i);
    this.turnAction = "turn_end_delay";
    this.pendingTransition = { type: "starter", tied };
  }
  revealTiebreaker(pi: number, ci: number): boolean {
    if (!this.tiebreakerPlayers.includes(pi)) return false;
    const p = this.players[pi]; if (p.revealCount >= 2) return false;
    const c = p.board[ci]; if (!c || c.revealed || c.cleared) return false;
    c.revealed = true; p.revealCount++;
    this.lastAction = { type: "reveal", player: pi, card: ci, value: c.value, t: Date.now() };
    if (this.tiebreakerPlayers.every((i) => this.players[i].revealCount >= 2)) {
      const sums = this.tiebreakerPlayers.map((i) => ({
        i, sum: this.players[i].board.filter((c) => c.revealed && !c.cleared).reduce((a, c) => a + c.value, 0),
      }));
      const max = Math.max(...sums.map((s) => s.sum));
      const stillTied = sums.filter((s) => s.sum === max).map((s) => s.i);
      this.turnAction = "turn_end_delay";
      this.pendingTransition = { type: "starter", tied: stillTied };
    }
    return true;
  }
  drawDeck(pi: number): number | null {
    if (this.phase !== "PLAY" && this.phase !== "FINAL_TURNS") return null;
    if (this.currentPlayer !== pi || this.turnAction !== null) return null;
    if (this.deck.length === 0) {
      this.deck = this.discard.slice(0, -1);
      this.discard = [this.discard[this.discard.length - 1]];
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
    }
    this.drawnCard = this.deck.pop()!;
    this.turnAction = "deck";
    this.lastAction = { type: "draw_deck", player: pi, t: Date.now() };
    return this.drawnCard;
  }
  takeDiscard(pi: number): boolean {
    if (this.phase !== "PLAY" && this.phase !== "FINAL_TURNS") return false;
    if (this.currentPlayer !== pi || this.turnAction !== null) return false;
    if (this.discard.length === 0) return false;
    this.drawnCard = this.discard.pop()!;
    this.turnAction = "discard";
    this.lastAction = { type: "take_discard", player: pi, value: this.drawnCard, t: Date.now() };
    return true;
  }
  swap(pi: number, bi: number): boolean {
    if (this.phase !== "PLAY" && this.phase !== "FINAL_TURNS") return false;
    if (this.currentPlayer !== pi || this.turnAction === null || this.turnAction === "must_reveal") return false;
    const p = this.players[pi]; const oldCard = p.board[bi];
    if (!oldCard || oldCard.cleared) return false;
    const wasRevealed = oldCard.revealed; const oldVal = oldCard.value;
    this.discard.push(oldCard.value);
    p.board[bi] = { value: this.drawnCard!, revealed: true, cleared: false };
    const diff = wasRevealed ? oldVal - this.drawnCard! : null;
    this.lastAction = {
      type: "swap", player: pi, index: bi,
      good: wasRevealed ? diff! > 0 : null, diff, oldVal, wasRevealed,
      newVal: this.drawnCard, t: Date.now(),
    };
    this.endTurn();
    return true;
  }
  discardDrawnCard(pi: number): boolean {
    if (this.phase !== "PLAY" && this.phase !== "FINAL_TURNS") return false;
    if (this.currentPlayer !== pi || this.turnAction !== "deck") return false;
    const val = this.drawnCard!;
    this.discard.push(val);
    this.drawnCard = null;
    this.turnAction = "must_reveal";
    this.lastAction = { type: "discard_drawn", player: pi, value: val, t: Date.now() };
    return true;
  }
  revealAfterDiscard(pi: number, bi: number): boolean {
    if (this.phase !== "PLAY" && this.phase !== "FINAL_TURNS") return false;
    if (this.currentPlayer !== pi || this.turnAction !== "must_reveal") return false;
    const p = this.players[pi]; const t = p.board[bi];
    if (!t || t.revealed || t.cleared) return false;
    t.revealed = true;
    this.lastAction = { type: "reveal_after_discard", player: pi, index: bi, value: t.value, t: Date.now() };
    this.endTurn();
    return true;
  }
  checkTriplets(pi: number): boolean {
    const p = this.players[pi]; let cleared = false;
    for (let col = 0; col < 4; col++) {
      const idxs = [col, col + 4, col + 8];
      const cards = idxs.map((i) => p.board[i]);
      if (cards.every((c) => c.revealed && !c.cleared) &&
          cards[0].value === cards[1].value && cards[1].value === cards[2].value) {
        idxs.forEach((i) => (p.board[i].cleared = true));
        for (let i = 0; i < 3; i++) this.discard.push(cards[0].value);
        cleared = true;
        this.lastAction = { type: "triplet", player: pi, value: cards[0].value, indices: idxs, t: Date.now() };
      }
    }
    return cleared;
  }
  private endTurn() {
    this.checkTriplets(this.currentPlayer);
    this.drawnCard = null;
    this.turnAction = "turn_end_delay";
  }
  completeTurnEnd() {
    if (this.turnAction !== "turn_end_delay") return;
    this.turnAction = null;
    if (this.pendingTransition) {
      const tied = this.pendingTransition.tied;
      if (tied.length === 1) {
        this.currentPlayer = tied[0]; this.phase = "PLAY";
        this.lastAction = { type: "starter", player: tied[0], t: Date.now() };
        this.tiebreakerPlayers = [];
      } else {
        this.tiebreakerPlayers = tied;
        for (const i of tied) this.players[i].revealCount = 1;
      }
      this.pendingTransition = null;
      return;
    }
    const p = this.players[this.currentPlayer];
    if (p.board.every((c) => c.cleared || c.revealed) && this.phase === "PLAY") {
      this.phase = "FINAL_TURNS";
      this.roundEnder = this.currentPlayer;
      this.finalTurnsLeft = this.players.length - 1;
    }
    if (this.phase === "FINAL_TURNS") {
      if (this.currentPlayer !== this.roundEnder) this.finalTurnsLeft--;
      if (this.finalTurnsLeft <= 0) { this.calculateScores(); return; }
    }
    this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
  }
  private calculateScores() {
    for (const p of this.players) {
      for (const c of p.board) if (!c.cleared) c.revealed = true;
      this.checkTriplets(this.players.indexOf(p));
      p.roundScore = p.board.filter((c) => !c.cleared).reduce((s, c) => s + c.value, 0);
    }
    const ender = this.players[this.roundEnder];
    const minOther = Math.min(
      ...this.players.filter((_, i) => i !== this.roundEnder).map((o) => o.roundScore)
    );
    if (ender.roundScore >= minOther && ender.roundScore > 0) ender.roundScore *= 2;
    for (const p of this.players) p.totalScore += p.roundScore;
    this.phase = this.players.some((p) => p.totalScore >= 100) ? "GAME_OVER" : "ROUND_END";
    const min = Math.min(...this.players.map((p) => p.totalScore));
    this.lastAction = {
      type: this.phase === "GAME_OVER" ? "game_over" : "round_end",
      winners: this.players.map((p, i) => (p.totalScore === min ? i : -1)).filter((i) => i >= 0),
      t: Date.now(),
    };
  }
  getStateFor(viewerIndex: number) {
    const s: any = {
      phase: this.phase, round: this.round, currentPlayer: this.currentPlayer,
      roundEnder: this.roundEnder, finalTurnsLeft: this.finalTurnsLeft, turnAction: this.turnAction,
      tiebreakerPlayers: [...this.tiebreakerPlayers], lastAction: this.lastAction,
      deckCount: this.deck.length,
      discardTop: this.discard.length ? this.discard[this.discard.length - 1] : null,
      discardCount: this.discard.length,
      players: this.players.map((p) => ({
        name: p.name, totalScore: p.totalScore, roundScore: p.roundScore, revealCount: p.revealCount,
        board: p.board.map((c) => ({
          value: c.revealed || c.cleared ? c.value : null, revealed: c.revealed, cleared: c.cleared,
        })),
      })),
    };
    s.myDrawnCard =
      viewerIndex === this.currentPlayer && (this.turnAction === "deck" || this.turnAction === "discard")
        ? this.drawnCard : null;
    s.viewerIndex = viewerIndex;
    return s;
  }
}
