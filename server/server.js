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
// GERADOR DE MATEMÁTICA RÁPIDO (A, B, C, D, E)
// ==========================================
function gerarQuestao() {
  const n = Math.floor(Math.random() * 9) + 1; // 1 a 9
  const tipo = Math.floor(Math.random() * 3); // 0, 1 ou 2
  let pergunta, certa, erradas;

  if (tipo === 0) {
    pergunta = `(x + ${n})²`;
    certa = `x² + ${2 * n}x + ${n * n}`;
    erradas = [`x² + ${n * n}`, `x² - ${2 * n}x + ${n * n}`, `x² + ${n}x + ${n * n}`, `x² + ${2 * n}x - ${n * n}`];
  } else if (tipo === 1) {
    pergunta = `(x - ${n})²`;
    certa = `x² - ${2 * n}x + ${n * n}`;
    erradas = [`x² - ${n * n}`, `x² + ${2 * n}x + ${n * n}`, `x² - ${n}x + ${n * n}`, `x² - ${2 * n}x - ${n * n}`];
  } else {
    pergunta = `(x + ${n})(x - ${n})`;
    certa = `x² - ${n * n}`;
    erradas = [`x² + ${n * n}`, `x² - ${2 * n}x - ${n * n}`, `x² - ${n}`, `x² + ${2 * n}x + ${n * n}`];
  }

  let opcoes = [certa, ...erradas];
  opcoes.sort(() => Math.random() - 0.5); // Embaralha as alternativas
  let correta = opcoes.indexOf(certa);

  return { pergunta: "Desenvolva: " + pergunta, opcoes, correta };
}

function gerar10Questoes() {
  let q = [];
  for (let i = 0; i < 10; i++) q.push(gerarQuestao());
  return q;
}

// ==========================================
// SISTEMA DE SALAS (LISO, RÁPIDO E BLINDADO)
// ==========================================
const TEMPO_POR_QUESTAO = 150;
const salas = {};

function gerarPin() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function iniciarProximaQuestao(pin) {
  const sala = salas[pin];
  if (!sala) return;

  if (sala.timer) clearInterval(sala.timer);
  sala.bloqueada = false; // TRAVA DE SEGURANÇA LIBERADA

  if (sala.questaoAtual >= sala.questoes.length) {
    finalizarJogo(pin);
    return;
  }

  sala.estado = "JOGANDO";
  sala.tempoRestante = TEMPO_POR_QUESTAO;
  Object.values(sala.jogadores).forEach(j => j.respondeu = false);

  const q = sala.questoes[sala.questaoAtual];
  
  io.to(pin).emit("nova_questao", { 
    numero: sala.questaoAtual + 1, 
    total: sala.questoes.length, 
    pergunta: q.pergunta, 
    opcoes: q.opcoes, 
    tempo: TEMPO_POR_QUESTAO 
  });

  sala.timer = setInterval(() => {
    sala.tempoRestante--;
    io.to(pin).emit("tempo_atualizado", sala.tempoRestante);

    if (sala.tempoRestante <= 0) {
      if (sala.bloqueada) return; // SE JÁ PULOU, IGNORA PRA NÃO TRAVAR!
      sala.bloqueada = true;
      
      clearInterval(sala.timer);
      io.to(pin).emit("fim_tempo", { correta: q.correta });
      setTimeout(() => {
        if (salas[pin]) {
          salas[pin].questaoAtual++;
          iniciarProximaQuestao(pin);
        }
      }, 4000); // Passa a questão após 4 segundos
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
      sala.questoes = gerar10Questoes(); 
      Object.values(sala.jogadores).forEach(j => { j.pronto = false; j.pontos = 0; });
      io.to(pin).emit("atualizar_lobby", Object.values(sala.jogadores));
    }
  }, 10000);
}

io.on("connection", (socket) => {
  
  // A MÁGICA QUE SALVA O CELULAR QUE DORMIU!
  socket.on("reentrar_sala_silencioso", (dados) => {
    const sala = salas[dados.pin];
    if (sala) {
      socket.join(dados.pin); // Puxa de volta pra sala
      const jogadorExistente = Object.values(sala.jogadores).find(j => j.username === dados.username);
      if (jogadorExistente) {
        const oldId = jogadorExistente.id;
        delete sala.jogadores[oldId];
        jogadorExistente.id = socket.id;
        sala.jogadores[socket.id] = jogadorExistente;
        
        // Manda a tela do jogo pra ele não ficar travado
        if (sala.estado === "JOGANDO") {
           const q = sala.questoes[sala.questaoAtual];
           socket.emit("nova_questao", { 
             numero: sala.questaoAtual + 1, total: sala.questoes.length, 
             pergunta: q.pergunta, opcoes: q.opcoes, tempo: sala.tempoRestante 
           });
        }
      }
    }
  });

  socket.on("criar_sala", (dados) => {
    let pin = gerarPin();
    while (salas[pin]) pin = gerarPin();
    
    salas[pin] = { id: pin, estado: "LOBBY", questaoAtual: 0, tempoRestante: 0, timer: null, bloqueada: false, jogadores: {}, questoes: gerar10Questoes() };
    socket.join(pin);
    salas[pin].jogadores[socket.id] = { id: socket.id, username: dados.username, personagem: dados.personagem, pontos: 0, pronto: false, respondeu: false };
    
    socket.emit("sala_entrou", pin);
    io.to(pin).emit("atualizar_lobby", Object.values(salas[pin].jogadores));
  });

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
    let salaEncontrada = null;
    for (let pin in salas) { if (salas[pin].jogadores[socket.id]) { salaEncontrada = salas[pin]; break; } }
    if (!salaEncontrada) return;

    salaEncontrada.jogadores[socket.id].pronto = true;
    io.to(salaEncontrada.id).emit("atualizar_lobby", Object.values(salaEncontrada.jogadores));

    const todosJogadores = Object.values(salaEncontrada.jogadores);
    if (todosJogadores.length > 0 && todosJogadores.every(j => j.pronto)) {
      iniciarProximaQuestao(salaEncontrada.id);
    }
  });

  socket.on("enviar_resposta", (indiceEscolhido) => {
    let sala = null;
    for (let pin in salas) { if (salas[pin].jogadores[socket.id]) { sala = salas[pin]; break; } }
    if (!sala || sala.estado !== "JOGANDO") return;

    const jogador = sala.jogadores[socket.id];
    if (jogador.respondeu) return;

    jogador.respondeu = true;
    const questaoCerta = sala.questoes[sala.questaoAtual].correta;

    if (indiceEscolhido === questaoCerta) {
      const multiplicador = sala.tempoRestante / TEMPO_POR_QUESTAO;
      jogador.pontos += 500 + Math.floor(500 * multiplicador);
    }

    const todosResponderam = Object.values(sala.jogadores).every(j => j.respondeu);
    if (todosResponderam) {
      if (sala.bloqueada) return; // TRAVA DE SEGURANÇA: Impede que passe de questão duas vezes!
      sala.bloqueada = true;
      
      clearInterval(sala.timer);
      io.to(sala.id).emit("fim_tempo", { correta: questaoCerta });
      setTimeout(() => {
        if (salas[sala.id]) {
          salas[sala.id].questaoAtual++;
          iniciarProximaQuestao(sala.id);
        }
      }, 4000);
    }
  });

  socket.on("sair_sala", () => {
    let sala = null;
    for (let pin in salas) { if (salas[pin].jogadores[socket.id]) { sala = salas[pin]; break; } }
    if (sala) {
      delete sala.jogadores[socket.id];
      socket.leave(sala.id);
      io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
      if (Object.keys(sala.jogadores).length === 0) delete salas[sala.id];
    }
  });

  socket.on("disconnect", () => {
    let sala = null;
    for (let pin in salas) { if (salas[pin].jogadores[socket.id]) { sala = salas[pin]; break; } }
    if (sala) {
      // Se a partida começou, o servidor NÃO DELETA o cara. Assim o celular pode reconectar invisivelmente!
      if (sala.estado === "LOBBY") {
        delete sala.jogadores[socket.id];
        io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
        if (Object.keys(sala.jogadores).length === 0) {
          if(sala.timer) clearInterval(sala.timer);
          delete salas[sala.id];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Blindado rodando na porta ${PORT} 🚀`));
