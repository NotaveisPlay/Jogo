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
// GERADOR DE MATEMÁTICA
// ==========================================
function sup(str) { return str.replace(/\^2/g, "²"); }

function gerarQuestao() {
  const n = Math.floor(Math.random() * 9) + 1;
  const tipo = Math.floor(Math.random() * 3);

  if (tipo === 0) return { prompt: sup(`(x + ${n})^2`), answer: `x² + ${2*n}x + ${n*n}`, hint: "Primeiro ao quadrado, mais duas vezes o primeiro pelo segundo..." };
  else if (tipo === 1) return { prompt: sup(`(x - ${n})^2`), answer: `x² - ${2*n}x + ${n*n}`, hint: "O sinal do termo do meio fica negativo." };
  else return { prompt: sup(`(x + ${n})(x - ${n})`), answer: `x² - ${n*n}`, hint: "Quadrado do primeiro menos o quadrado do segundo." };
}

function gerar10Questoes() {
  let q = []; for (let i = 0; i < 10; i++) q.push(gerarQuestao()); return q;
}

function tokenize(expr) {
  const cleaned = expr.toLowerCase().replace(/\s+/g, "").replace(/²/g, "^2").replace(/−/g, "-").replace(/\*/g, "").replace(/([a-z])(\d)/g, "$1*$2").replace(/(\d)([a-z])/g, "$1*$2").replace(/([a-z])([a-z])/g, "$1*$2");
  const out = []; let i = 0;
  while (i < cleaned.length) { const ch = cleaned[i]; if ("+-()^*".includes(ch)) { out.push(ch); i++; continue; } if (/\d/.test(ch)) { let n = ch; i++; while (i < cleaned.length && /\d/.test(cleaned[i])) n += cleaned[i++]; out.push(n); continue; } if (/[a-z]/.test(ch)) { out.push(ch); i++; continue; } i++; }
  return out;
}
function addPolys(a, b, factor = 1) { const r = { ...a }; for (const k in b) r[k] = (r[k] || 0) + factor * b[k]; Object.keys(r).forEach(k => { if (r[k] === 0) delete r[k]; }); return r; }
function multiplyPolys(a, b) { const result = {}; for (const k1 in a) { for (const k2 in b) { const c = a[k1] * b[k2]; const map = {}; (k1 + "," + k2).split(",").filter(Boolean).forEach(part => { const [v,p] = part.split("^"); map[v] = (map[v] || 0) + Number(p); }); const key = Object.entries(map).filter(([,p]) => p !== 0).sort((x,y) => x[0].localeCompare(y[0])).map(([v,p]) => v + "^" + p).join(","); result[key] = (result[key] || 0) + c; } } return result; }
function parsePolynomial(expr) { const tokens = tokenize(expr); let i = 0; function parseExpression() { let left = parseTerm(); while (i < tokens.length && (tokens[i] === "+" || tokens[i] === "-")) left = addPolys(left, parseTerm(), tokens[i++] === "+" ? 1 : -1); return left; } function parseTerm() { let left = parseFactor(); while (i < tokens.length && tokens[i] === "*") { i++; left = multiplyPolys(left, parseFactor()); } return left; } function parseFactor() { if (tokens[i] === "+") { i++; return parseFactor(); } if (tokens[i] === "-") { i++; const f = parseFactor(); return Object.fromEntries(Object.entries(f).map(([k,v]) => [k, -v])); } let base; if (tokens[i] === "(") { i++; base = parseExpression(); if (tokens[i] === ")") i++; } else if (/^\d+$/.test(tokens[i] || "")) base = { "": Number(tokens[i++]) }; else if (/^[a-z]$/.test(tokens[i] || "")) base = { [tokens[i++] + "^1"]: 1 }; else base = { "": 0 }; if (tokens[i] === "^") { i++; const exp = Number(tokens[i++] || 1); let result = { "": 1 }; for (let k = 0; k < exp; k++) result = multiplyPolys(result, base); return result; } return base; } return parseExpression(); }
function canonical(poly) { return Object.entries(poly).filter(([,v]) => v !== 0).sort((a,b) => { const degA = a[0].split(",").reduce((s,p) => s + (p ? Number(p.split("^")[1]) : 0), 0); const degB = b[0].split(",").reduce((s,p) => s + (p ? Number(p.split("^")[1]) : 0), 0); if (degB !== degA) return degB - degA; return a[0].localeCompare(b[0]); }).map(([k,v]) => v + "|" + k).join(";") || "0"; }
function answerIsCorrect(input, expected) { if (/^\d+$/.test(expected.trim())) return input.trim() === expected.trim(); try { return canonical(parsePolynomial(input)) === canonical(parsePolynomial(expected)); } catch { return false; } }

// ==========================================
// SISTEMA DE SALAS (COM RECONEXÃO FANTASMA E ANTI-DUPLO)
// ==========================================
const TEMPO_POR_QUESTAO = 150;
const salas = {};
function gerarPin() { return Math.floor(1000 + Math.random() * 9000).toString(); }

function iniciarProximaQuestao(pin) {
  const sala = salas[pin];
  if (!sala) return;

  if (sala.timer) clearInterval(sala.timer);
  sala.bloqueada = false; // Destrava a sala para permitir transição

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
      if (sala.bloqueada) return; // Se já pulou, ignora
      sala.bloqueada = true; // Bloqueia para não pular duas vezes
      clearInterval(sala.timer);
      io.to(pin).emit("fim_tempo", { correta: q.answer });
      
      setTimeout(() => { if (salas[pin]) { salas[pin].questaoAtual++; iniciarProximaQuestao(pin); } }, 6000);
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
  // A MÁGICA ACONTECE AQUI: RECONEXÃO FANTASMA
  socket.on("reentrar_sala_silencioso", (dados) => {
    const sala = salas[dados.pin];
    if (sala) {
      socket.join(dados.pin); // Puxa o celular de volta pra sala
      const jogadorExistente = Object.values(sala.jogadores).find(j => j.username === dados.username);
      if (jogadorExistente) {
        // Transfere os pontos e o estado pro "novo" sinal de internet dele
        const oldId = jogadorExistente.id;
        delete sala.jogadores[oldId];
        jogadorExistente.id = socket.id;
        sala.jogadores[socket.id] = jogadorExistente;
      }
    }
  });

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
    const chuteSeguro = String(typedAnswer || "");

    if (answerIsCorrect(chuteSeguro, questaoCerta)) {
      const multiplicador = sala.tempoRestante / TEMPO_POR_QUESTAO;
      jogador.pontos += 500 + Math.floor(500 * multiplicador);
    }

    if (Object.values(sala.jogadores).every(j => j.respondeu)) {
      if (sala.bloqueada) return; // Impede que dois acertos no mesmo milissegundo buguem a sala
      sala.bloqueada = true;
      clearInterval(sala.timer);
      io.to(sala.id).emit("fim_tempo", { correta: questaoCerta });
      
      setTimeout(() => { if (salas[sala.id]) { salas[sala.id].questaoAtual++; iniciarProximaQuestao(sala.id); } }, 6000);
    }
  });

  socket.on("disconnect", () => {
    const sala = Object.values(salas).find(s => s.jogadores[socket.id]);
    if (sala) {
      if (sala.estado === "LOBBY") {
        delete sala.jogadores[socket.id];
        io.to(sala.id).emit("atualizar_lobby", Object.values(sala.jogadores));
        if (Object.keys(sala.jogadores).length === 0) delete salas[sala.id];
      }
      // Se estiver JOGANDO, o servidor NÃO DELETA o jogador. 
      // Isso permite que a 'Reconexão Fantasma' resgate ele se o celular acordar!
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} 🚀`));
