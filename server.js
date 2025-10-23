const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

let players = {};
let round = 1;
let gameStarted = false;
let hostId = null;
let phase = "lobby"; // lobby | main | guess
let timer = null;
let timeLeft = 0;

// Generar número único entre 1 y 20
function generateUniqueNumber(existing) {
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const used = Object.values(existing).filter(p => p.number).map(p => p.number);
  const available = numbers.filter(n => !used.includes(n));
  return available[Math.floor(Math.random() * available.length)];
}

// Asignar objetivo secreto a un fantasma
function assignGhostTarget(ghostId) {
  const candidates = Object.entries(players)
    .filter(([id, p]) => (p.alive || p.revived) && id !== ghostId)
    .map(([id]) => id);
  if (candidates.length === 0) return null;
  const targetId = candidates[Math.floor(Math.random() * candidates.length)];
  players[ghostId].ghostTarget = targetId;
}

// Enviar estado a todos los jugadores
function broadcastState() {
  io.emit("updatePlayers", { players, round, phase, hostId, gameStarted, timeLeft });
}

// Iniciar fase con temporizador
function startPhase(duration, nextPhase) {
  clearInterval(timer);
  timeLeft = duration;
  io.emit("timerUpdate", timeLeft);

  timer = setInterval(() => {
    timeLeft--;
    io.emit("timerUpdate", timeLeft);

    if (timeLeft <= 0) {
      clearInterval(timer);

      if (phase === "guess") {
        // Fase de adivinación terminada → fallos = fantasmas/eliminados
        for (let id in players) {
          const p = players[id];
          if (p.alive && !p.guessed) {
            if (p.revived) {
              // Si ya fue revivido y falla → eliminado
              p.alive = false;
              p.ghost = false;
              p.status = "eliminado";
            } else {
              // Primera vez que falla → fantasma
              p.alive = false;
              p.ghost = true;
              p.status = "fantasma";
              assignGhostTarget(id);
            }
          }
        }
      }

      // Pasar a la siguiente fase
      phase = nextPhase;

      if (nextPhase === "main") startPhase(900, "guess"); // 15 min fase principal

      broadcastState();
    }
  }, 1000);
}

// Iniciar siguiente ronda
function nextRound() {
  round++;
  phase = "main";

  for (let id in players) {
    const p = players[id];

    // Fantasma que cumple su objetivo revive al inicio de la ronda
    if (p.ghost && p.ghostTarget && !p.revived) {
      const target = players[p.ghostTarget];
      if (target && !target.alive) {
        p.ghost = false;
        p.alive = true;
        p.guessed = false;
        p.number = generateUniqueNumber(players);
        p.revived = true;
        p.status = "revivido";
        io.to(id).emit("revived"); // Mensaje al jugador revivido
      }
    }

    // Asignar nuevo número a los vivos y revividos
    if ((p.alive || p.revived) && !p.ghost) {
      p.guessed = false;
      p.number = generateUniqueNumber(players);
    }
  }

  startPhase(900, "guess");
  broadcastState();
}

// Conexión
io.on("connection", socket => {
  console.log("Jugador conectado:", socket.id);

  socket.on("joinGame", name => {
    if (!name) return;
    if (Object.values(players).some(p => p.name === name)) return socket.emit("errorMsg", "Nombre ya usado");
    const number = generateUniqueNumber(players);
    players[socket.id] = {
      name,
      number,
      alive: true,
      ghost: false,
      guessed: false,
      ghostTarget: null,
      revived: false,
      status: "vivo"
    };
    if (!hostId) hostId = socket.id;
    broadcastState();
  });

  socket.on("startGame", () => {
    if (socket.id !== hostId || gameStarted) return;
    gameStarted = true;
    round = 1;
    phase = "main";
    for (let id in players) {
      const p = players[id];
      p.guessed = false;
      p.alive = true;
      p.ghost = false;
      p.revived = false;
      p.status = "vivo";
      p.number = generateUniqueNumber(players);
      p.ghostTarget = null;
    }
    startPhase(900, "guess");
    broadcastState();
  });

  socket.on("nextPhase", () => {
    if (socket.id !== hostId) return;
    clearInterval(timer);
    phase = "guess";
    startPhase(60, "main");
    broadcastState();
  });

  socket.on("nextRound", () => nextRound());

  socket.on("guessNumber", guess => {
    const p = players[socket.id];
    if (!p || !p.alive || p.guessed || phase !== "guess") return;
    if (parseInt(guess) === p.number) {
      p.guessed = true;
    } else {
      if (p.revived) {
        // Revivido falla → eliminado
        p.alive = false;
        p.ghost = false;
        p.status = "eliminado";
      } else {
        // Primer fallo → fantasma
        p.alive = false;
        p.ghost = true;
        p.status = "fantasma";
        assignGhostTarget(socket.id);
      }
    }
    broadcastState();
  });

  socket.on("kickPlayer", id => {
    if (socket.id !== hostId) return;
    if (players[id]) {
      io.to(id).emit("kicked");
      delete players[id];
      broadcastState();
    }
  });

  // 🔥 Reinicio total de partida
  socket.on("resetGame", () => {
    if (socket.id !== hostId) return;

    // Notificar a todos que se recargue el juego
    io.emit("resetAll");

    // Reset del servidor
    players = {};
    round = 1;
    phase = "lobby";
    gameStarted = false;
    hostId = null;
    clearInterval(timer);
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    if (socket.id === hostId) hostId = Object.keys(players)[0] || null;
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🎃 Servidor iniciado en el puerto ${PORT}`));

