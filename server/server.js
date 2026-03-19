const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      personagem TEXT,
      pontos INTEGER DEFAULT 0,
      nivel INTEGER DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Rotas HTTP
app.post("/register", (req, res) => {
  const { username, password, personagem } = req.body;
  db.run("INSERT INTO users (username, password, personagem) VALUES (?, ?, ?)", [username, password, personagem], function (err) {
    if (err) return res.json({ success: false, message: "Usuário já existe" });
    res.json({ success: true });
  });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
    if (!user) return res.json({ success: false, message: "Usuário ou senha inválidos" });
    res.json({ success: true, user });
  });
});

app.post("/updateScore", (req, res) => {
  const { username, pontos } = req.body;
  db.run("UPDATE users SET pontos = pontos + ? WHERE username = ?", [pontos, username], function (err) {
    res.json({ success: !err });
  });
});

// ==========================================
// SISTEMA DE SALAS MULTIPLAYER
// ==========================================
const questoes = [
  { pergunta: "Resolva a expressão: (5 + 2)²", opcoes: ["29", "49", "27", "14", "20"], correta: 1 },
  { pergunta: "Resolva a expressão: (12 - 3)²", opcoes: ["135", "18", "153", "81", "3"], correta: 3 },
  { pergunta: "Se x + 1/x = 5, então qual o valor de x² + 1/x² ?", opcoes: ["25", "27", "10", "23", "5"], correta: 3 },
  { pergunta: "A distância que o bip do sonar percorreu foi de (30-5)², representando a distância total (ida e volta). Determine a profundidade do oceano.", opcoes: ["625m", "600m", "300m", "312,5m", "325m"], correta: 3 },
  { pergunta: "O quadrado da soma do chute é: (8+2)². Vini Jr. diz que é 8² + 2². Qual o valor correto da expressão?", opcoes: ["68", "84", "100", "64", "72"], correta: 2 }
];

const TEMPO_POR_QUESTAO = 150; // 2 min e meio
const salas = {}; // Objeto que vai guardar todas as salas criadas

function gerarPin() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // Gera um PIN de 4 dígitos
}

function iniciarProximaQuestao(pin) {
  const sala = salas[pin];
  if (!sala) return;

  if (sala.questaoAtual >= questoes.length) {
    finalizarJogo(pin);
    return;
  }

  sala.estado = "JOGANDO";
  sala.tempoRestante = TEMPO_POR_QUESTAO;
  Object.values(sala.jogadores).forEach(j => j.respondeu = false);

  const q = questoes[sala.questaoAtual];
  io.to(pin).emit("nova_questao", { numero: sala.questaoAtual + 1, pergunta: q.pergunta, opcoes: q.opcoes, tempo: TEMPO_POR_QUESTAO });

  sala.timer = setInterval(() => {
    sala.tempoRestante--;
    io.to(pin).emit("tempo_atualizado", sala.tempoRestante);

    if (sala.tempoRestante <= 0) {
      clearInterval(sala.timer);
      io.to(pin).emit("fim_tempo", { correta: q.correta });
      setTimeout(() => {
        if (salas[pin]) {
          salas[pin].questaoAtual++;
          iniciarProximaQuestao(pin);
        }
      }, 5000);
    }
  }, 1000);
}

function finalizarJogo(pin) {
  const sala = salas[pin];
  if (!sala) return;

  sala.estado = "PODIO";
  const ranking = Object.values(sala.jogadores).sort((a, b) => b.pontos - a.pontos);
  io.to(pin).emit("mostrar_podio", ranking);
  
  setTimeout(() => {
    if (salas[pin]) {
      sala.estado = "LOBBY";
      sala.questaoAtual = 0;
      Object.values(sala.jogadores).forEach(j => { j.pronto = false; j.pontos = 0; });
      io.to(pin).emit("atualizar_lobby", Object.values(sala.jogadores));
    }
  }, 15000);
}

function getSalaDoJogador(socketId) {
  for (let pin in salas) {
    if (salas[pin].jogadores[socketId]) return salas[pin];
  }
  return null;
}

io.on("connection", (socket) => {
  
  // CRIAR UMA NOVA SALA
  socket.on("criar_sala", (dados) => {
    let pin = gerarPin();
    while (salas[pin]) pin = gerarPin(); // Garante que o PIN não repita
    
    salas[pin] = { id: pin, estado: "LOBBY", questaoAtual: 0, tempoRestante: 0, timer: null, jogadores: {} };
    socket.join(pin);
    salas[pin].jogadores[socket.id] = { id: socket.id, username: dados.username, personagem: dados.personagem, pontos: 0, pronto: false, respondeu: false };
    
    socket.emit("sala_entrou", pin);
    io.to(pin).emit("atualizar_lobby", Object.values(salas[pin].jogadores));
  });

  // ENTRAR NUMA SALA EXISTENTE
  socket.on("entrar_sala", (dados) => {
    const { pin, username, personagem } = dados;
    const sala = salas[pin];

    if (!sala) return socket.emit("erro_sala", "Sala não encontrada! Verifique o PIN.");
    if (sala.estado !== "LOBBY") return socket.emit("erro_sala", "A partida já começou nessa sala!");

    socket.join(pin);
    sala.jogadores[socket.id] = { id: socket.id, username, personagem, pontos: 0, pronto: false, respondeu: false };
    
    socket.emit("sala_entrou", pin);
    io.to(pin).emit("atualizar_lobby", Object.values(sala.jogadores));
  });

  socket.on("marcar_pronto", () => {
    const sala = getSalaDoJogador(socket.id);
    if (!sala) return;

    sala.jogadores[socket.id].pronto = true;
    io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));

    const todosJogadores = Object.values(sala.jogadores);
    if (todosJogadores.length > 0 && todosJogadores.every(j => j.pronto)) {
      iniciarProximaQuestao(sala.id);
    }
  });

  socket.on("enviar_resposta", (indiceEscolhido) => {
    const sala = getSalaDoJogador(socket.id);
    if (!sala || sala.estado !== "JOGANDO") return;

    const jogador = sala.jogadores[socket.id];
    if (jogador.respondeu) return;

    jogador.respondeu = true;
    const questaoCerta = questoes[sala.questaoAtual].correta;

    if (indiceEscolhido === questaoCerta) {
      const multiplicador = sala.tempoRestante / TEMPO_POR_QUESTAO;
      jogador.pontos += Math.floor(1000 * multiplicador);
    }

    const todosResponderam = Object.values(sala.jogadores).every(j => j.respondeu);
    if (todosResponderam) {
      clearInterval(sala.timer);
      io.to(sala.id).emit("fim_tempo", { correta: questaoCerta });
      setTimeout(() => {
        sala.questaoAtual++;
        iniciarProximaQuestao(sala.id);
      }, 5000);
    }
  });

  socket.on("sair_sala", () => {
    const sala = getSalaDoJogador(socket.id);
    if (sala) {
      delete sala.jogadores[socket.id];
      socket.leave(sala.id);
      io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
      // Se a sala esvaziar, apaga ela pra economizar memória do servidor
      if (Object.keys(sala.jogadores).length === 0) delete salas[sala.id];
    }
  });

  socket.on("disconnect", () => {
    const sala = getSalaDoJogador(socket.id);
    if (sala) {
      delete sala.jogadores[socket.id];
      io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
      if (Object.keys(sala.jogadores).length === 0) {
        if(sala.timer) clearInterval(sala.timer);
        delete salas[sala.id];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} 🚀`));
