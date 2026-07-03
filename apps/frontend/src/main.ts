import Alpine from 'alpinejs';
import PartySocket from 'partysocket';
import type { GameState, Player } from './types';

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}

document.addEventListener('alpine:init', () => {
  Alpine.data('pokerApp', () => ({
    socket: null as PartySocket | null,
    roomId: '',
    playerName: localStorage.getItem('poker_name') ?? '',
    isNameModalOpen: !localStorage.getItem('poker_name'),
    copied: false,
    joinRoomId: '',
    myVote: null as string | null,
    gameState: { 
      players: {} as Record<string, Player>, 
      isRevealed: false, 
      deck: 'fibonacci', 
      lastRound: null,
      history: []
    } as GameState,
    cards: { 
      fibonacci: ['1','2','3','5','8','13','21','?','☕'], 
      tshirt: ['XS','S','M','L','XL','XXL','?'] 
    },

    get activeDeckCards() { 
      return this.cards[this.gameState.deck as 'fibonacci' | 'tshirt']; 
    },
    get playerList() { 
      return Object.values(this.gameState.players); 
    },
    get voteCount() { 
      return this.playerList.filter(p => p.vote !== null && !p.isSpectator).length; 
    },
    get eligibleCount() { 
      return this.playerList.filter(p => !p.isSpectator).length; 
    },
    get allVoted() { 
      return this.voteCount === this.eligibleCount && this.eligibleCount > 0; 
    },

    init() {
      const path = window.location.pathname.replace(/^\/|\/$/g, '');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      if (!path) {
        this.roomId = '';
        this.isNameModalOpen = false;
      } else if (!uuidRegex.test(path)) {
        window.history.replaceState({}, '', `/`);
        this.roomId = '';
        this.isNameModalOpen = false;
      } else {
        this.roomId = path;
        if (!this.isNameModalOpen) {
          this.connectToRoom();
        }
      }
      
      this.$watch('gameState.deck', () => {
        this.myVote = null;
      });
      this.$watch('gameState.isRevealed', (revealed) => {
        if (!revealed) {
          this.myVote = null;
        }
      });
    },

    submitName() {
      if (!this.playerName.trim()) return;
      localStorage.setItem('poker_name', this.playerName);
      this.isNameModalOpen = false;
      
      if (this.roomId) {
        if (!this.socket) {
          this.connectToRoom();
        } else if (this.socket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'JOIN', name: this.playerName }));
        }
      }
    },

    createRoom() {
      if (!this.playerName.trim()) { alert("Please enter a name first."); return; }
      localStorage.setItem('poker_name', this.playerName);
      this.roomId = crypto.randomUUID();
      window.history.pushState({}, '', `/${this.roomId}`);
      this.connectToRoom();
    },

    joinRoom() {
      if (!this.playerName.trim()) { alert("Please enter a name first."); return; }
      const cleanId = this.joinRoomId.trim();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(cleanId)) {
        alert("Invalid room ID format.");
        return;
      }
      localStorage.setItem('poker_name', this.playerName);
      this.roomId = cleanId;
      window.history.pushState({}, '', `/${this.roomId}`);
      this.connectToRoom();
    },

    connectToRoom() {
      const host = import.meta.env.VITE_PARTYKIT_HOST || 'localhost:8787';
      
      this.socket = new PartySocket({
        host: host,
        room: this.roomId,
        party: "planning-poker-server",
      });

      this.socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'STATE') {
            this.gameState = data.state;
          }
        } catch (err) {
          console.error("Failed to parse message", err);
        }
      });

      this.socket.addEventListener('open', () => {
        this.socket?.send(JSON.stringify({ type: 'JOIN', name: this.playerName }));
      });
    },

    castVote(value: string) {
      if (this.gameState.isRevealed) return;
      this.myVote = value;
      this.socket?.send(JSON.stringify({ type: 'VOTE', value }));
    },

    revealVotes() {
      this.socket?.send(JSON.stringify({ type: 'REVEAL' }));
    },

    resetTable() {
      this.socket?.send(JSON.stringify({ type: 'RESET' }));
    },
    

    setDeck(deck: string) {
      this.socket?.send(JSON.stringify({ type: 'SET_DECK', deck }));
    },
    
    shareRoom() {
      navigator.clipboard.writeText(window.location.href);
      this.copied = true;
      setTimeout(() => this.copied = false, 2000);
    }
  }));
});

window.Alpine = Alpine;
Alpine.start();
