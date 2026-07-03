export interface Player {
  id: string;
  name: string;
  vote: string | null;
  isSpectator: boolean;
}

export interface RoundResult {
  average: number | null;
  agreement: 'full' | 'close' | 'split';
  timestamp: number;
}

export interface GameState {
  players: Record<string, Player>;
  isRevealed: boolean;
  deck: 'fibonacci' | 'tshirt';
  lastRound: RoundResult | null;
  history: RoundResult[];
}
