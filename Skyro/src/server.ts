// server.ts — Single Worker entry. Two PartyServer Durable Objects:
//   Room  -> binding "Room"  -> URL /parties/room/<CODE>
//   Lobby -> binding "Lobby" -> URL /parties/lobby/public-lobby
//
// routePartykitRequest() handles /parties/* (websockets + HTTP). Anything else
// falls through to the static ASSETS binding (serves public/index.html).
import { Server, Connection, ConnectionContext, routePartykitRequest, getServerByName } from "partyserver";
import { GameEngine } from "./engine";

export interface Env {
  Room: DurableObjectNamespace<Room>;
  Lobby: DurableObjectNamespace<Lobby>;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

export const LOBBY_SINGLETON = "public-lobby";

type ConnState = { pid?: string };
interface Seat { id: string; name: string; connId: string | null; }
interface Pending { id: string; name: string; } // late joiners waiting to be seated

const IDLE_MS = 10 * 60 * 1000; // auto-close a room after 10 min of no activity

/* ============================================================
   ROOM — one instance per game code
   ============================================================ */
export class Room extends Server<Env> {
  static options = { hibernate: false };

  engine: GameEngine | null = null;
  seats: Seat[] = [];
  pending: Pending[] = []; // mid-game joiners spectating until next round
  hostId: string | null = null;
  isPublic = false;
  maxPlayers = 8;
  lastActivity = Date.now();

  async onStart() {
    const meta = await this.ctx.storage.get<any>("meta");
    if (meta) {
      this.seats = meta.seats ?? [];
      this.pending = meta.pending ?? [];
      this.hostId = meta.hostId ?? null;
      this.isPublic = meta.isPublic ?? false;
      this.maxPlayers = meta.maxPlayers ?? 8;
      this.lastActivity = meta.lastActivity ?? Date.now();
    }
    const eng = await this.ctx.storage.get<any>("engine");
    if (eng) this.engine = GameEngine.fromJSON(eng);
  }

  private async persist() {
    await this.ctx.storage.put("meta", {
      seats: this.seats, pending: this.pending, hostId: this.hostId,
      isPublic: this.isPublic, maxPlayers: this.maxPlayers, lastActivity: this.lastActivity,
    });
    if (this.engine) await this.ctx.storage.put("engine", JSON.parse(JSON.stringify(this.engine)));
    else await this.ctx.storage.delete("engine");
  }

  // Mark activity + (re)arm the idle-close alarm.
  private touch() {
    this.lastActivity = Date.now();
    this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  // Fired by the idle alarm. Close the room if it's empty or has gone idle.
  async onAlarm() {
    const live = [...this.getConnections()].length;
    const idle = Date.now() - this.lastActivity >= IDLE_MS;
    if (live === 0 || idle) {
      // Tear down: drop from the public lobby and wipe storage so the code is reusable.
      try { await this.updateLobby(true); } catch (_) {}
      for (const c of this.getConnections()) { try { c.close(4000, "Room closed (inactive)."); } catch (_) {} }
      await this.ctx.storage.deleteAll();
      this.engine = null; this.seats = []; this.pending = []; this.hostId = null;
    } else {
      // Still alive — check again later.
      this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    }
  }

  private seatIndexOf(pid: string) { return this.seats.findIndex((s) => s.id === pid); }
  private pendingIndexOf(pid: string) { return this.pending.findIndex((s) => s.id === pid); }

  // Move all spectating late-joiners into seats, starting at the average total score.
  private seatPendingPlayers() {
    if (!this.engine || !this.pending.length) return;
    const avg = this.engine.averageTotal();
    for (const p of this.pending) {
      if (this.seats.length >= this.maxPlayers) break;
      this.engine.addPlayer(p.name, avg);
      this.seats.push({ id: p.id, name: p.name, connId: null });
    }
    this.pending = [];
  }

  private async updateLobby(remove = false) {
    if (!this.isPublic) return;
    try {
      const lobby = await getServerByName(this.env.Lobby, LOBBY_SINGLETON);
      await lobby.fetch("https://lobby/update", {
        method: "POST",
        body: JSON.stringify({
          action: remove ? "remove" : "update",
          code: this.name,
          hostName: this.seats.find((s) => s.id === this.hostId)?.name ?? "?",
          players: this.seats.length + this.pending.length,
          maxPlayers: this.maxPlayers,
          // Public list still shows in-progress games (you can join to spectate),
          // as long as there's room for another seat.
          inProgress: !!this.engine && this.engine.phase !== "ROUND_END",
        }),
      });
    } catch (_) { /* lobby is optional */ }
  }

  private broadcastState() {
    for (const conn of this.getConnections<ConnState>()) this.sendStateTo(conn);
  }

  private sendStateTo(conn: Connection<ConnState>) {
    const pid = conn.state?.pid;
    const seatIdx = pid ? this.seatIndexOf(pid) : -1;
    if (this.engine) {
      const spectator = seatIdx < 0; // late joiner watching until next round
      conn.send(JSON.stringify({
        type: "state",
        seatIndex: seatIdx,
        isHost: pid === this.hostId,
        spectator,
        state: this.engine.getStateFor(seatIdx),
      }));
    } else {
      conn.send(JSON.stringify({
        type: "lobby",
        isHost: pid === this.hostId,
        seatIndex: seatIdx,
        roomCode: this.name,
        isPublic: this.isPublic,
        players: this.seats.map((s) => ({ id: s.id, name: s.name })),
      }));
    }
  }

  onConnect(conn: Connection<ConnState>, _ctx: ConnectionContext) {
    // Ensure the idle-close alarm is armed whenever someone is connected.
    this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    conn.send(JSON.stringify({ type: "hello" }));
  }

  async onMessage(conn: Connection<ConnState>, raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw as string); } catch { return; }

    if (msg.type === "join") {
      const pid: string = msg.pid;
      const name: string = (msg.name || "Player").slice(0, 20);
      conn.setState({ pid });
      this.touch();

      const idx = this.seatIndexOf(pid);
      if (idx >= 0) {
        // Reconnecting seated player.
        this.seats[idx].name = name;
        this.seats[idx].connId = conn.id;
        if (this.engine) this.engine.players[idx].name = name;
      } else if (this.engine) {
        // Game in progress -> become a spectator, queued to be seated next round.
        const pIdx = this.pendingIndexOf(pid);
        if (pIdx >= 0) this.pending[pIdx].name = name;
        else if (this.seats.length + this.pending.length < this.maxPlayers) {
          this.pending.push({ id: pid, name });
          conn.send(JSON.stringify({
            type: "spectating",
            message: "Game in progress — you'll join automatically next round.",
          }));
        } else {
          conn.send(JSON.stringify({ type: "error", message: "Room is full." }));
          return;
        }
      } else {
        // Pre-game lobby.
        if (this.seats.length === 0) {
          this.hostId = pid;
          this.isPublic = !!msg.isPublic;
          this.maxPlayers = msg.maxPlayers || 8;
        }
        if (this.seats.length >= this.maxPlayers) {
          conn.send(JSON.stringify({ type: "error", message: "Room is full." }));
          return;
        }
        this.seats.push({ id: pid, name, connId: conn.id });
      }
      await this.persist();
      await this.updateLobby();
      this.broadcastState();
      return;
    }

    const pid = conn.state?.pid;
    if (!pid) return;
    const seatIdx = this.seatIndexOf(pid);

    if (msg.type === "start_game" && pid === this.hostId && !this.engine) {
      if (this.seats.length < 2) {
        conn.send(JSON.stringify({ type: "error", message: "Need at least 2 players." }));
        return;
      }
      this.touch();
      this.engine = new GameEngine(this.seats.map((s) => s.name));
      this.engine.start();
      await this.persist();
      await this.updateLobby();
      this.broadcastState();
      return;
    }

    if (msg.type === "next_round" && pid === this.hostId && this.engine) {
      this.touch();
      if (this.engine.phase === "GAME_OVER") {
        // Fresh game: seat spectators (avg score is 0 here) and rebuild from all seats.
        this.seatPendingPlayers();
        this.engine = new GameEngine(this.seats.map((s) => s.name));
        this.engine.start();
      } else if (this.engine.phase === "ROUND_END") {
        // Seat late joiners at the current average total, then deal the next round.
        this.seatPendingPlayers();
        this.engine.nextRound();
      }
      await this.persist();
      await this.updateLobby();
      this.broadcastState();
      return;
    }

    if (msg.type === "complete_turn_end" && pid === this.hostId && this.engine) {
      this.engine.completeTurnEnd();
      await this.persist();
      await this.updateLobby();
      this.broadcastState();
      return;
    }

    if (msg.type === "action" && this.engine && seatIdx >= 0) {
      this.touch();
      const g = this.engine; const i = seatIdx;
      switch (msg.action) {
        case "reveal": g.revealInitial(i, msg.index); break;
        case "tiebreaker": g.revealTiebreaker(i, msg.index); break;
        case "draw_deck": g.drawDeck(i); break;
        case "take_discard": g.takeDiscard(i); break;
        case "swap": g.swap(i, msg.index); break;
        case "discard_drawn": g.discardDrawnCard(i); break;
        case "reveal_after_discard": g.revealAfterDiscard(i, msg.index); break;
      }
      await this.persist();
      this.broadcastState();
      return;
    }
  }

  async onClose(conn: Connection<ConnState>) {
    const pid = conn.state?.pid;
    if (!pid) return;
    const idx = this.seatIndexOf(pid);
    if (idx >= 0) this.seats[idx].connId = null;

    // A spectating late-joiner left before being seated -> drop them from the queue.
    const pIdx = this.pendingIndexOf(pid);
    if (pIdx >= 0) { this.pending.splice(pIdx, 1); }

    // Pre-game: free the seat so the lobby stays accurate.
    if (!this.engine && idx >= 0) {
      this.seats.splice(idx, 1);
      if (pid === this.hostId) this.hostId = this.seats[0]?.id ?? null;
    }

    await this.persist();
    await this.updateLobby(this.seats.length === 0 && this.pending.length === 0);
    this.broadcastState();

    // If nobody is connected anymore, close soon (also covered by the idle alarm).
    const live = [...this.getConnections()].filter((c) => c.id !== conn.id).length;
    if (live === 0) this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}

/* ============================================================
   LOBBY — singleton; tracks public rooms for discovery
   ============================================================ */
interface RoomInfo {
  code: string; hostName: string; players: number; maxPlayers: number; inProgress: boolean; updatedAt: number;
}
const STALE_MS = 30_000;

export class Lobby extends Server<Env> {
  static options = { hibernate: false };
  rooms: Record<string, RoomInfo> = {};

  async onStart() {
    this.rooms = (await this.ctx.storage.get<Record<string, RoomInfo>>("rooms")) ?? {};
  }
  private prune() {
    const now = Date.now();
    for (const code in this.rooms) if (now - this.rooms[code].updatedAt > STALE_MS) delete this.rooms[code];
  }
  private list() {
    this.prune();
    // Show joinable rooms: open seats OR in-progress games you can spectate.
    return Object.values(this.rooms)
      .filter((r) => r.players < r.maxPlayers)
      .sort((a, b) => Number(a.inProgress) - Number(b.inProgress) || b.updatedAt - a.updatedAt);
  }
  private broadcastList() {
    this.broadcast(JSON.stringify({ type: "rooms", rooms: this.list() }));
  }
  async onRequest(req: Request) {
    if (req.method === "POST") {
      const body = (await req.json()) as any;
      if (body.action === "remove") delete this.rooms[body.code];
      else this.rooms[body.code] = {
        code: body.code, hostName: body.hostName ?? "?", players: body.players ?? 1,
        maxPlayers: body.maxPlayers ?? 8, inProgress: !!body.inProgress, updatedAt: Date.now(),
      };
      await this.ctx.storage.put("rooms", this.rooms);
      this.broadcastList();
      return Response.json({ ok: true });
    }
    return Response.json({ rooms: this.list() });
  }
  onConnect(conn: Connection) {
    conn.send(JSON.stringify({ type: "rooms", rooms: this.list() }));
  }
}

/* ============================================================
   Worker fetch handler
   ============================================================ */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ||
      (await env.ASSETS.fetch(request)) ||
      new Response("Not Found", { status: 404 })
    );
  },
};
