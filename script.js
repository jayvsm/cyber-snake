/**
 * ============================================================================
 * CYBER SNAKE // NEON PROTOCOL — Core Game Engine & UI Controller
 * ============================================================================
 * Architecture Overview:
 *  1. Configuration & State: Grid geometry, speed progression, and game state.
 *  2. Local Storage Leaderboard: Persistent Top 5 storage under "cyberSnakeLeaders".
 *  3. Web Audio Synthesizer: Lightweight procedural neon sound effects.
 *  4. Input Queueing: Prevents invalid 180-degree turns within a single tick.
 *  5. Fixed-Timestep Game Loop: requestAnimationFrame drives 60fps rendering,
 *     while an accumulated delta timer steps snake movement deterministically.
 *  6. Collision Detection: Wall bounds and self-intersection checks.
 *  7. HTML5 Canvas Renderer: Glowing grid, neon snake segments, pulsing food,
 *     and particle bursts on food consumption.
 * ============================================================================
 */

"use strict";

/* --------------------------------------------------------------------------
 * 1. CONSTANTS & CONFIGURATION
 * -------------------------------------------------------------------------- */

/** Local Storage key required for saving/retrieving Top 5 leaderboard scores. */
const LEADERBOARD_STORAGE_KEY = "cyberSnakeLeaders";

/** Maximum number of entries retained in the leaderboard. */
const MAX_LEADERBOARD_ENTRIES = 5;

/** Grid dimensions: 28x28 cells on a 560x560 canvas (20px per cell). */
const GRID_CELLS = 28;
const CELL_SIZE = 20;

/** Base tick interval in milliseconds (Level 1-9). */
const BASE_TICK_MS = 135;

/** Minimum tick interval cap so high-tier play remains humanly controllable. */
const MIN_TICK_MS = 45;

/** Amount of ms shaved off the tick interval each time a new 10-level tier is reached. */
const SPEED_STEP_MS = 18;

/** Cardinal direction vectors in grid coordinates. */
const DIRECTIONS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

/* --------------------------------------------------------------------------
 * 2. DOM ELEMENT REFERENCES
 * -------------------------------------------------------------------------- */

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

// HUD elements
const hudScore = document.getElementById("hud-score");
const hudLevel = document.getElementById("hud-level");
const hudSpeed = document.getElementById("hud-speed");
const hudHigh = document.getElementById("hud-high");
const speedAlert = document.getElementById("speed-alert");

// Overlay screens
const startScreen = document.getElementById("start-screen");
const pauseScreen = document.getElementById("pause-screen");
const gameoverScreen = document.getElementById("gameover-screen");
const leaderboardScreen = document.getElementById("leaderboard-screen");

// Inputs & outputs
const playerNameInput = document.getElementById("player-name");
const finalScoreEl = document.getElementById("final-score");
const finalLevelEl = document.getElementById("final-level");
const recordStatusEl = document.getElementById("record-status");
const leaderboardListEl = document.getElementById("leaderboard-list");

// Buttons
const btnInitialize = document.getElementById("btn-initialize");
const btnPause = document.getElementById("btn-pause");
const btnSound = document.getElementById("btn-sound");
const btnResume = document.getElementById("btn-resume");
const btnQuitToMenu = document.getElementById("btn-quit-to-menu");
const btnRestart = document.getElementById("btn-restart");
const btnBackStart = document.getElementById("btn-back-start");
const btnOpenLeaderboardStart = document.getElementById("btn-open-leaderboard-start");
const btnOpenLeaderboardOver = document.getElementById("btn-open-leaderboard-over");
const btnCloseLeaderboard = document.getElementById("btn-close-leaderboard");
const btnClearLeaderboard = document.getElementById("btn-clear-leaderboard");
const dpadButtons = document.querySelectorAll(".dpad-btn");

/* --------------------------------------------------------------------------
 * 3. MUTABLE GAME STATE
 * -------------------------------------------------------------------------- */

const gameState = {
  /** Current lifecycle phase: "START" | "PLAYING" | "PAUSED" | "GAMEOVER" | "LEADERBOARD" */
  mode: "START",
  /** Tracks which screen opened the leaderboard so "RETURN" goes back cleanly. */
  leaderboardReturnMode: "START",

  /** Ordered array of grid points { x, y }; index 0 is always the snake's head. */
  snake: [],
  /** Active movement vector applied on the current tick. */
  direction: { ...DIRECTIONS.RIGHT },
  /** Buffered directional inputs (max 2) to handle rapid consecutive keystrokes. */
  inputQueue: [],

  /** Current food node grid coordinates { x, y }. */
  food: { x: 18, y: 14 },

  /** Player telemetry for the active run. */
  score: 0,
  level: 1,
  speedTier: 1,
  tickIntervalMs: BASE_TICK_MS,

  /** Visual particle bursts spawned when food is consumed. */
  particles: [],

  /** Timing variables for the fixed-timestep accumulator inside requestAnimationFrame. */
  lastFrameTime: 0,
  accumulatorMs: 0,
  animationFrameId: null,

  /** Audio toggle state. */
  soundEnabled: true,
};

/* --------------------------------------------------------------------------
 * 4. PROCEDURAL WEB AUDIO SYNTHESIZER
 * -------------------------------------------------------------------------- */

let audioCtx = null;

/**
 * Lazily initializes the Web Audio API context on user interaction.
 * Browsers block AudioContext creation/playback until a user gesture occurs.
 */
function ensureAudioContext() {
  if (!audioCtx && gameState.soundEnabled) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

/**
 * Plays a synthesized neon tone using an oscillator and exponential gain envelope.
 *
 * @param {number} startFreq - Initial oscillator frequency in Hz.
 * @param {number} endFreq - Target frequency at the end of the tone.
 * @param {number} durationSec - Tone length in seconds.
 * @param {OscillatorType} waveType - Waveform ("sine", "triangle", "sawtooth", "square").
 * @param {number} volume - Peak gain level (0.0 to 1.0).
 */
function playSynthTone(startFreq, endFreq, durationSec, waveType = "triangle", volume = 0.08) {
  if (!gameState.soundEnabled) return;
  ensureAudioContext();
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = waveType;
  osc.frequency.setValueAtTime(startFreq, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 20), now + durationSec);

  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + durationSec);
}

/* --------------------------------------------------------------------------
 * 5. LOCAL STORAGE LEADERBOARD HANDLERS
 * -------------------------------------------------------------------------- */

/**
 * Retrieves and sanitizes the Top 5 leaderboard array from Local Storage.
 * Uses the required key "cyberSnakeLeaders".
 *
 * How it works:
 *  - Reads the raw JSON string from localStorage.getItem("cyberSnakeLeaders").
 *  - Parses it inside a try/catch block so corrupted storage never crashes the app.
 *  - Validates that the parsed value is an array, sorts descending by score,
 *    and slices to the top 5 records.
 *
 * @returns {Array<{name: string, score: number, level: number, date: string}>}
 */
function getLeaderboard() {
  try {
    const rawData = localStorage.getItem(LEADERBOARD_STORAGE_KEY);
    if (!rawData) return [];

    const parsed = JSON.parse(rawData);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          typeof entry.score === "number" &&
          Number.isFinite(entry.score)
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LEADERBOARD_ENTRIES);
  } catch (error) {
    console.warn("Failed to parse cyberSnakeLeaders from Local Storage:", error);
    return [];
  }
}

/**
 * Persists a completed run into Local Storage ("cyberSnakeLeaders") if score > 0,
 * keeping only the Top 5 highest scores sorted in descending order.
 *
 * @param {string} playerName - The player's callsign from the start screen input.
 * @param {number} score - Final score achieved in the run.
 * @param {number} level - Highest level reached in the run.
 * @returns {{qualified: boolean, rank: number}} Whether the score made Top 5 and its 1-based rank.
 */
function saveScoreToLeaderboard(playerName, score, level) {
  if (score <= 0) {
    return { qualified: false, rank: -1 };
  }

  const sanitizedName = (playerName || "NETRUNNER").trim().toUpperCase().slice(0, 12) || "NETRUNNER";
  const newEntry = {
    name: sanitizedName,
    score,
    level,
    date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  };

  const leaders = getLeaderboard();
  leaders.push(newEntry);

  // Sort descending by score; break ties by higher level reached.
  leaders.sort((a, b) => b.score - a.score || b.level - a.level);

  const topFive = leaders.slice(0, MAX_LEADERBOARD_ENTRIES);

  try {
    localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(topFive));
  } catch (error) {
    console.warn("Failed to save cyberSnakeLeaders to Local Storage:", error);
  }

  const rankIndex = topFive.indexOf(newEntry);
  return {
    qualified: rankIndex !== -1,
    rank: rankIndex !== -1 ? rankIndex + 1 : -1,
  };
}

/**
 * Clears all saved leaderboard entries from Local Storage and refreshes the UI.
 */
function clearLeaderboardData() {
  try {
    localStorage.removeItem(LEADERBOARD_STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to clear cyberSnakeLeaders from Local Storage:", error);
  }
  renderLeaderboard();
  updateHighScoreHUD();
}

/**
 * Builds the DOM list items for the Top 5 Leaderboard screen.
 * Uses textContent instead of innerHTML for user-supplied callsigns to prevent XSS.
 */
function renderLeaderboard() {
  const leaders = getLeaderboard();
  leaderboardListEl.innerHTML = "";

  if (leaders.length === 0) {
    const emptyState = document.createElement("li");
    emptyState.className = "leaderboard-empty";
    emptyState.textContent = "NO DATA RECORDED IN LOCAL STORAGE. INITIALIZE A RUN TO CLAIM RANK #1.";
    leaderboardListEl.appendChild(emptyState);
    return;
  }

  leaders.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = `leaderboard-item ${index === 0 ? "rank-1" : ""}`;

    const rankEl = document.createElement("span");
    rankEl.className = "leaderboard-rank";
    rankEl.textContent = `#${index + 1}`;

    const metaEl = document.createElement("div");
    metaEl.className = "leaderboard-meta";

    const nameEl = document.createElement("span");
    nameEl.className = "leaderboard-name";
    nameEl.textContent = entry.name;

    const subEl = document.createElement("span");
    subEl.className = "leaderboard-sub";
    subEl.textContent = `LVL ${entry.level || 1} • ${entry.date || "LOGGED"}`;

    metaEl.appendChild(nameEl);
    metaEl.appendChild(subEl);

    const scoreEl = document.createElement("span");
    scoreEl.className = "leaderboard-score";
    scoreEl.textContent = entry.score.toLocaleString();

    item.appendChild(rankEl);
    item.appendChild(metaEl);
    item.appendChild(scoreEl);

    leaderboardListEl.appendChild(item);
  });
}

/**
 * Updates the "HIGH" metric in the top HUD from the #1 score in Local Storage.
 */
function updateHighScoreHUD() {
  const leaders = getLeaderboard();
  const topScore = leaders.length > 0 ? leaders[0].score : 0;
  hudHigh.textContent = Math.max(topScore, gameState.score).toLocaleString();
}

/* --------------------------------------------------------------------------
 * 6. SCREEN & UI NAVIGATION
 * -------------------------------------------------------------------------- */

/**
 * Transitions the visible overlay screen and updates gameState.mode.
 *
 * @param {"START" | "PLAYING" | "PAUSED" | "GAMEOVER" | "LEADERBOARD"} nextMode
 */
function setScreenMode(nextMode) {
  gameState.mode = nextMode;

  startScreen.classList.toggle("active", nextMode === "START");
  pauseScreen.classList.toggle("active", nextMode === "PAUSED");
  gameoverScreen.classList.toggle("active", nextMode === "GAMEOVER");
  leaderboardScreen.classList.toggle("active", nextMode === "LEADERBOARD");

  // Pause button is only interactive during an active or paused run.
  const inRun = nextMode === "PLAYING" || nextMode === "PAUSED";
  btnPause.disabled = !inRun;
  btnPause.textContent = nextMode === "PAUSED" ? "RESUME" : "PAUSE";
}

/**
 * Synchronizes score, level, speed tier, and high score values to the HUD.
 */
function syncHUD() {
  hudScore.textContent = gameState.score.toLocaleString();
  hudLevel.textContent = gameState.level;
  hudSpeed.textContent = `TIER ${gameState.speedTier}`;
  updateHighScoreHUD();
}

/**
 * Briefly displays a glowing neon toast when the player crosses a 10-level threshold.
 *
 * @param {number} tier - The newly unlocked speed tier.
 */
let speedAlertTimeout = null;
function showSpeedSurgeAlert(tier) {
  speedAlert.textContent = `SPEED SURGE // TIER ${tier}`;
  speedAlert.classList.remove("hidden");

  if (speedAlertTimeout) clearTimeout(speedAlertTimeout);
  speedAlertTimeout = setTimeout(() => {
    speedAlert.classList.add("hidden");
  }, 1800);
}

/* --------------------------------------------------------------------------
 * 7. SNAKE INITIALIZATION, FOOD SPAWNING & SPEED PROGRESSION
 * -------------------------------------------------------------------------- */

/**
 * Resets all gameplay variables and begins a fresh Cyber Snake run.
 */
function initializeGame() {
  ensureAudioContext();

  // Spawn a 4-segment snake near the center-left moving right.
  const startY = Math.floor(GRID_CELLS / 2);
  gameState.snake = [
    { x: 9, y: startY },
    { x: 8, y: startY },
    { x: 7, y: startY },
    { x: 6, y: startY },
  ];

  gameState.direction = { ...DIRECTIONS.RIGHT };
  gameState.inputQueue = [];
  gameState.score = 0;
  gameState.level = 1;
  gameState.speedTier = 1;
  gameState.tickIntervalMs = BASE_TICK_MS;
  gameState.particles = [];
  gameState.accumulatorMs = 0;
  gameState.lastFrameTime = performance.now();

  speedAlert.classList.add("hidden");
  spawnFood();
  syncHUD();
  setScreenMode("PLAYING");
  playSynthTone(240, 520, 0.14, "sine", 0.08);

  // Ensure a single requestAnimationFrame loop is running.
  if (!gameState.animationFrameId) {
    gameState.animationFrameId = requestAnimationFrame(gameLoop);
  }
}

/**
 * Places a food node on a random unoccupied grid cell.
 * Loops until it finds coordinates not currently occupied by any snake segment.
 */
function spawnFood() {
  const occupied = new Set(gameState.snake.map((seg) => `${seg.x},${seg.y}`));
  const freeCells = [];

  for (let x = 0; x < GRID_CELLS; x++) {
    for (let y = 0; y < GRID_CELLS; y++) {
      if (!occupied.has(`${x},${y}`)) {
        freeCells.push({ x, y });
      }
    }
  }

  // Fallback if the player fills the entire 28x28 grid.
  if (freeCells.length === 0) {
    triggerGameOver();
    return;
  }

  const randomIndex = Math.floor(Math.random() * freeCells.length);
  gameState.food = freeCells[randomIndex];
}

/**
 * Recalculates the snake's speed tier and tick interval based on the current level.
 * Requirement: Speed increases every 10 levels (Level 10, 20, 30, 40...).
 *
 * Calculation:
 *  - Levels 1–9   => Math.floor(level / 10) = 0 => Speed Tier 1 (135ms)
 *  - Levels 10–19 => Math.floor(level / 10) = 1 => Speed Tier 2 (117ms)
 *  - Levels 20–29 => Math.floor(level / 10) = 2 => Speed Tier 3 (99ms)
 *  - ...clamped at MIN_TICK_MS (45ms) so extreme levels stay playable.
 */
function updateSpeedProgression() {
  const newTier = Math.floor(gameState.level / 10) + 1;

  if (newTier > gameState.speedTier) {
    gameState.speedTier = newTier;
    gameState.tickIntervalMs = Math.max(
      MIN_TICK_MS,
      BASE_TICK_MS - (gameState.speedTier - 1) * SPEED_STEP_MS
    );
    showSpeedSurgeAlert(gameState.speedTier);
    playSynthTone(440, 880, 0.22, "triangle", 0.1);
  }
}

/* --------------------------------------------------------------------------
 * 8. INPUT HANDLING (KEYBOARD & TOUCH)
 * -------------------------------------------------------------------------- */

/**
 * Validates and queues a directional change.
 *
 * Why a queue is used:
 *  If the snake moves RIGHT and the player quickly presses UP then LEFT within
 *  one tick interval, checking only against `gameState.direction` would allow
 *  LEFT (an instant 180-degree reversal into its own neck). Checking against
 *  the last queued direction guarantees every turn is perpendicular and legal.
 *
 * @param {{x: number, y: number}} nextDir - Target direction vector from DIRECTIONS.
 */
function queueDirection(nextDir) {
  if (gameState.mode !== "PLAYING") return;

  const lastPlannedDir =
    gameState.inputQueue.length > 0
      ? gameState.inputQueue[gameState.inputQueue.length - 1]
      : gameState.direction;

  // Reject identical direction or exact 180-degree opposite vector.
  const isSame = nextDir.x === lastPlannedDir.x && nextDir.y === lastPlannedDir.y;
  const isOpposite = nextDir.x === -lastPlannedDir.x && nextDir.y === -lastPlannedDir.y;

  if (!isSame && !isOpposite && gameState.inputQueue.length < 2) {
    gameState.inputQueue.push(nextDir);
  }
}

/**
 * Handles keyboard shortcuts for movement, pausing, and quick initialization.
 *
 * @param {KeyboardEvent} event
 */
function handleKeyDown(event) {
  // Do not hijack keystrokes while typing a callsign in the input field.
  if (document.activeElement === playerNameInput) {
    if (event.key === "Enter") {
      initializeGame();
    }
    return;
  }

  switch (event.key) {
    case "ArrowUp":
    case "w":
    case "W":
      event.preventDefault();
      queueDirection(DIRECTIONS.UP);
      break;
    case "ArrowDown":
    case "s":
    case "S":
      event.preventDefault();
      queueDirection(DIRECTIONS.DOWN);
      break;
    case "ArrowLeft":
    case "a":
    case "A":
      event.preventDefault();
      queueDirection(DIRECTIONS.LEFT);
      break;
    case "ArrowRight":
    case "d":
    case "D":
      event.preventDefault();
      queueDirection(DIRECTIONS.RIGHT);
      break;
    case " ":
    case "p":
    case "P":
      if (gameState.mode === "PLAYING" || gameState.mode === "PAUSED") {
        event.preventDefault();
        togglePause();
      }
      break;
    case "Enter":
      if (gameState.mode === "START" || gameState.mode === "GAMEOVER") {
        initializeGame();
      }
      break;
  }
}

/**
 * Toggles between PLAYING and PAUSED states without losing run progress.
 */
function togglePause() {
  if (gameState.mode === "PLAYING") {
    setScreenMode("PAUSED");
  } else if (gameState.mode === "PAUSED") {
    gameState.lastFrameTime = performance.now();
    setScreenMode("PLAYING");
  }
}

/* --------------------------------------------------------------------------
 * 9. FIXED-TIMESTEP GAME LOOP & COLLISION DETECTION
 * -------------------------------------------------------------------------- */

/**
 * Main animation loop driven by requestAnimationFrame (~60 FPS).
 *
 * How the Game Loop Works:
 *  1. Computes `deltaMs` (elapsed real time since the previous animation frame).
 *  2. Adds `deltaMs` to `gameState.accumulatorMs` while in "PLAYING" mode.
 *  3. Whenever `accumulatorMs >= tickIntervalMs`, executes one deterministic
 *     grid step (`stepGameTick()`) and subtracts `tickIntervalMs`.
 *  4. Updates visual particle effects every frame for silky-smooth animations.
 *  5. Renders the canvas every frame so food pulses and particles stay at 60 FPS
 *     even when the snake moves on a slower grid cadence.
 *
 * @param {DOMHighResTimeStamp} timestamp - High-resolution timestamp from rAF.
 */
function gameLoop(timestamp) {
  const deltaMs = Math.min(timestamp - gameState.lastFrameTime, 100);
  gameState.lastFrameTime = timestamp;

  if (gameState.mode === "PLAYING") {
    gameState.accumulatorMs += deltaMs;

    while (gameState.accumulatorMs >= gameState.tickIntervalMs) {
      stepGameTick();
      gameState.accumulatorMs -= gameState.tickIntervalMs;

      // Stop stepping immediately if the tick caused a Game Over collision.
      if (gameState.mode !== "PLAYING") {
        gameState.accumulatorMs = 0;
        break;
      }
    }
  }

  updateParticles(deltaMs);
  renderCanvas(timestamp);

  gameState.animationFrameId = requestAnimationFrame(gameLoop);
}

/**
 * Advances the simulation by a single discrete grid tick:
 *  - Pops the next buffered direction from `inputQueue`.
 *  - Calculates the snake head's next coordinates.
 *  - Runs wall & self-collision checks.
 *  - Handles food consumption (growth, scoring, level-up, speed scaling).
 */
function stepGameTick() {
  if (gameState.inputQueue.length > 0) {
    gameState.direction = gameState.inputQueue.shift();
  }

  const currentHead = gameState.snake[0];
  const nextHead = {
    x: currentHead.x + gameState.direction.x,
    y: currentHead.y + gameState.direction.y,
  };

  const willEatFood =
    nextHead.x === gameState.food.x && nextHead.y === gameState.food.y;

  // Check collisions BEFORE committing the move.
  if (detectCollision(nextHead, willEatFood)) {
    triggerGameOver();
    return;
  }

  // Advance snake by inserting the new head at the front of the array.
  gameState.snake.unshift(nextHead);

  if (willEatFood) {
    // Snake grows by NOT popping the tail segment on this tick.
    gameState.level += 1;
    // Points scale with the active speed tier to reward surviving faster speeds.
    gameState.score += 10 * gameState.speedTier;

    spawnFoodParticles(gameState.food.x, gameState.food.y);
    playSynthTone(520, 780, 0.09, "sine", 0.08);

    updateSpeedProgression();
    spawnFood();
    syncHUD();
  } else {
    // Normal movement: remove the trailing tail segment to preserve length.
    gameState.snake.pop();
  }
}

/**
 * Detects whether the snake's proposed head position results in a fatal collision.
 *
 * Collision Rules:
 *  1. Wall Collision: Out of bounds when x < 0, x >= GRID_CELLS, y < 0, or y >= GRID_CELLS.
 *  2. Self Collision: Head overlaps any occupied body segment.
 *     Note: If the snake is NOT eating food on this tick, its current tail tip
 *     will vacate its cell simultaneously, so we exclude the last segment from
 *     the self-collision check to allow tight tail-chasing maneuvers.
 *
 * @param {{x: number, y: number}} head - Proposed next grid coordinate for the head.
 * @param {boolean} isGrowing - True if food is on the target cell (tail stays put).
 * @returns {boolean} True if a collision occurred.
 */
function detectCollision(head, isGrowing) {
  // 1. Arena boundary check
  if (head.x < 0 || head.x >= GRID_CELLS || head.y < 0 || head.y >= GRID_CELLS) {
    return true;
  }

  // 2. Snake body overlap check
  const checkLimit = isGrowing ? gameState.snake.length : gameState.snake.length - 1;
  for (let i = 0; i < checkLimit; i++) {
    const segment = gameState.snake[i];
    if (segment.x === head.x && segment.y === head.y) {
      return true;
    }
  }

  return false;
}

/**
 * Ends the active run, records the score to Local Storage, and opens the Game Over screen.
 */
function triggerGameOver() {
  playSynthTone(210, 55, 0.35, "sawtooth", 0.11);

  finalScoreEl.textContent = gameState.score.toLocaleString();
  finalLevelEl.textContent = gameState.level;

  const result = saveScoreToLeaderboard(
    playerNameInput.value,
    gameState.score,
    gameState.level
  );

  if (result.qualified) {
    recordStatusEl.textContent =
      result.rank === 1
        ? "NEW SYSTEM RECORD // RANK #1 LOGGED"
        : `TOP 5 QUALIFIER // RANK #${result.rank} LOGGED`;
    recordStatusEl.classList.remove("hidden");
  } else {
    recordStatusEl.classList.add("hidden");
  }

  updateHighScoreHUD();
  setScreenMode("GAMEOVER");
}

/* --------------------------------------------------------------------------
 * 10. PARTICLE EFFECTS & HTML5 CANVAS RENDERING
 * -------------------------------------------------------------------------- */

/**
 * Emits neon spark particles centered on the consumed food cell.
 *
 * @param {number} gridX - Grid X index of eaten food.
 * @param {number} gridY - Grid Y index of eaten food.
 */
function spawnFoodParticles(gridX, gridY) {
  const centerX = gridX * CELL_SIZE + CELL_SIZE / 2;
  const centerY = gridY * CELL_SIZE + CELL_SIZE / 2;

  for (let i = 0; i < 14; i++) {
    const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.3;
    const speed = 1.2 + Math.random() * 2.4;
    gameState.particles.push({
      x: centerX,
      y: centerY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      color: i % 2 === 0 ? "#ff007f" : "#00f3ff",
    });
  }
}

/**
 * Updates particle positions and fades their opacity over time.
 *
 * @param {number} deltaMs - Elapsed frame time in milliseconds.
 */
function updateParticles(deltaMs) {
  const decay = deltaMs / 420;
  for (let i = gameState.particles.length - 1; i >= 0; i--) {
    const p = gameState.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= decay;

    if (p.life <= 0) {
      gameState.particles.splice(i, 1);
    }
  }
}

/**
 * Draws the entire game board onto the HTML5 Canvas:
 *  - Dark background & subtle glowing cyberpunk grid lines
 *  - Pulsing magenta food node
 *  - Neon cyan-to-violet gradient snake with glowing head & directional eyes
 *  - Active particle bursts
 *
 * @param {DOMHighResTimeStamp} timestamp - Used for pulsing glow animations.
 */
function renderCanvas(timestamp) {
  const width = canvas.width;
  const height = canvas.height;

  // Clear board with deep void backdrop
  ctx.fillStyle = "#060913";
  ctx.fillRect(0, 0, width, height);

  // Draw subtle neon grid lines
  ctx.strokeStyle = "rgba(0, 243, 255, 0.065)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < GRID_CELLS; i++) {
    const pos = i * CELL_SIZE + 0.5;
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, height);
    ctx.moveTo(0, pos);
    ctx.lineTo(width, pos);
  }
  ctx.stroke();

  // Draw pulsing food node (skip if no run has initialized yet)
  if (gameState.snake.length > 0) {
    const pulse = 0.78 + Math.sin(timestamp * 0.008) * 0.22;
    const fx = gameState.food.x * CELL_SIZE + CELL_SIZE / 2;
    const fy = gameState.food.y * CELL_SIZE + CELL_SIZE / 2;
    const radius = (CELL_SIZE * 0.34) * pulse;

    ctx.save();
    ctx.shadowColor = "#ff007f";
    ctx.shadowBlur = 16;
    ctx.fillStyle = "#ff007f";
    ctx.beginPath();
    ctx.arc(fx, fy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Inner bright core
    ctx.fillStyle = "#ffd1e8";
    ctx.beginPath();
    ctx.arc(fx, fy, radius * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Draw snake segments from tail to head so head glow sits cleanly on top
  const totalSegments = gameState.snake.length;
  for (let i = totalSegments - 1; i >= 0; i--) {
    const seg = gameState.snake[i];
    const px = seg.x * CELL_SIZE + 2;
    const py = seg.y * CELL_SIZE + 2;
    const size = CELL_SIZE - 4;
    const isHead = i === 0;

    // Color shifts smoothly along the snake's body from cyan head to electric blue/magenta tail
    const progress = totalSegments > 1 ? i / (totalSegments - 1) : 0;
    const hue = 182 + progress * 115; // 182 (cyan) -> 297 (magenta/violet)

    ctx.save();
    ctx.fillStyle = isHead ? "#7df9ff" : `hsl(${hue}, 100%, 56%)`;
    ctx.shadowColor = isHead ? "#00f3ff" : `hsl(${hue}, 100%, 50%)`;
    ctx.shadowBlur = isHead ? 16 : 8;

    drawRoundedRect(ctx, px, py, size, size, isHead ? 6 : 4);
    ctx.fill();

    // Draw cybernetic visor eyes on the snake head aligned with movement direction
    if (isHead) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#05070e";
      const eyeOffset = 4;
      const cx = seg.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = seg.y * CELL_SIZE + CELL_SIZE / 2;
      const dx = gameState.direction.x;
      const dy = gameState.direction.y;

      // Perpendicular vector to space the two eyes apart
      const perpX = -dy;
      const perpY = dx;

      ctx.beginPath();
      ctx.arc(cx + dx * 3 + perpX * eyeOffset, cy + dy * 3 + perpY * eyeOffset, 2, 0, Math.PI * 2);
      ctx.arc(cx + dx * 3 - perpX * eyeOffset, cy + dy * 3 - perpY * eyeOffset, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Draw active food burst particles
  for (const p of gameState.particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    ctx.restore();
  }
}

/**
 * Helper to draw a rounded rectangle path on a 2D canvas context.
 */
function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

/* --------------------------------------------------------------------------
 * 11. EVENT BINDINGS & BOOTSTRAP
 * -------------------------------------------------------------------------- */

function openLeaderboard(returnMode) {
  gameState.leaderboardReturnMode = returnMode;
  renderLeaderboard();
  setScreenMode("LEADERBOARD");
}

btnInitialize.addEventListener("click", initializeGame);
btnRestart.addEventListener("click", initializeGame);
btnPause.addEventListener("click", togglePause);
btnResume.addEventListener("click", togglePause);

btnQuitToMenu.addEventListener("click", () => {
  setScreenMode("START");
});

btnBackStart.addEventListener("click", () => {
  setScreenMode("START");
});

btnOpenLeaderboardStart.addEventListener("click", () => openLeaderboard("START"));
btnOpenLeaderboardOver.addEventListener("click", () => openLeaderboard("GAMEOVER"));
btnCloseLeaderboard.addEventListener("click", () => {
  setScreenMode(gameState.leaderboardReturnMode);
});

btnClearLeaderboard.addEventListener("click", clearLeaderboardData);

btnSound.addEventListener("click", () => {
  gameState.soundEnabled = !gameState.soundEnabled;
  btnSound.textContent = gameState.soundEnabled ? "SFX: ON" : "SFX: OFF";
  btnSound.classList.toggle("active", gameState.soundEnabled);
});

// Touch / mobile D-pad controls
dpadButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const dirKey = button.dataset.dir;
    if (DIRECTIONS[dirKey]) {
      queueDirection(DIRECTIONS[dirKey]);
    }
  });
});

// Swipe gesture support on the canvas for mobile play
let touchStartX = 0;
let touchStartY = 0;
canvas.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length > 0) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  },
  { passive: true }
);

canvas.addEventListener(
  "touchend",
  (e) => {
    if (e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      queueDirection(dx > 0 ? DIRECTIONS.RIGHT : DIRECTIONS.LEFT);
    } else {
      queueDirection(dy > 0 ? DIRECTIONS.DOWN : DIRECTIONS.UP);
    }
  },
  { passive: true }
);

window.addEventListener("keydown", handleKeyDown);

// Initial UI hydration on page load
updateHighScoreHUD();
renderLeaderboard();
renderCanvas(performance.now());
