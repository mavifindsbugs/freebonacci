import { Server, routePartykitRequest, type Connection } from "partyserver";
import { z } from "zod";

export interface Player {
  id: string;
  name: string;
  vote: string | null;
  isSpectator: boolean;
  isOnline: boolean;
}

export interface RoundResult {
  roundNumber: number;
  median: number | null;
  agreement: 'full' | 'close' | 'split';
  timestamp: number;
}

export interface GameState {
  players: Record<string, Player>;
  isRevealed: boolean;
  deck: 'fibonacci' | 'tshirt';
  history: RoundResult[];
  roundCount: number;
}

const VALID_VOTES: Record<string, string[]> = {
  fibonacci: ['1', '2', '3', '5', '8', '13', '21', '?', '☕'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?'],
};

const GRACE_PERIOD_MS = 15_000;

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 10;

const JoinSchema = z.object({
  type: z.literal("JOIN"),
  name: z.string().min(1).max(16),
  isSpectator: z.boolean().optional().default(false),
});

const VoteSchema = z.object({
  type: z.literal("VOTE"),
  value: z.string(),
});

const SetDeckSchema = z.object({
  type: z.literal("SET_DECK"),
  deck: z.enum(["fibonacci", "tshirt"]),
});

const BaseActionSchema = z.object({
  type: z.enum(["REVEAL", "RESET"]),
});

type ConnectionState = { playerId: string };

type Env = {
  PLANNING_POKER_SERVER: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
};

export class PlanningPokerServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  gameState: GameState = {
    players: {},
    isRevealed: false,
    deck: "fibonacci",
    history: [],
    roundCount: 0,
  };

  private rateLimits = new Map<string, number[]>();

  async onStart() {
    const savedState = await this.ctx.storage.get<GameState>("gameState");
    if (savedState) {
      this.gameState = savedState;
    }
  }

  async onConnect(connection: Connection, ctx: any) {
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get("playerId") ?? connection.id;

    (connection as Connection<ConnectionState>).setState({ playerId });

    await this.cancelDisconnectTimer(playerId);

    if (this.gameState.players[playerId]) {
      this.gameState.players[playerId].isOnline = true;
      this.broadcast(JSON.stringify({ type: "STATE", state: this.gameState }));
      await this.ctx.storage.put("gameState", this.gameState);
    }

    connection.send(JSON.stringify({ type: "STATE", state: this.gameState }));
    await this.setCleanupAlarm();
  }

  async onMessage(sender: Connection, message: string) {
    const connState = (sender as Connection<ConnectionState>).state;
    const playerId = connState?.playerId ?? sender.id;

    const now = Date.now();
    const timestamps = this.rateLimits.get(playerId) ?? [];
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) return;
    recent.push(now);
    this.rateLimits.set(playerId, recent);

    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "JOIN": {
          const parsed = JoinSchema.parse(data);
          const existing = this.gameState.players[playerId];
          this.gameState.players[playerId] = {
            id: playerId,
            name: parsed.name,
            vote: existing ? existing.vote : null,
            isSpectator: parsed.isSpectator,
            isOnline: true,
          };
          break;
        }

        case "VOTE": {
          const parsed = VoteSchema.parse(data);
          const allowed = VALID_VOTES[this.gameState.deck];
          if (!allowed?.includes(parsed.value)) return;
          if (this.gameState.players[playerId]) {
            this.gameState.players[playerId].vote = parsed.value;
          }
          break;
        }

        case "REVEAL": {
          BaseActionSchema.parse(data);
          this.gameState.isRevealed = true;
          this.gameState.roundCount++;
          const result = this.computeRoundResult(this.gameState.roundCount);
          this.gameState.history.unshift(result);
          if (this.gameState.history.length > 10) {
            this.gameState.history.pop();
          }
          break;
        }

        case "RESET": {
          BaseActionSchema.parse(data);
          this.gameState.isRevealed = false;
          for (const id in this.gameState.players) {
            if (!this.gameState.players[id].isOnline) {
              delete this.gameState.players[id];
            } else {
              this.gameState.players[id].vote = null;
            }
          }
          break;
        }

        case "SET_DECK": {
          const parsed = SetDeckSchema.parse(data);
          const hasVotes = Object.values(this.gameState.players).some(
            (p) => p.vote !== null
          );
          if (hasVotes) return;
          this.gameState.deck = parsed.deck;
          this.gameState.isRevealed = false;
          break;
        }

        default:
          console.warn("Unknown message type:", data.type);
          return;
      }

      this.broadcast(JSON.stringify({ type: "STATE", state: this.gameState }));
      await this.ctx.storage.put("gameState", this.gameState);
      await this.setCleanupAlarm();
    } catch (err) {
      console.error("Failed to process message:", err);
    }
  }

  async onClose(connection: Connection) {
    const connState = (connection as Connection<ConnectionState>).state;
    const playerId = connState?.playerId ?? connection.id;

    this.rateLimits.delete(playerId);

    let hasOtherConnection = false;
    for (const conn of this.getConnections<ConnectionState>()) {
      if (conn.id !== connection.id && conn.state?.playerId === playerId) {
        hasOtherConnection = true;
        break;
      }
    }

    if (hasOtherConnection) return;
    if (!this.gameState.players[playerId]) return;

    this.gameState.players[playerId].isOnline = false;

    if (!this.gameState.isRevealed) {
      await this.scheduleDisconnectTimer(playerId);
    }

    this.broadcast(JSON.stringify({ type: "STATE", state: this.gameState }));
    await this.ctx.storage.put("gameState", this.gameState);
  }

  async onAlarm() {
    const now = Date.now();

    const pending =
      (await this.ctx.storage.get<Record<string, number>>(
        "pendingDisconnects"
      )) ?? {};
    const cleanupAt =
      (await this.ctx.storage.get<number>("cleanupAt")) ??
      now + 60 * 60 * 1000;

    let stateChanged = false;
    for (const [pid, expiresAt] of Object.entries(pending) as [string, number][]) {
      if (now >= expiresAt - 100) {
        if (this.gameState.players[pid] && !this.gameState.isRevealed) {
          delete this.gameState.players[pid];
          stateChanged = true;
        }
        delete pending[pid];
      }
    }
    await this.ctx.storage.put("pendingDisconnects", pending);

    if (stateChanged) {
      this.broadcast(JSON.stringify({ type: "STATE", state: this.gameState }));
      await this.ctx.storage.put("gameState", this.gameState);
    }

    if (now >= cleanupAt) {
      await this.ctx.storage.deleteAll();
      this.gameState = {
        players: {},
        isRevealed: false,
        deck: "fibonacci",
        history: [],
        roundCount: 0,
      };
      return;
    }

    const pendingTimes = Object.values(pending) as number[];
    const nextAlarm =
      pendingTimes.length > 0
        ? Math.min(Math.min(...pendingTimes), cleanupAt)
        : cleanupAt;
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  private async setCleanupAlarm() {
    const cleanupAt = Date.now() + 60 * 60 * 1000;
    await this.ctx.storage.put("cleanupAt", cleanupAt);

    const pending =
      (await this.ctx.storage.get<Record<string, number>>(
        "pendingDisconnects"
      )) ?? {};
    const pendingTimes = Object.values(pending) as number[];
    const nextAlarm =
      pendingTimes.length > 0
        ? Math.min(Math.min(...pendingTimes), cleanupAt)
        : cleanupAt;
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  private async scheduleDisconnectTimer(playerId: string) {
    const expiresAt = Date.now() + GRACE_PERIOD_MS;
    const pending =
      (await this.ctx.storage.get<Record<string, number>>(
        "pendingDisconnects"
      )) ?? {};
    pending[playerId] = expiresAt;
    await this.ctx.storage.put("pendingDisconnects", pending);

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm > expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  private async cancelDisconnectTimer(playerId: string) {
    const pending =
      (await this.ctx.storage.get<Record<string, number>>(
        "pendingDisconnects"
      )) ?? {};
    if (playerId in pending) {
      delete pending[playerId];
      await this.ctx.storage.put("pendingDisconnects", pending);
    }
  }

  private computeRoundResult(roundNumber: number): RoundResult {
    const votes: Record<string, string> = {};
    const numericVotes: number[] = [];

    for (const player of Object.values(this.gameState.players)) {
      if (player.vote && !player.isSpectator) {
        votes[player.id] = player.vote;
        const num = parseFloat(player.vote);
        if (!isNaN(num)) {
          numericVotes.push(num);
        }
      }
    }

    let median: number | null = null;
    let agreement: 'full' | 'close' | 'split' = 'split';

    if (numericVotes.length > 0) {
      const sortedVotes = [...numericVotes].sort((a, b) => a - b);
      const medianIndex = Math.floor(sortedVotes.length / 2);
      median = sortedVotes[medianIndex];

      const min = Math.min(...numericVotes);
      const max = Math.max(...numericVotes);

      if (min === max) {
        agreement = 'full';
      } else if (max - min <= 2 || (min === 1 && max === 3) || (min === 2 && max === 5)) {
        agreement = 'close';
      } else {
        agreement = 'split';
      }
    } else {
      // t-shirt sizes: agree on exact match only
      const uniqueVotes = new Set(Object.values(votes));
      if (uniqueVotes.size === 1 && uniqueVotes.size > 0) {
        agreement = 'full';
      } else if (uniqueVotes.size === 2) {
        agreement = 'close';
      }
    }

    return {
      roundNumber,
      median,
      agreement,
      timestamp: Date.now(),
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.headers.get("Upgrade") === "websocket") {
      const origin = request.headers.get("Origin");
      const raw = env.ALLOWED_ORIGINS ?? "https://freebonacci.app,https://freebonacci.mavz.eu";
      const allowed = raw.split(",").map((s) => s.trim());
      if (origin && !allowed.includes(origin)) {
        return new Response("Origin not allowed", { status: 403 });
      }
    }

    return (
      (await routePartykitRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
