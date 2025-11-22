'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type GameStatus = 'idle' | 'running' | 'paused' | 'over';

type EntityType = 'data' | 'firewall' | 'virus';

interface Entity {
  id: number;
  type: EntityType;
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
  amplitude?: number;
  phase?: number;
}

interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  vy: number;
  vx: number;
  onGround: boolean;
  shieldCharges: number;
  invulnerableUntil: number;
}

interface LevelConfig {
  level: number;
  speedScale: number;
  obstacleInterval: number;
  virusInterval: number;
  dataInterval: number;
  label: string;
}

interface LeaderboardEntry {
  name: string;
  score: number;
  timestamp: number;
}

interface HudState {
  score: number;
  level: number;
  upgradePoints: number;
  shields: number;
}

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
const GROUND_HEIGHT = 120;
const GRAVITY = 0.6;
const MAX_LEADERS = 5;
const STORAGE_KEY = 'cyber-runner-leaderboard';
const NAME_KEY = 'cyber-runner-handle';

const LEVELS: LevelConfig[] = [
  { level: 1, speedScale: 1, obstacleInterval: 1600, virusInterval: 2900, dataInterval: 1100, label: 'Boot Sequence' },
  { level: 2, speedScale: 1.35, obstacleInterval: 1400, virusInterval: 2400, dataInterval: 950, label: 'Firewall Breach' },
  { level: 3, speedScale: 1.7, obstacleInterval: 1150, virusInterval: 1900, dataInterval: 820, label: 'Cyber Overload' },
];

type Inputs = {
  left: boolean;
  right: boolean;
  jumpQueued: boolean;
};

type UpgradeState = {
  speed: number;
  jump: number;
  shield: number;
};

type AudioHandles = {
  context: AudioContext;
  music?: { stop: () => void };
};

type World = {
  status: GameStatus;
  player: Player;
  entities: Entity[];
  lastFrame: number;
  lastSpawn: {
    firewall: number;
    virus: number;
    data: number;
  };
  score: number;
  upgradePoints: number;
  level: number;
  inputs: Inputs;
  animation?: number;
};

const initialPlayer = (shieldCharges: number): Player => ({
  x: 160,
  y: CANVAS_HEIGHT - GROUND_HEIGHT - 72,
  width: 48,
  height: 72,
  vy: 0,
  vx: 0,
  onGround: true,
  shieldCharges,
  invulnerableUntil: 0,
});

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const getLevel = (score: number): LevelConfig => {
  if (score >= 1600) return LEVELS[2];
  if (score >= 600) return LEVELS[1];
  return LEVELS[0];
};

const createUniqueId = (() => {
  let id = 0;
  return () => {
    id += 1;
    return id;
  };
})();

const createPlayerGradient = (ctx: CanvasRenderingContext2D, x: number, y: number, height: number) => {
  const gradient = ctx.createLinearGradient(x, y, x, y + height);
  gradient.addColorStop(0, '#38bdf8');
  gradient.addColorStop(0.5, '#a855f7');
  gradient.addColorStop(1, '#f472b6');
  return gradient;
};

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const playTone = (ctx: AudioContext, frequency: number, duration = 0.25, type: OscillatorType = 'sine') => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.value = 0.001;
  gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.02);
  gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration + 0.05);
};

const startMusic = (ctx: AudioContext) => {
  const oscillators: OscillatorNode[] = [];
  const gains: GainNode[] = [];
  const baseFreqs = [110, 220, 330];
  baseFreqs.forEach((freq, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = idx === 0 ? 'sawtooth' : 'triangle';
    osc.frequency.value = freq;
    gain.gain.value = idx === 0 ? 0.02 : 0.012;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.2 + idx * 0.18;
    lfoGain.gain.value = freq * 0.08;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    oscillators.push(osc);
    gains.push(gain);
  });
  return {
    stop: () => {
      oscillators.forEach((osc) => {
        try {
          osc.stop();
        } catch (err) {
          console.warn(err);
        }
      });
      gains.forEach((gain) => gain.disconnect());
    },
  };
};

const spawnFirewall = (level: LevelConfig): Entity => ({
  id: createUniqueId(),
  type: 'firewall',
  x: CANVAS_WIDTH + 40,
  y: CANVAS_HEIGHT - GROUND_HEIGHT - 60,
  width: 50,
  height: 60,
  speed: 4.2 * level.speedScale,
});

const spawnVirus = (level: LevelConfig): Entity => ({
  id: createUniqueId(),
  type: 'virus',
  x: CANVAS_WIDTH + 40,
  y: CANVAS_HEIGHT - GROUND_HEIGHT - 140,
  width: 54,
  height: 54,
  speed: 3.8 * level.speedScale,
  amplitude: 26 + level.level * 6,
  phase: Math.random() * Math.PI * 2,
});

const spawnDataPacket = (level: LevelConfig): Entity => ({
  id: createUniqueId(),
  type: 'data',
  x: CANVAS_WIDTH + 40,
  y: CANVAS_HEIGHT - GROUND_HEIGHT - (Math.random() > 0.45 ? 180 : 90),
  width: 36,
  height: 36,
  speed: 4.1 * level.speedScale,
  amplitude: 18,
  phase: Math.random() * Math.PI * 2,
});

const drawBackground = (ctx: CanvasRenderingContext2D, level: LevelConfig, frame: number) => {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
  if (level.level === 1) {
    gradient.addColorStop(0, '#0f172a');
    gradient.addColorStop(1, '#1e293b');
  } else if (level.level === 2) {
    gradient.addColorStop(0, '#1d1b4f');
    gradient.addColorStop(1, '#11192a');
  } else {
    gradient.addColorStop(0, '#2d0a4d');
    gradient.addColorStop(1, '#051119');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.save();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)';
  ctx.lineWidth = 1;
  const offset = (frame / 5) % 60;
  for (let x = -60 + offset; x < CANVAS_WIDTH + 60; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 30, CANVAS_HEIGHT);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = 'rgba(15, 118, 110, 0.25)';
  ctx.fillRect(0, CANVAS_HEIGHT - GROUND_HEIGHT, CANVAS_WIDTH, GROUND_HEIGHT);
};

const drawEntity = (ctx: CanvasRenderingContext2D, entity: Entity, frame: number) => {
  ctx.save();
  if (entity.type === 'firewall') {
    ctx.fillStyle = 'rgba(248, 113, 113, 0.85)';
    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y + entity.height);
    ctx.lineTo(entity.x + entity.width * 0.25, entity.y);
    ctx.lineTo(entity.x + entity.width * 0.5, entity.y + entity.height * 0.2);
    ctx.lineTo(entity.x + entity.width * 0.75, entity.y);
    ctx.lineTo(entity.x + entity.width, entity.y + entity.height);
    ctx.closePath();
    ctx.fill();
  } else if (entity.type === 'virus') {
    const pulse = Math.sin(frame / 8 + (entity.phase ?? 0)) * 4;
    ctx.translate(entity.x + entity.width / 2, entity.y + entity.height / 2);
    ctx.rotate(Math.sin(frame / 18 + (entity.phase ?? 0)) * 0.3);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.beginPath();
    ctx.arc(0, 0, entity.width / 2 + pulse * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, entity.width / 2 + pulse * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const bob = Math.sin(frame / 6 + (entity.phase ?? 0)) * 4;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.fillRect(entity.x, entity.y + bob, entity.width, entity.height);
    ctx.fillStyle = 'rgba(14, 165, 233, 0.5)';
    ctx.fillRect(entity.x + 6, entity.y + bob + 6, entity.width - 12, entity.height - 12);
    ctx.fillStyle = 'rgba(244, 114, 182, 0.6)';
    ctx.fillRect(entity.x + 12, entity.y + bob + 12, entity.width - 24, entity.height - 24);
  }
  ctx.restore();
};

const CyberRunnerGame = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const hudRef = useRef<HudState>({ score: 0, level: 1, upgradePoints: 0, shields: 0 });
  const [hud, setHud] = useState(hudRef.current);
  const [status, setStatus] = useState<GameStatus>('idle');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [playerName, setPlayerName] = useState('Cipher');
  const [upgrades, setUpgrades] = useState<UpgradeState>({ speed: 0, jump: 0, shield: 1 });
  const upgradesRef = useRef<UpgradeState>({ speed: 0, jump: 0, shield: 1 });
  const audioRef = useRef<AudioHandles | null>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed: LeaderboardEntry[] = JSON.parse(stored);
        setLeaderboard(parsed);
      } catch (error) {
        console.warn('Failed to parse leaderboard', error);
      }
    }
    const storedName = window.localStorage.getItem(NAME_KEY);
    if (storedName) {
      setPlayerName(storedName);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(NAME_KEY, playerName);
  }, [playerName]);

  useEffect(() => {
    upgradesRef.current = upgrades;
  }, [upgrades]);

  const ensureAudio = useCallback(async () => {
    if (typeof window === 'undefined') return;
    try {
      if (!audioRef.current) {
        const context = new window.AudioContext();
        audioRef.current = { context };
      }
      const handles = audioRef.current;
      if (!handles) return;
      if (handles.context.state === 'suspended') {
        await handles.context.resume();
      }
      if (!handles.music) {
        handles.music = startMusic(handles.context);
      }
    } catch (error) {
      console.warn('Audio init failed', error);
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (!audioRef.current) return;
    try {
      audioRef.current.music?.stop();
      audioRef.current.music = undefined;
      audioRef.current.context.suspend().catch(() => null);
    } catch (error) {
      console.warn('Audio stop failed', error);
    }
  }, []);

  const resetWorld = useCallback(
    (shieldCharges: number): World => ({
      status: 'idle',
      player: initialPlayer(shieldCharges),
      entities: [],
      lastFrame: performance.now(),
      lastSpawn: {
        firewall: 0,
        virus: 0,
        data: 0,
      },
      score: 0,
      upgradePoints: 0,
      level: 1,
      inputs: { left: false, right: false, jumpQueued: false },
    }),
    [],
  );

  const updateHud = useCallback((partial: Partial<HudState>) => {
    hudRef.current = { ...hudRef.current, ...partial };
    setHud(hudRef.current);
  }, []);

  const saveScore = useCallback(
    (score: number) => {
      setLeaderboard((prev) => {
        const next: LeaderboardEntry[] = [...prev, { name: playerName || 'Anonymous', score, timestamp: Date.now() }]
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_LEADERS);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        }
        return next;
      });
    },
    [playerName],
  );

  const startLoop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const world = worldRef.current;
    if (!world) return;
    const renderFrame = (timestamp: number) => {
      if (!worldRef.current) return;
      const currentWorld = worldRef.current;
      if (currentWorld.status !== 'running') return;
      const delta = timestamp - currentWorld.lastFrame;
      currentWorld.lastFrame = timestamp;
      frameRef.current += 1;
      const deltaScale = delta / (1000 / 60);
      const currentLevel = getLevel(currentWorld.score);
      currentWorld.level = currentLevel.level;
      const upgradeSnapshot = upgradesRef.current;

      const playerSpeedBase = 5 + upgradeSnapshot.speed * 1.4;
      const maxSpeed = 9 + upgradeSnapshot.speed * 1.2;
      const acceleration = 0.5 + upgradeSnapshot.speed * 0.12;

      if (currentWorld.inputs.left) {
        currentWorld.player.vx = clamp(
          currentWorld.player.vx - acceleration,
          -maxSpeed,
          maxSpeed,
        );
      } else if (currentWorld.inputs.right) {
        currentWorld.player.vx = clamp(
          currentWorld.player.vx + acceleration,
          -maxSpeed,
          maxSpeed,
        );
      } else {
        currentWorld.player.vx *= 0.92;
        if (Math.abs(currentWorld.player.vx) < 0.15) currentWorld.player.vx = 0;
      }

      if (Math.abs(currentWorld.player.vx) < playerSpeedBase * 0.35 && currentWorld.inputs.right) {
        currentWorld.player.vx = playerSpeedBase * 0.6;
      }

      currentWorld.player.x += currentWorld.player.vx * deltaScale;
      currentWorld.player.x = clamp(
        currentWorld.player.x,
        60,
        CANVAS_WIDTH - currentWorld.player.width - 80,
      );

      if (currentWorld.inputs.jumpQueued && currentWorld.player.onGround) {
        currentWorld.player.vy = -(12 + upgradeSnapshot.jump * 1.8);
        currentWorld.player.onGround = false;
        currentWorld.inputs.jumpQueued = false;
        if (audioRef.current) {
          playTone(audioRef.current.context, 520 + upgradeSnapshot.jump * 40, 0.18, 'triangle');
        }
      }

      currentWorld.player.vy += GRAVITY * deltaScale;
      currentWorld.player.y += currentWorld.player.vy * deltaScale;
      const groundY = CANVAS_HEIGHT - GROUND_HEIGHT - currentWorld.player.height;
      if (currentWorld.player.y >= groundY) {
        currentWorld.player.y = groundY;
        currentWorld.player.vy = 0;
        currentWorld.player.onGround = true;
      }

      const timeNow = performance.now();
      if (timestamp - currentWorld.lastSpawn.firewall > currentLevel.obstacleInterval) {
        currentWorld.entities.push(spawnFirewall(currentLevel));
        currentWorld.lastSpawn.firewall = timestamp;
      }
      if (timestamp - currentWorld.lastSpawn.virus > currentLevel.virusInterval) {
        currentWorld.entities.push(spawnVirus(currentLevel));
        currentWorld.lastSpawn.virus = timestamp;
      }
      if (timestamp - currentWorld.lastSpawn.data > currentLevel.dataInterval) {
        currentWorld.entities.push(spawnDataPacket(currentLevel));
        currentWorld.lastSpawn.data = timestamp;
      }

      currentWorld.entities = currentWorld.entities
        .map((entity) => {
          const updated = { ...entity };
          updated.x -= (entity.speed + upgradeSnapshot.speed * 0.6 + currentLevel.speedScale) * deltaScale * 4.2;
          if (entity.type !== 'firewall') {
            const amplitude = entity.amplitude ?? 0;
            const phase = entity.phase ?? 0;
            updated.y += Math.sin(frameRef.current / 16 + phase) * amplitude * 0.04 * deltaScale;
          }
          return updated;
        })
        .filter((entity) => entity.x + entity.width > -160);

      const player = currentWorld.player;
      currentWorld.entities.forEach((entity) => {
        const bob = entity.type === 'data' ? Math.sin(frameRef.current / 6 + (entity.phase ?? 0)) * 4 : 0;
        const entityY = entity.y + bob;
        const collides =
          player.x < entity.x + entity.width &&
          player.x + player.width > entity.x &&
          player.y < entityY + entity.height &&
          player.y + player.height > entityY;
        if (!collides) return;

        if (entity.type === 'data') {
          currentWorld.entities = currentWorld.entities.filter((e) => e.id !== entity.id);
          currentWorld.score += 120;
          currentWorld.upgradePoints += 1;
          if (audioRef.current) {
            playTone(audioRef.current.context, 880, 0.16, 'square');
          }
        } else {
          if (timeNow < currentWorld.player.invulnerableUntil) return;
          if (currentWorld.player.shieldCharges > 0) {
            currentWorld.player.shieldCharges -= 1;
            currentWorld.player.invulnerableUntil = timeNow + 1200;
            currentWorld.entities = currentWorld.entities.filter((e) => e.id !== entity.id);
            if (audioRef.current) {
              playTone(audioRef.current.context, 160, 0.3, 'sawtooth');
            }
          } else {
            currentWorld.status = 'over';
          }
        }
      });

      currentWorld.score += delta * 0.35 * currentLevel.speedScale;
      updateHud({
        score: Math.floor(currentWorld.score),
        level: currentLevel.level,
        upgradePoints: currentWorld.upgradePoints,
        shields: currentWorld.player.shieldCharges,
      });

      drawBackground(ctx, currentLevel, frameRef.current);

      const glow = ctx.createRadialGradient(
        player.x + player.width / 2,
        player.y + player.height / 2,
        8,
        player.x + player.width / 2,
        player.y + player.height / 2,
        120,
      );
      glow.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
      glow.addColorStop(1, 'rgba(2, 6, 23, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(player.x - 120, player.y - 120, 240, 240);

      ctx.fillStyle = createPlayerGradient(ctx, player.x, player.y, player.height);
      ctx.fillRect(player.x, player.y, player.width, player.height);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
      ctx.fillRect(player.x + player.width * 0.15, player.y + player.height * 0.25, 6, 18);
      ctx.fillRect(player.x + player.width * 0.45, player.y + player.height * 0.25, 6, 18);
      ctx.beginPath();
      ctx.moveTo(player.x + player.width * 0.2, player.y + player.height * 0.65);
      ctx.lineTo(player.x + player.width * 0.5, player.y + player.height * 0.75);
      ctx.lineTo(player.x + player.width * 0.8, player.y + player.height * 0.65);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.lineWidth = 4;
      ctx.stroke();

      if (player.invulnerableUntil > timeNow) {
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.8)';
        ctx.lineWidth = 6;
        drawRoundedRect(ctx, player.x - 6, player.y - 6, player.width + 12, player.height + 12, 12);
        ctx.stroke();
      }

      currentWorld.entities.forEach((entity) => drawEntity(ctx, entity, frameRef.current));

      if (currentWorld.status === 'running') {
        currentWorld.animation = window.requestAnimationFrame(renderFrame);
      } else {
        if (currentWorld.status === 'over') {
          setStatus('over');
          stopAudio();
          updateHud({ shields: 0 });
          saveScore(Math.floor(currentWorld.score));
        }
      }
    };

    world.animation = window.requestAnimationFrame(renderFrame);
  }, [saveScore, stopAudio, updateHud]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = CANVAS_WIDTH * dpr;
      canvas.height = CANVAS_HEIGHT * dpr;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!worldRef.current) return;
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
        worldRef.current.inputs.left = true;
      }
      if (event.code === 'ArrowRight' || event.code === 'KeyD') {
        worldRef.current.inputs.right = true;
      }
      if (event.code === 'Space' || event.code === 'ArrowUp' || event.code === 'KeyW') {
        worldRef.current.inputs.jumpQueued = true;
        event.preventDefault();
      }
      if (event.code === 'KeyP') {
        togglePause();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!worldRef.current) return;
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
        worldRef.current.inputs.left = false;
      }
      if (event.code === 'ArrowRight' || event.code === 'KeyD') {
        worldRef.current.inputs.right = false;
      }
      if (event.code === 'Space' || event.code === 'ArrowUp' || event.code === 'KeyW') {
        worldRef.current.inputs.jumpQueued = false;
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const startGame = useCallback(async () => {
    const shieldCharges = 1 + upgradesRef.current.shield;
    const world = resetWorld(shieldCharges);
    world.status = 'running';
    worldRef.current = world;
    frameRef.current = 0;
    updateHud({ score: 0, level: 1, upgradePoints: 0, shields: shieldCharges });
    setStatus('running');
    await ensureAudio();
    startLoop();
  }, [ensureAudio, resetWorld, startLoop, updateHud]);

  const togglePause = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    if (world.status === 'running') {
      world.status = 'paused';
      setStatus('paused');
      if (world.animation) window.cancelAnimationFrame(world.animation);
      stopAudio();
    } else if (world.status === 'paused') {
      world.status = 'running';
      world.lastFrame = performance.now();
      setStatus('running');
      ensureAudio();
      startLoop();
    }
  }, [ensureAudio, startLoop, stopAudio]);

  const restartGame = useCallback(() => {
    if (worldRef.current?.animation) {
      window.cancelAnimationFrame(worldRef.current.animation);
    }
    stopAudio();
    startGame();
  }, [startGame, stopAudio]);

  const applyUpgrade = useCallback(
    (type: keyof UpgradeState) => {
      const world = worldRef.current;
      if (!world || world.status === 'idle') return;
      const current = upgradesRef.current;
      const cost = 3 + current[type] * 2;
      if (world.upgradePoints < cost) return;
      const nextLevel = current[type] + 1;
      const nextUpgrades: UpgradeState = { ...current, [type]: nextLevel };
      upgradesRef.current = nextUpgrades;
      world.upgradePoints -= cost;
      setUpgrades(nextUpgrades);
      if (type === 'shield') {
        world.player.shieldCharges += 1;
        updateHud({ upgradePoints: world.upgradePoints, shields: world.player.shieldCharges });
      } else {
        updateHud({ upgradePoints: world.upgradePoints });
      }
      if (audioRef.current) {
        playTone(audioRef.current.context, 660 + nextLevel * 40, 0.15, 'square');
      }
    },
    [updateHud],
  );

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    if (world.player) {
      const shieldLevel = 1 + upgrades.shield;
      if (world.player.shieldCharges < shieldLevel) {
        world.player.shieldCharges = shieldLevel;
      }
    }
  }, [upgrades.shield]);

  const buttonBase = 'px-4 py-2 rounded-lg font-semibold transition focus:outline-none focus-visible:ring focus-visible:ring-cyan-400';

  const highestScore = useMemo(() => (leaderboard.length ? leaderboard[0].score : 0), [leaderboard]);
  const currentLevel = getLevel(hud.score);

  return (
    <div className="flex min-h-screen flex-col items-center justify-start gap-6 px-4 py-10">
      <div className="w-full max-w-6xl rounded-3xl border border-cyan-500/30 bg-slate-900/70 p-6 shadow-[0_20px_60px_rgba(15,118,110,0.25)] backdrop-blur">
        <header className="flex flex-col gap-2 border-b border-cyan-500/20 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-cyan-300">Cyber Runner</h1>
            <p className="text-sm text-slate-300">Infiltrate the grid, harvest data, outrun the firewall.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-300" htmlFor="runner-name">
              Handle
            </label>
            <input
              id="runner-name"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value.slice(0, 16))}
              className="h-10 rounded-lg border border-cyan-500/40 bg-slate-900/70 px-3 text-slate-100 outline-none focus:border-cyan-300"
              placeholder="Alias"
            />
          </div>
        </header>
        <section className="mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
          <div className="flex flex-col gap-4">
            <div className="aspect-[16/9] w-full overflow-hidden rounded-2xl border border-cyan-500/40 bg-slate-950/60 shadow-[inset_0_0_40px_rgba(14,116,144,0.35)]">
              <canvas ref={canvasRef} className="size-full" />
              {status !== 'running' && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950/70">
                  <h2 className="text-4xl font-bold text-cyan-200 drop-shadow-md">{status === 'idle' ? 'Press Start' : status === 'paused' ? 'Paused' : 'Game Over'}</h2>
                  <p className="max-w-sm text-center text-sm text-slate-300">
                    Collect glowing data packets, avoid firewalls and viruses. Use arrow keys to move, space to jump, P to pause.
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className={`${buttonBase} bg-cyan-400/90 text-slate-900 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-600/70 disabled:text-slate-300`}
                onClick={startGame}
                disabled={status === 'running'}
              >
                Start
              </button>
              <button
                className={`${buttonBase} border border-cyan-300/70 bg-transparent text-cyan-200 hover:bg-cyan-500/20 disabled:border-slate-600 disabled:text-slate-400`}
                onClick={togglePause}
                disabled={status === 'idle'}
              >
                {status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                className={`${buttonBase} bg-fuchsia-500/80 text-slate-950 hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:bg-slate-600/70`}
                onClick={restartGame}
                disabled={status === 'idle'}
              >
                Restart
              </button>
              <div className="ml-auto flex items-center gap-3 rounded-xl border border-cyan-500/30 bg-slate-900/70 px-4 py-2 text-sm text-slate-200">
                <span className="text-slate-400">Level</span>
                <span className="text-lg font-semibold text-cyan-200">{hud.level}</span>
                <span className="text-xs text-cyan-400">{currentLevel.label}</span>
              </div>
            </div>
          </div>
          <aside className="flex flex-col gap-4">
            <div className="rounded-2xl border border-cyan-500/30 bg-slate-900/60 p-4">
              <h3 className="text-lg font-semibold text-cyan-200">Telemetry</h3>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-200">
                <div className="rounded-xl border border-cyan-500/20 bg-slate-950/70 p-3">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Score</span>
                  <p className="text-2xl font-bold text-cyan-300">{hud.score.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-slate-950/70 p-3">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Best</span>
                  <p className="text-xl font-semibold text-emerald-300">{highestScore.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-slate-950/70 p-3">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Upgrade Chips</span>
                  <p className="text-xl font-semibold text-amber-300">{hud.upgradePoints}</p>
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-slate-950/70 p-3">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Shield</span>
                  <p className="text-xl font-semibold text-blue-300">{hud.shields}</p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-cyan-500/30 bg-slate-900/60 p-4">
              <h3 className="text-lg font-semibold text-cyan-200">Upgrades</h3>
              <p className="mt-1 text-xs text-slate-400">Each level costs chips. Earn them by collecting data packets.</p>
              <div className="mt-4 flex flex-col gap-3 text-sm">
                <button
                  onClick={() => applyUpgrade('speed')}
                  className={`${buttonBase} flex items-center justify-between bg-slate-950/70 text-left text-slate-200 hover:bg-cyan-500/10`}
                  disabled={status === 'idle'}
                >
                  <span>
                    <span className="block text-cyan-200">Speed Boost</span>
                    <span className="text-xs text-slate-400">Increase horizontal dash velocity.</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="text-xs text-slate-400">Lvl {upgrades.speed}</span>
                    <span className="text-sm font-semibold text-amber-300">Cost {3 + upgrades.speed * 2}c</span>
                  </span>
                </button>
                <button
                  onClick={() => applyUpgrade('jump')}
                  className={`${buttonBase} flex items-center justify-between bg-slate-950/70 text-left text-slate-200 hover:bg-cyan-500/10`}
                  disabled={status === 'idle'}
                >
                  <span>
                    <span className="block text-cyan-200">Jump Matrix</span>
                    <span className="text-xs text-slate-400">Amplify jump height for complex evasion.</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="text-xs text-slate-400">Lvl {upgrades.jump}</span>
                    <span className="text-sm font-semibold text-amber-300">Cost {3 + upgrades.jump * 2}c</span>
                  </span>
                </button>
                <button
                  onClick={() => applyUpgrade('shield')}
                  className={`${buttonBase} flex items-center justify-between bg-slate-950/70 text-left text-slate-200 hover:bg-cyan-500/10`}
                  disabled={status === 'idle'}
                >
                  <span>
                    <span className="block text-cyan-200">Quantum Shield</span>
                    <span className="text-xs text-slate-400">Add extra impact absorption charges.</span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="text-xs text-slate-400">Lvl {upgrades.shield}</span>
                    <span className="text-sm font-semibold text-amber-300">Cost {3 + upgrades.shield * 2}c</span>
                  </span>
                </button>
              </div>
            </div>
            <div className="rounded-2xl border border-cyan-500/30 bg-slate-900/60 p-4">
              <h3 className="text-lg font-semibold text-cyan-200">Leaderboard</h3>
              <ul className="mt-3 space-y-2 text-sm text-slate-200">
                {leaderboard.length === 0 && <li className="text-slate-400">No runs recorded yet.</li>}
                {leaderboard.map((entry, index) => (
                  <li
                    key={`${entry.name}-${entry.timestamp}`}
                    className="flex items-center justify-between rounded-xl border border-cyan-500/20 bg-slate-950/60 px-3 py-2"
                  >
                    <span>
                      <span className="text-xs uppercase text-slate-400">#{index + 1}</span>
                      <span className="ml-2 font-semibold text-cyan-200">{entry.name}</span>
                    </span>
                    <span className="text-amber-300">{entry.score.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
};

const Home = () => {
  return <CyberRunnerGame />;
};

export default Home;
