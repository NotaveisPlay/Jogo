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
// GERADOR INFINITO DE MATEMÁTICA (LEVE E RÁPIDO)
// ==========================================
function gerarQuestao() {
  const n = Math.floor(Math.random() * 9) + 1;
  const tipo = Math.floor(Math.random() * 3);

  if (tipo === 0) return { prompt: `(x + ${n})²`, answer: `x² + ${2*n}x + ${n*n}`, hint: "Primeiro ao quadrado, mais duas vezes o primeiro pelo segundo..." };
  else if (tipo === 1) return { prompt: `(x - ${n})²`, answer: `x² - ${2*n}x + ${n*n}`, hint: "O sinal do termo do meio fica negativo." };
  else return { prompt: `(x + ${n})(x - ${n})`, answer: `x² - ${n*n}`, hint: "Quadrado do primeiro menos o quadrado do segundo." };
}

function gerar10Questoes() {
  let q = []; for (let i = 0; i < 10; i++) q.push(gerarQuestao()); return q;
}

// CORRETOR DE RESPOSTAS OTIMIZADO (Não trava mais o servidor)
function limparResposta(texto) {
  if (!texto) return "";
  return texto.toLowerCase()
    .replace(/\s+/g, "") // tira espaços
    .replace(/\^2/g, "²") // padroniza quadrado
    .replace(/x2/g, "x²") // padroniza quem digita x2
    .replace(/−/g, "-"); // padroniza o menos
}

function answerIsCorrect(input, expected) {
  return limparResposta(input) === limparResposta(expected);
}

// ==========================================
// SISTEMA DE SALAS (ESTÁVEL COMO O ANTIGO)
// ==========================================
const TEMPO_POR_QUESTAO = 150; // 2 minutos e meio
const salas = {};
function gerarPin() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function iniciarProximaQuestao(pin) {
  const sala = salas[pin];
  if (!sala) return;

  if (sala.timer) clearInterval(sala.timer);
  sala.bloqueada = false;

  if (sala.questaoAtual >= sala.questoes.length) {
    finalizarJogo(pin);
    return;
  }

  sala.estado = "JOGANDO";
  sala.tempoRestante = TEMPO_POR_QUESTAO;
  Object.values(sala.jogadores).forEach(j => j.respondeu = false);

  const q = sala.questoes[sala.questaoAtual];
  io.to(pin).emit("nova_questao", { numero: sala.questaoAtual + 1, total: 10, pergunta: "Desenvolva: " + q.prompt, dica: q.hint, tempo: TEMPO_POR_QUESTAO });

  sala.timer = setInterval(() => {
    sala.tempoRestante--;
    io.to(pin).emit("tempo_atualizado", sala.tempoRestante);

    if (sala.tempoRestante <= 0) {
      if (sala.bloqueada) return; 
      sala.bloqueada = true;
      clearInterval(sala.timer);
      io.to(pin).emit("fim_tempo", { correta: q.answer });
      
      // Jogo pula de questão em 3 segundos
      setTimeout(() => { if (salas[pin]) { salas[pin].questaoAtual++; iniciarProximaQuestao(pin); } }, 3000);
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
      sala.estado = "LOBBY"; sala.questaoAtual = 0; sala.questoes = gerar10Questoes();
      Object.values(sala.jogadores).forEach(j => { j.pronto = false; j.pontos = 0; });
      io.to(pin).emit("atualizar_lobby", Object.values(sala.jogadores));
    }
  }, 15000);
}

io.on("connection", (socket) => {
  socket.on("criar_sala", (dados) => {
    let pin = gerarPin(); while (salas[pin]) pin = gerarPin();
    salas[pin] = { id: pin, estado: "LOBBY", questaoAtual: 0, tempoRestante: 0, timer: null, bloqueada: false, jogadores: {}, questoes: gerar10Questoes() };
    socket.join(pin);
    salas[pin].jogadores[socket.id] = { id: socket.id, username: dados.username, personagem: dados.personagem, pontos: 0, pronto: false, respondeu: false };
    socket.emit("sala_entrou", pin);
    io.to(pin).emit("atualizar_lobby", Object.values(salas[pin].jogadores));
  });

  socket.on("entrar_sala", (dados) => {
    const { pin, username, personagem } = dados; const sala = salas[pin];
    if (!sala) return socket.emit("erro_sala", "Sala não encontrada! Verifique o PIN.");
    if (sala.estado !== "LOBBY") return socket.emit("erro_sala", "A partida já começou nessa sala!");
    socket.join(pin);
    sala.jogadores[socket.id] = { id: socket.id, username, personagem, pontos: 0, pronto: false, respondeu: false };
    socket.emit("sala_entrou", pin);
    io.to(pin).emit("atualizar_lobby", Object.values(sala.jogadores));
  });

  socket.on("marcar_pronto", () => {
    const sala = Object.values(salas).find(s => s.jogadores[socket.id]);
    if (!sala) return;
    sala.jogadores[socket.id].pronto = true;
    io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
    const todos = Object.values(sala.jogadores);
    if (todos.length > 0 && todos.every(j => j.pronto)) iniciarProximaQuestao(sala.id);
  });

  socket.on("enviar_resposta", (typedAnswer) => {
    const sala = Object.values(salas).find(s => s.jogadores[socket.id]);
    if (!sala || sala.estado !== "JOGANDO") return;
    const jogador = sala.jogadores[socket.id];
    if (jogador.respondeu) return;

    jogador.respondeu = true;
    const questaoCerta = sala.questoes[sala.questaoAtual].answer;

    if (answerIsCorrect(typedAnswer, questaoCerta)) {
      const multiplicador = sala.tempoRestante / TEMPO_POR_QUESTAO;
      jogador.pontos += 500 + Math.floor(500 * multiplicador);
    }

    if (Object.values(sala.jogadores).every(j => j.respondeu)) {
      if (sala.bloqueada) return; 
      sala.bloqueada = true;
      clearInterval(sala.timer);
      io.to(sala.id).emit("fim_tempo", { correta: questaoCerta });
      setTimeout(() => { if (salas[sala.id]) { salas[sala.id].questaoAtual++; iniciarProximaQuestao(sala.id); } }, 3000);
    }
  });

  socket.on("sair_sala", () => {
    const sala = Object.values(salas).find(s => s.jogadores[socket.id]);
    if (sala) {
      delete sala.jogadores[socket.id];
      socket.leave(sala.id);
      io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
      if (Object.keys(sala.jogadores).length === 0) {
        if(sala.timer) clearInterval(sala.timer);
        delete salas[sala.id];
      }
    }
  });

  socket.on("disconnect", () => {
    const sala = Object.values(salas).find(s => s.jogadores[socket.id]);
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
