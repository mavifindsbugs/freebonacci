import { Server, routePartykitRequest, type Connection } from "partyserver";
import { z } from "zod";

export interface Player {
  id: string;
  name: string;
  vote: string | null;
  isSpectator: boolean;
}

export interface RoundResult {
  roundNumber: number;
  average: number | null;
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

type Env = {
  PLANNING_POKER_SERVER: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
};

export class PlanningPokerServer extends Server<Env> {
  static options = {
    hibernate: true
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

  onConnect(connection: Connection, ctx: any) {
    connection.send(JSON.stringify({ type: "STATE", state: this.gameState }));
  }

  async onMessage(sender: Connection, message: string) {
    // Rate limiting
    const now = Date.now();
    const timestamps = this.rateLimits.get(sender.id) ?? [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) return;
    recent.push(now);
    this.rateLimits.set(sender.id, recent);

    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case "JOIN": {
          const parsed = JoinSchema.parse(data);
          const existing = this.gameState.players[sender.id];
          this.gameState.players[sender.id] = {
            id: sender.id,
            name: parsed.name,
            vote: existing ? existing.vote : null,
            isSpectator: parsed.isSpectator,
          };
          break;
        }
        case "VOTE": {
          const parsed = VoteSchema.parse(data);
          const allowed = VALID_VOTES[this.gameState.deck];
          if (!allowed?.includes(parsed.value)) return;
          if (this.gameState.players[sender.id]) {
            this.gameState.players[sender.id].vote = parsed.value;
          }
          break;
        }
        case "REVEAL": {
          BaseActionSchema.parse(data);
          this.gameState.isRevealed = true;
          this.gameState.roundCount++;
          const result = this.computeRoundResult(this.gameState.roundCount);
          
          this.gameState.history.unshift(result);
          
          // Cap history at 10 items to save memory
          if (this.gameState.history.length > 10) {
            this.gameState.history.pop();
          }
          break;
        }
        case "RESET": {
          BaseActionSchema.parse(data);
          this.gameState.isRevealed = false;
          for (const id in this.gameState.players) {
            this.gameState.players[id].vote = null;
          }
          break;
        }
        case "SET_DECK": {
          const parsed = SetDeckSchema.parse(data);
          const hasVotes = Object.values(this.gameState.players).some(p => p.vote !== null);
          if (hasVotes) return; // Do not allow changing deck if a vote is in progress
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
    } catch (err) {
      console.error("Failed to process message:", err);
    }
  }

  async onClose(connection: Connection) {
    delete this.gameState.players[connection.id];
    this.rateLimits.delete(connection.id);
    this.broadcast(JSON.stringify({ type: "STATE", state: this.gameState }));
    await this.ctx.storage.put("gameState", this.gameState);
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

    let average: number | null = null;
    let agreement: 'full' | 'close' | 'split' = 'split';

    if (numericVotes.length > 0) {
      const sum = numericVotes.reduce((acc, v) => acc + v, 0);
      average = Number((sum / numericVotes.length).toFixed(1));

      const min = Math.min(...numericVotes);
      const max = Math.max(...numericVotes);
      
      // Simple agreement logic for fibonacci-ish sequences
      if (min === max) {
        agreement = 'full';
      } else if (max - min <= 2 || (min === 1 && max === 3) || (min === 2 && max === 5)) {
         // This is a rough proxy. We can refine it. Close means adjacent fibonacci numbers generally.
        agreement = 'close';
      } else {
        agreement = 'split';
      }
    } else {
      // If we're using t-shirts, we can just do exact match for 'full'
      const uniqueVotes = new Set(Object.values(votes));
      if (uniqueVotes.size === 1 && uniqueVotes.size > 0) {
         agreement = 'full';
      } else if (uniqueVotes.size === 2) {
         agreement = 'close';
      }
    }

    return {
      roundNumber,
      average,
      agreement,
      timestamp: Date.now()
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Origin check for WebSocket upgrade requests
    if (request.headers.get("Upgrade") === "websocket") {
      const origin = request.headers.get("Origin");
      const raw = env.ALLOWED_ORIGINS ?? "https://planningpoker.mavz.eu";
      const allowed = raw.split(",").map(s => s.trim());
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
