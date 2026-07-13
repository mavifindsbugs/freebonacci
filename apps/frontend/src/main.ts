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
    darkMode: localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches),
    copied: false,
    joinRoomId: '',
    playerNameError: '',
    joinRoomIdError: '',
    collectedCookies: 0,
    myVote: null as string | null,
    gameState: {
      players: {} as Record<string, Player>,
      isRevealed: false,
      deck: 'fibonacci',
      history: [],
      roundCount: 0
    } as GameState,
    cards: {
      fibonacci: ['1', '2', '3', '5', '8', '13', '21', '?', '☕'],
      tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?']
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

    toggleTheme() {
      this.darkMode = !this.darkMode;
      localStorage.setItem('theme', this.darkMode ? 'dark' : 'light');
    },

    init() {
      this.$watch('darkMode', (val) => {
        if (val) document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      });
      if (this.darkMode) document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');

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
      if (!this.playerName.trim()) {
        this.playerNameError = "Please enter a name first.";
        setTimeout(() => this.playerNameError = '', 3000);
        return;
      }
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
      if (!this.playerName.trim()) {
        this.playerNameError = "Please enter a name first.";
        setTimeout(() => this.playerNameError = '', 3000);
        return;
      }
      localStorage.setItem('poker_name', this.playerName);
      this.roomId = crypto.randomUUID();
      window.history.pushState({}, '', `/${this.roomId}`);
      this.connectToRoom();
    },

    joinRoom() {
      if (!this.playerName.trim()) {
        this.playerNameError = "Please enter a name first.";
        setTimeout(() => this.playerNameError = '', 3000);
        return;
      }
      const cleanId = this.joinRoomId.trim();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(cleanId)) {
        this.joinRoomIdError = "Invalid room ID format.";
        setTimeout(() => this.joinRoomIdError = '', 3000);
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

function initFibonacciCanvas() {
  const canvas = document.getElementById('fib-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = window.innerWidth;
  let height = window.innerHeight;
  canvas.width = width;
  canvas.height = height;

  window.addEventListener('resize', () => {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  });

  const fibNumbers = ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '144', '☕', '?'];

  interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    text: string;
    size: number;
    opacity: number;
    isCookie?: boolean;
    isCollected?: boolean;
    isConfetti?: boolean;
    color?: string;
    angle?: number;
    spin?: number;
  }

  let particles: Particle[] = [];
  const numParticles = 50;

  for (let i = 0; i < numParticles; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      text: fibNumbers[Math.floor(Math.random() * fibNumbers.length)],
      size: Math.random() * 24 + 12,
      opacity: Math.random() * 0.15 + 0.05,
    });
  }

  // Easter egg cookies
  for (let i = 0; i < 5; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      text: '🍪',
      size: Math.random() * 14 + 20,
      opacity: 0,
      isCookie: true,
      isCollected: false,
    });
  }

  let localCollectedCookies = 0;

  function triggerConfetti() {
    const colors = ['#1982c4', '#ff595e', '#ffca3a', '#8ac926', '#6a4c93', '#f15bb5', '#00bbf9', '#00f5d4'];
    for (let i = 0; i < 150; i++) {
      const isLeft = i % 2 === 0;
      particles.push({
        x: isLeft ? -20 : width + 20,
        y: height,
        vx: (isLeft ? 1 : -1) * (Math.random() * 15 + 5),
        vy: -(Math.random() * 20 + 10),
        text: '',
        size: Math.random() * 10 + 6,
        opacity: 1,
        isConfetti: true,
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.4,
      });
    }
  }

  window.addEventListener('click', (e) => {
    if (canvas.offsetParent === null) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    particles.forEach(p => {
      if (p.isCookie && !p.isCollected && p.opacity > 0.1) {
        const dist = Math.sqrt(Math.pow(clickX - p.x, 2) + Math.pow(clickY - p.y, 2));
        if (dist < p.size * 1.5) { // generous hitbox
          p.isCollected = true;
          p.opacity = 1;
          localCollectedCookies++;
          window.dispatchEvent(new Event('cookie-collected'));
          if (localCollectedCookies === 5) {
            triggerConfetti();
          }
        }
      }
    });
  });

  let mouse = { x: -1000, y: -1000 };
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  // Move mouse offscreen when it leaves the window
  window.addEventListener('mouseout', () => {
    mouse = { x: -1000, y: -1000 };
  });

  function animate() {
    requestAnimationFrame(animate);

    // Check if landing page is visible. If not, don't draw
    if (canvas!.offsetParent === null) return;

    ctx!.clearRect(0, 0, width, height);

    const computedStyle = getComputedStyle(document.body);
    const accentColor = computedStyle.getPropertyValue('--color-accent').trim() || '#1982c4';

    let cardRect: DOMRect | null = null;
    const cardEl = document.getElementById('main-card');
    if (cardEl) {
      cardRect = cardEl.getBoundingClientRect();
    }

    let footerTop = height;
    const footerEl = document.querySelector('footer');
    if (footerEl && footerEl.offsetParent !== null) {
      footerTop = footerEl.getBoundingClientRect().top;
    }

    ctx!.textAlign = 'center';
    ctx!.textBaseline = 'middle';

    particles = particles.filter(p => !p.isConfetti || p.y <= height + 50);

    particles.forEach(p => {
      if (p.isConfetti) {
        p.vy += 0.4; // gravity
        p.x += p.vx;
        p.y += p.vy;
        p.angle = (p.angle || 0) + (p.spin || 0);

        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.angle);
        ctx!.fillStyle = p.color || accentColor;
        ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx!.restore();
        return;
      }

      // Basic movement
      p.x += p.vx;
      p.y += p.vy;

      // Handle edges
      if (p.isCookie) {
        if (p.x < 0) { p.x = 0; p.vx *= -1; }
        if (p.x > width) { p.x = width; p.vx *= -1; }
        if (p.y < 0) { p.y = 0; p.vy *= -1; }
        if (p.y > footerTop) { p.y = footerTop; p.vy *= -1; }

        if (cardRect) {
          const pad = p.size / 2;
          const left = cardRect.left - pad;
          const right = cardRect.right + pad;
          const top = cardRect.top - pad;
          const bottom = cardRect.bottom + pad;

          if (p.x > left && p.x < right && p.y > top && p.y < bottom) {
            const overlapLeft = p.x - left;
            const overlapRight = right - p.x;
            const overlapTop = p.y - top;
            const overlapBottom = bottom - p.y;

            const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

            if (minOverlap === overlapLeft) {
              p.x = left;
              p.vx = -Math.abs(p.vx);
            } else if (minOverlap === overlapRight) {
              p.x = right;
              p.vx = Math.abs(p.vx);
            } else if (minOverlap === overlapTop) {
              p.y = top;
              p.vy = -Math.abs(p.vy);
            } else if (minOverlap === overlapBottom) {
              p.y = bottom;
              p.vy = Math.abs(p.vy);
            }
          }
        }
      } else {
        // Wrap around screen smoothly
        if (p.x < -50) p.x = width + 50;
        if (p.x > width + 50) p.x = -50;
        if (p.y < -50) p.y = height + 50;
        if (p.y > height + 50) p.y = -50;
      }

      // Mouse interaction
      const dx = mouse.x - p.x;
      const dy = mouse.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxDist = 120;

      if (dist < maxDist && !p.isCollected) {
        if (p.isCookie) {
          p.opacity = Math.min(1, p.opacity + 0.05);
        } else {
          // Repel normal numbers
          const force = ((maxDist - dist) / maxDist) * 1.3;
          p.x -= (dx / dist) * force * 3;
          p.y -= (dy / dist) * force * 3;
        }
      } else if (p.isCookie && !p.isCollected) {
        p.opacity = Math.max(0, p.opacity - 0.02);
      }

      ctx!.fillStyle = p.isCookie ? '#fff' : accentColor;
      ctx!.globalAlpha = p.isCollected ? 1 : p.opacity;
      ctx!.font = p.isCookie ? `${p.size}px sans-serif` : `600 ${p.size}px Inter, sans-serif`;
      ctx!.fillText(p.text, p.x, p.y);
    });
    ctx!.globalAlpha = 1;
  }

  animate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFibonacciCanvas);
} else {
  initFibonacciCanvas();
}
