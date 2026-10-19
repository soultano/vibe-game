export const ACHIEVEMENTS = [
  // Conquest (Territory pixels)
  {
    id: 'cells_10', category: 'conquest', icon: '🚩', points: 10, target: 10,
    title: { ru: 'Первый форпост', en: 'First Outpost', uz: 'Birinchi istehkom' },
    desc: { ru: 'Захватить 10 ячеек территории', en: 'Capture 10 territory cells', uz: '10 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(10, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 10,
  },
  {
    id: 'cells_50', category: 'conquest', icon: '🛡️', points: 15, target: 50,
    title: { ru: 'Пограничный дозор', en: 'Border Guard', uz: 'Chegara qo‘riqchisi' },
    desc: { ru: 'Захватить 50 ячеек территории', en: 'Capture 50 territory cells', uz: '50 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(50, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 50,
  },
  {
    id: 'cells_100', category: 'conquest', icon: '⚔️', points: 25, target: 100,
    title: { ru: 'Барон фронтира', en: 'Frontier Baron', uz: 'Frontir baroni' },
    desc: { ru: 'Захватить 100 ячеек территории', en: 'Capture 100 territory cells', uz: '100 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(100, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 100,
  },
  {
    id: 'cells_250', category: 'conquest', icon: '🏰', points: 50, target: 250,
    title: { ru: 'Владыка региона', en: 'Regional Warlord', uz: 'Mintaqa hukmdori' },
    desc: { ru: 'Захватить 250 ячеек территории', en: 'Capture 250 territory cells', uz: '250 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(250, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 250,
  },
  {
    id: 'cells_500', category: 'conquest', icon: '👑', points: 75, target: 500,
    title: { ru: 'Император Ташкента', en: 'Emperor of Tashkent', uz: 'Toshkent imperatori' },
    desc: { ru: 'Захватить 500 ячеек территории', en: 'Capture 500 territory cells', uz: '500 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(500, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 500,
  },
  {
    id: 'cells_1000', category: 'conquest', icon: '🌌', points: 100, target: 1000,
    title: { ru: 'Глобальный гегемон', en: 'Global Hegemon', uz: 'Global gegemon' },
    desc: { ru: 'Захватить 1000 ячеек территории', en: 'Capture 1000 territory cells', uz: '1000 ta hudud katakchasini egallang' },
    progress: (p) => Math.min(1000, Math.floor(p?.pixels || 0)),
    check: (p) => (p?.pixels || 0) >= 1000,
  },

  // Combat battles won
  {
    id: 'battles_3', category: 'combat', icon: '🗡️', points: 10, target: 3,
    title: { ru: 'Боевое крещение', en: 'Trial by Fire', uz: 'Jangovar cho‘qintirish' },
    desc: { ru: 'Одержать 3 победы в сражениях', en: 'Win 3 territory battles', uz: 'Janglarda 3 ta g‘alabaga erishing' },
    progress: (p) => Math.min(3, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 3,
  },
  {
    id: 'battles_5', category: 'combat', icon: '🎖️', points: 15, target: 5,
    title: { ru: 'Ветеран стычек', en: 'Skirmish Veteran', uz: 'To‘qnashuvlar faxriysi' },
    desc: { ru: 'Одержать 5 побед в сражениях', en: 'Win 5 territory battles', uz: 'Janglarda 5 ta g‘alabaga erishing' },
    progress: (p) => Math.min(5, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 5,
  },
  {
    id: 'battles_10', category: 'combat', icon: '🏆', points: 25, target: 10,
    title: { ru: 'Полководец', en: 'Battlefield Commander', uz: 'Sarkarda' },
    desc: { ru: 'Одержать 10 побед в сражениях', en: 'Win 10 territory battles', uz: 'Janglarda 10 ta g‘alabaga erishing' },
    progress: (p) => Math.min(10, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 10,
  },
  {
    id: 'battles_25', category: 'combat', icon: '🔥', points: 50, target: 25,
    title: { ru: 'Гроза фронтира', en: 'Frontier Scourge', uz: 'Frontir dahshati' },
    desc: { ru: 'Одержать 25 побед в сражениях', en: 'Win 25 territory battles', uz: 'Janglarda 25 ta g‘alabaga erishing' },
    progress: (p) => Math.min(25, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 25,
  },
  {
    id: 'battles_50', category: 'combat', icon: '⚡', points: 75, target: 50,
    title: { ru: 'Легенда войны', en: 'Legend of War', uz: 'Urush afsonasi' },
    desc: { ru: 'Одержать 50 побед в сражениях', en: 'Win 50 territory battles', uz: 'Janglarda 50 ta g‘alabaga erishing' },
    progress: (p) => Math.min(50, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 50,
  },
  {
    id: 'battles_100', category: 'combat', icon: '🌟', points: 100, target: 100,
    title: { ru: 'Непобедимый маршал', en: 'Invincible Marshal', uz: 'Yengilmas marshal' },
    desc: { ru: 'Одержать 100 побед в сражениях', en: 'Win 100 territory battles', uz: 'Janglarda 100 ta g‘alabaga erishing' },
    progress: (p) => Math.min(100, p?.battlesWon || 0),
    check: (p) => (p?.battlesWon || 0) >= 100,
  },

  // Base progression
  {
    id: 'level_3', category: 'base', icon: '🏗️', points: 10, target: 3,
    title: { ru: 'Инженер базы', en: 'Base Engineer', uz: 'Baza muhandisi' },
    desc: { ru: 'Развить штаб до 3 уровня', en: 'Upgrade HQ to level 3', uz: 'Bosh qarorgohni 3-bosqichga ko‘taring' },
    progress: (p) => Math.min(3, p?.level || 1),
    check: (p) => (p?.level || 1) >= 3,
  },
  {
    id: 'level_5', category: 'base', icon: '🏛️', points: 20, target: 5,
    title: { ru: 'Архитектор', en: 'Architect of Dominion', uz: 'Me’mor' },
    desc: { ru: 'Развить штаб до 5 уровня', en: 'Upgrade HQ to level 5', uz: 'Bosh qarorgohni 5-bosqichga ko‘taring' },
    progress: (p) => Math.min(5, p?.level || 1),
    check: (p) => (p?.level || 1) >= 5,
  },
  {
    id: 'level_10', category: 'base', icon: '💎', points: 50, target: 10,
    title: { ru: 'Неприступная цитадель', en: 'Impregnable Citadel', uz: 'Fath etilmas qal’a' },
    desc: { ru: 'Развить штаб до 10 уровня', en: 'Upgrade HQ to level 10', uz: 'Bosh qarorgohni 10-bosqichga ko‘taring' },
    progress: (p) => Math.min(10, p?.level || 1),
    check: (p) => (p?.level || 1) >= 10,
  },

  // Social / Referrals
  {
    id: 'ref_1', category: 'social', icon: '🤝', points: 15, target: 1,
    title: { ru: 'Первый соратник', en: 'First Comrade', uz: 'Birinchi safdosh' },
    desc: { ru: 'Пригласить 1 друга в игру', en: 'Invite 1 friend to the game', uz: 'O‘yinga 1 ta do‘stingizni taklif qiling' },
    progress: (p) => Math.min(1, p?.referralsCount || 0),
    check: (p) => (p?.referralsCount || 0) >= 1,
  },
  {
    id: 'ref_5', category: 'social', icon: '👥', points: 35, target: 5,
    title: { ru: 'Лидер альянса', en: 'Alliance Leader', uz: 'Ittifoq yetakchisi' },
    desc: { ru: 'Пригласить 5 друзей в игру', en: 'Invite 5 friends to the game', uz: 'O‘yinga 5 ta do‘stingizni taklif qiling' },
    progress: (p) => Math.min(5, p?.referralsCount || 0),
    check: (p) => (p?.referralsCount || 0) >= 5,
  },
  {
    id: 'ref_10', category: 'social', icon: '🌍', points: 75, target: 10,
    title: { ru: 'Верховный комиссар', en: 'Supreme Commissioner', uz: 'Oliy komissar' },
    desc: { ru: 'Пригласить 10 друзей в игру', en: 'Invite 10 friends to the game', uz: 'O‘yinga 10 ta do‘stingizni taklif qiling' },
    progress: (p) => Math.min(10, p?.referralsCount || 0),
    check: (p) => (p?.referralsCount || 0) >= 10,
  },
];

/**
 * World of Warcraft style triumph fanfare audio synthesis
 */
export function playAchievementFanfare() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // Triumphant brass notes sequence: G4 -> C5 -> E5 -> Major Triumph Chord
    const notes = [
      { time: 0.00, dur: 0.16, freq: 392.00 }, // G4
      { time: 0.16, dur: 0.16, freq: 523.25 }, // C5
      { time: 0.32, dur: 0.20, freq: 659.25 }, // E5
      { time: 0.52, dur: 2.00, freqs: [523.25, 659.25, 783.99, 1046.50] }, // C5 + E5 + G5 + C6
    ];

    for (const note of notes) {
      const freqs = note.freqs || [note.freq];
      for (const f of freqs) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now + note.time);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1200, now + note.time);
        filter.frequency.exponentialRampToValueAtTime(3200, now + note.time + 0.06);
        filter.frequency.exponentialRampToValueAtTime(1400, now + note.time + note.dur);

        gain.gain.setValueAtTime(0.0001, now + note.time);
        gain.gain.exponentialRampToValueAtTime(0.12, now + note.time + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.08, now + note.time + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.time + note.dur);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + note.time);
        osc.stop(now + note.time + note.dur + 0.05);
      }
    }
  } catch {}
}

/**
 * 2-3 second fireworks salute particle burst
 */
export function launchFireworks(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#ffd700', '#ff3366', '#00d4ff', '#00ff88', '#ffaa00', '#ffffff', '#e040fb'];

  const bursts = [
    { x: canvas.width * 0.5, y: canvas.height * 0.35 },
    { x: canvas.width * 0.32, y: canvas.height * 0.42 },
    { x: canvas.width * 0.68, y: canvas.height * 0.38 },
  ];

  bursts.forEach((burst, idx) => {
    setTimeout(() => {
      const burstColor = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < 55; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 6.5 + 2.5;
        particles.push({
          x: burst.x,
          y: burst.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: Math.random() > 0.3 ? burstColor : colors[Math.floor(Math.random() * colors.length)],
          alpha: 1,
          size: Math.random() * 3 + 2,
          gravity: 0.12,
          friction: 0.96,
        });
      }
    }, idx * 220);
  });

  const startTime = performance.now();

  function render(t) {
    const elapsed = t - startTime;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= p.friction;
      p.vy *= p.friction;
      p.alpha -= 0.015;

      if (p.alpha <= 0) {
        particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 6;
      ctx.shadowColor = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (elapsed < 3200 && particles.length > 0) {
      requestAnimationFrame(render);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(render);
}
