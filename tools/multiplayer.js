/**
 * Transporte WebSocket do multiplayer.
 *
 * Fica sobre tools/salas.js: aqui só há socket, validação e retransmissão; as
 * regras de sala e senha vivem lá. O mesmo módulo serve o `vite dev` (via
 * plugin) e a produção (via server.js), para não haver dois caminhos que
 * possam divergir em comportamento -- ou em segurança.
 *
 * Modelo de confiança: os clientes mandam a própria posição e o servidor
 * retransmite. Isso é o que cabe num jogo desta escala, mas é honesto dizer o
 * que significa -- não é à prova de trapaça. O servidor valida formato,
 * limites do mundo e velocidade máxima, o que barra teleporte e voo bobos;
 * quem quiser trapacear de verdade ainda consegue andar rápido dentro do
 * limite. Para valer, a física teria que rodar no servidor.
 */
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

import { RegistroDeSalas, ErroDeSala, LIMITES } from "./salas.js";

const HZ = 15;                       // frequência de retransmissão de estado
const PING_MS = 30_000;
// 15 Hz de estado + chat + rajadas de sinalização WebRTC. Cada par troca
// dezenas de candidatos ICE em poucos segundos ao conectar, e numa sala de 6
// isso acontece com todos ao mesmo tempo; com o limite antigo de 45 a conexão
// era cortada por "flood" justamente na hora de entrar.
const MSG_POR_SEGUNDO = 200;
const HISTORICO_CHAT = 50;           // mensagens guardadas por sala
const FALA_INTERVALO_MS = 700;
const FALA_MAX = 200;
const TENTATIVAS_POR_MINUTO = 12;    // por IP, contra força bruta de senha

// Limites do mundo. O cenário tem ~64 x 38 m; a folga é generosa para não
// brigar com quem cair fora da geometria, mas fecha o valor absurdo.
const MUNDO = { xz: 400, yMin: -60, yMax: 200 };
const VELOCIDADE_MAX = 14;           // m/s; correr são 4.6, pular sobe ~8

const ANIMACOES = new Set(["Parado", "Andar", "Pular"]);

const PERSONAGENS_VALIDOS = new Set([
  "Business_Male_01",
  "Business_Female_01",
  "Developer_Male_01",
  "Developer_Female_01",
  "Boss_Male_01",
  "Security_Female_01",
]);

const CORES_VALIDAS = new Set([
  "#6ea8fe", "#7ee0a8", "#ffd166", "#ff8fa3", "#c89bff", "#5fe0d8",
]);

function numero(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function limpar(texto, max) {
  // Remove controles: eles não aparecem, mas quebram layout e logs.
  return String(texto ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validarPerfil(bruto) {
  const nome = limpar(bruto?.nome, LIMITES.nome) || "Anônimo";
  const personagem = PERSONAGENS_VALIDOS.has(bruto?.personagem)
    ? bruto.personagem
    : "Business_Male_01";
  const cor = CORES_VALIDAS.has(bruto?.cor) ? bruto.cor : "#6ea8fe";
  return { nome, personagem, cor };
}

/** Janela deslizante simples, suficiente para o que precisamos barrar. */
class Limitador {
  constructor(max, janelaMs) {
    this.max = max;
    this.janela = janelaMs;
    this.eventos = [];
  }
  permitir(agora = Date.now()) {
    const corte = agora - this.janela;
    while (this.eventos.length && this.eventos[0] < corte) this.eventos.shift();
    if (this.eventos.length >= this.max) return false;
    this.eventos.push(agora);
    return true;
  }
}

export function criarServidorMultiplayer(servidorHttp, { caminho = "/ws" } = {}) {
  const registro = new RegistroDeSalas();

  // noServer + upgrade manual, em vez de passar `server`: com a opcao `server`
  // o ws registra o proprio listener de upgrade e aborta o handshake de
  // qualquer caminho que nao seja o dele -- o que derrubaria o WebSocket de
  // HMR do Vite, que divide a mesma porta. Aqui, caminho diferente do nosso
  // simplesmente nao e tocado e segue para os outros listeners.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  const aoUpgrade = (req, socket, head) => {
    let rota;
    try {
      rota = new URL(req.url, "http://interno").pathname;
    } catch {
      return;
    }
    if (rota !== caminho) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };
  servidorHttp.on("upgrade", aoUpgrade);

  const porIp = new Map();

  function limitadorDeIp(ip) {
    let l = porIp.get(ip);
    if (!l) {
      l = new Limitador(TENTATIVAS_POR_MINUTO, 60_000);
      porIp.set(ip, l);
    }
    return l;
  }

  function enviar(ws, objeto) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(objeto));
  }

  function transmitir(sala, objeto, exceto = null) {
    const texto = JSON.stringify(objeto);
    for (const jogador of sala.jogadores.values()) {
      if (jogador.id === exceto) continue;
      if (jogador.ws.readyState === jogador.ws.OPEN) jogador.ws.send(texto);
    }
  }

  function publico(jogador) {
    return {
      id: jogador.id,
      nome: jogador.perfil.nome,
      personagem: jogador.perfil.personagem,
      cor: jogador.perfil.cor,
      midia: jogador.midia,
    };
  }

  function paraUm(sala, id, objeto) {
    const destino = sala.jogadores.get(id);
    if (destino && destino.ws.readyState === destino.ws.OPEN) {
      destino.ws.send(JSON.stringify(objeto));
    }
  }

  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "?";
    const estado = {
      id: randomUUID(),
      sala: null,
      perfil: null,
      pos: [0, 0, 0],
      yaw: 0,
      anim: "Parado",
      ultimoEstadoEm: 0,
      ultimaFalaEm: 0,
      midia: { camera: false, microfone: false, tela: false },
      ws,
    };

    const taxa = new Limitador(MSG_POR_SEGUNDO, 1000);
    ws.vivo = true;
    ws.on("pong", () => {
      ws.vivo = true;
    });

    ws.on("message", async (bruto) => {
      if (!taxa.permitir()) {
        enviar(ws, { tipo: "erro", mensagem: "muitas mensagens" });
        return ws.close(1008, "flood");
      }

      let msg;
      try {
        msg = JSON.parse(bruto.toString());
      } catch {
        return enviar(ws, { tipo: "erro", mensagem: "JSON inválido" });
      }

      // ---- entrada na sala (só antes de estar em uma)
      if (msg.tipo === "criar" || msg.tipo === "entrar") {
        if (estado.sala) {
          return enviar(ws, { tipo: "erro", mensagem: "já está numa sala" });
        }
        if (!limitadorDeIp(ip).permitir()) {
          return enviar(ws, {
            tipo: "erro",
            mensagem: "muitas tentativas, espere um minuto",
          });
        }

        try {
          const sala =
            msg.tipo === "criar"
              ? await registro.criar({ nome: msg.nome, senha: msg.senha })
              : await registro.entrar({ codigo: msg.codigo, senha: msg.senha });

          estado.perfil = validarPerfil(msg.perfil);
          estado.sala = sala;
          registro.adicionar(sala, estado);

          enviar(ws, {
            tipo: "bemvindo",
            id: estado.id,
            codigo: sala.codigo,
            nomeSala: sala.nome,
            protegida: sala.protegida,
            eu: publico(estado),
            jogadores: [...sala.jogadores.values()]
              .filter((j) => j.id !== estado.id)
              .map(publico),
            // Quem chega vê o que já foi dito. Sem isto, entrar numa conversa
            // em andamento é entrar numa sala muda.
            historico: sala.historico ?? [],
          });
          transmitir(sala, { tipo: "entrou", jogador: publico(estado) }, estado.id);
        } catch (erro) {
          if (erro instanceof ErroDeSala) {
            return enviar(ws, { tipo: "erro", mensagem: erro.message });
          }
          console.error("[mp] falha ao entrar:", erro);
          return enviar(ws, { tipo: "erro", mensagem: "erro interno" });
        }
        return;
      }

      if (!estado.sala) {
        return enviar(ws, { tipo: "erro", mensagem: "entre numa sala antes" });
      }

      // ---- posição
      if (msg.tipo === "estado") {
        const p = msg.p;
        if (!Array.isArray(p) || p.length !== 3 || !p.every(numero)) return;
        if (Math.abs(p[0]) > MUNDO.xz || Math.abs(p[2]) > MUNDO.xz) return;
        if (p[1] < MUNDO.yMin || p[1] > MUNDO.yMax) return;
        if (!numero(msg.y)) return;

        const agora = Date.now();
        const dt = (agora - estado.ultimoEstadoEm) / 1000;
        if (estado.ultimoEstadoEm && dt > 0) {
          const d = Math.hypot(
            p[0] - estado.pos[0],
            p[1] - estado.pos[1],
            p[2] - estado.pos[2],
          );
          // Rejeitar em vez de corrigir: o cliente legítimo nunca estoura isso,
          // e devolver uma posição "arrumada" só faria o avatar teleportar.
          if (d / dt > VELOCIDADE_MAX && dt < 1) return;
        }

        estado.pos = [p[0], p[1], p[2]];
        estado.yaw = msg.y;
        estado.anim = ANIMACOES.has(msg.a) ? msg.a : "Parado";
        estado.ultimoEstadoEm = agora;
        return;
      }

      // ---- chat entre jogadores
      if (msg.tipo === "fala") {
        const agora = Date.now();
        if (agora - estado.ultimaFalaEm < FALA_INTERVALO_MS) return;
        const texto = limpar(msg.texto, FALA_MAX);
        if (!texto) return;
        estado.ultimaFalaEm = agora;

        const fala = {
          tipo: "fala",
          id: estado.id,
          nome: estado.perfil.nome,
          cor: estado.perfil.cor,
          texto,
          em: agora,
        };

        const sala = estado.sala;
        sala.historico = sala.historico ?? [];
        sala.historico.push(fala);
        if (sala.historico.length > HISTORICO_CHAT) sala.historico.shift();

        transmitir(sala, fala);
        return;
      }

      // ---- estado de câmera/microfone/tela
      if (msg.tipo === "midia") {
        estado.midia = {
          camera: msg.camera === true,
          microfone: msg.microfone === true,
          tela: msg.tela === true,
        };
        transmitir(
          estado.sala,
          { tipo: "midia", id: estado.id, midia: estado.midia },
          estado.id,
        );
        return;
      }

      // ---- sinalização WebRTC
      //
      // O servidor é só um carteiro aqui: repassa a oferta/resposta/candidato
      // para UM destinatário da MESMA sala, sem ler o conteúdo. O áudio e o
      // vídeo em si nunca passam por ele -- vão direto entre os navegadores.
      if (msg.tipo === "sinal") {
        if (typeof msg.para !== "string" || !msg.dados) return;
        // Restringir à sala é o que impede alguém de usar o servidor para
        // sinalizar com um estranho de outra sala.
        if (!estado.sala.jogadores.has(msg.para)) return;

        paraUm(estado.sala, msg.para, {
          tipo: "sinal",
          de: estado.id,
          dados: msg.dados,
        });
        return;
      }
    });

    ws.on("close", () => {
      if (!estado.sala) return;
      const sala = estado.sala;
      registro.remover(sala, estado.id);
      transmitir(sala, { tipo: "saiu", id: estado.id });
      estado.sala = null;
    });

    ws.on("error", (erro) => console.error("[mp] socket:", erro.message));
  });

  // Retransmite todas as posições de cada sala num pacote só: 12 jogadores
  // viram 1 mensagem por tick em vez de 12.
  const tick = setInterval(() => {
    for (const sala of registro.salas.values()) {
      if (sala.jogadores.size < 2) continue;
      const lista = [...sala.jogadores.values()].map((j) => ({
        id: j.id,
        p: j.pos,
        y: j.yaw,
        a: j.anim,
      }));
      transmitir(sala, { tipo: "estados", lista });
    }
  }, 1000 / HZ);

  // Sockets mortos não disparam 'close' sozinhos (cabo arrancado, sono do
  // aparelho). Sem o ping, jogadores fantasmas ficariam na sala para sempre.
  const batida = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.vivo) {
        ws.terminate();
        continue;
      }
      ws.vivo = false;
      ws.ping();
    }
    if (porIp.size > 5000) porIp.clear();
  }, PING_MS);

  function encerrar() {
    clearInterval(tick);
    clearInterval(batida);
    servidorHttp.off("upgrade", aoUpgrade);
    registro.encerrar();
    wss.close();
  }

  return { wss, registro, encerrar };
}

/** Plugin que sobe o WebSocket junto do servidor de desenvolvimento do Vite. */
export function pluginMultiplayer() {
  return {
    name: "multiplayer",
    configureServer(servidor) {
      if (!servidor.httpServer) return;
      const mp = criarServidorMultiplayer(servidor.httpServer);
      servidor.httpServer.on("close", () => mp.encerrar());
    },
  };
}
