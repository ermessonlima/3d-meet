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
// Teto de mensagem. O comum vale para todo o protocolo; o da textura é a
// exceção da pintura à mão, que viaja como PNG em base64.
const LIMITE_COMUM = 16 * 1024;
const LIMITE_TEXTURA = 96 * 1024;
const TEXTURA_INTERVALO_MS = 400;

// Ciclo da partida. No preparo as lagartixas se escondem e se pintam sem
// ninguém à espreita; depois começa a caçada.
const PREPARO_MS = 60_000;
const CACA_MS = 300_000;
const INTERVALO_MS = 12_000;

// Assobio: a lagartixa se entrega de tempos em tempos. É o contrapeso da
// camuflagem -- sem nenhuma pista, procurar um bicho de 10 cm pintado da cor
// do carpete num escritório inteiro é procurar agulha no palheiro.
const ASSOBIO_MIN_MS = 7_000;
const ASSOBIO_MAX_MS = 13_000;
const ASSOBIO_ALCANCE = 14;   // metros; além disso o caçador não recebe nada

// Limites do mundo. O cenário tem ~64 x 38 m; a folga é generosa para não
// brigar com quem cair fora da geometria, mas fecha o valor absurdo.
const MUNDO = { xz: 400, yMin: -60, yMax: 200 };
const VELOCIDADE_MAX = 14;           // m/s; correr são 4.6, pular sobe ~8

const ANIMACOES = new Set([
  "Parado", "Andar", "Pular", "Sentar", "Esconder",
  // Poses de silhueta da lagartixa. Viajam pelo mesmo campo das animações --
  // para os outros jogadores, uma pose é só o clipe que o bicho está tocando.
  "EmPe", "Deitada", "Encolhida",
]);

const PAPEIS = new Set(["pessoa", "lagartixa"]);
const VIDA_MAXIMA = 3;
const TIRO_INTERVALO_MS = 220;   // cadência do lado do servidor

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
  const papel = PAPEIS.has(bruto?.papel) ? bruto.papel : "pessoa";
  return { nome, personagem, cor, papel };
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
  // O teto grande existe só para a pintura à mão, que viaja como PNG. Todo o
  // resto do protocolo continua preso em 16 KB pela checagem logo abaixo, para
  // que abrir espaço à textura não afrouxe o resto.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITE_TEXTURA });

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
      papel: jogador.perfil.papel,
      pintura: jogador.pintura,
      // Quem entra no meio precisa ver as lagartixas como elas já estão.
      textura: jogador.textura ?? null,
      vida: jogador.vida,
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
      escondido: false,
      pintura: "#5f9e4a",
      textura: null,
      ultimaTexturaEm: 0,
      proximoAssobio: 0,
      vida: VIDA_MAXIMA,
      ultimoTiroEm: 0,
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

      const texto = bruto.toString();
      // Só a pintura tem licença para ser grande.
      if (texto.length > LIMITE_COMUM && !texto.startsWith('{"tipo":"textura"')) {
        return enviar(ws, { tipo: "erro", mensagem: "mensagem grande demais" });
      }

      let msg;
      try {
        msg = JSON.parse(texto);
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
          // Primeiro a chegar vira anfitrião; numa sala recém-criada é sempre
          // quem a criou.
          if (!sala.anfitriao) sala.anfitriao = estado.id;

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
            // Quem chega no meio precisa saber em que pé está a rodada; sem
            // isto o cronômetro só apareceria na virada de fase seguinte.
            fase: sala.fase,
            restaMs: Math.max(0, sala.faseAte - Date.now()),
            anfitriao: sala.anfitriao,
            podeIniciar: podeIniciar(sala),
          });
          transmitir(sala, { tipo: "entrou", jogador: publico(estado) }, estado.id);
          // Depois do "entrou": o papel de quem chegou pode ser justamente o
          // que faltava para o botão acender.
          anunciarSala(sala);
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
        estado.escondido = msg.e === true;
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

      // ---- começar a rodada
      //
      // Validado aqui, e não só escondendo o botão no navegador: quem quisesse
      // poderia mandar a mensagem à mão pelo console.
      if (msg.tipo === "iniciar") {
        if (!estado.sala) return;
        const sala = estado.sala;
        if (sala.anfitriao !== estado.id) {
          return enviar(ws, { tipo: "erro", mensagem: "só quem abriu a sala começa a rodada" });
        }
        if (sala.fase !== "espera") return;
        if (!podeIniciar(sala)) {
          return enviar(ws, {
            tipo: "erro",
            mensagem: "precisa de pelo menos uma lagartixa e um caçador",
          });
        }
        trocarFase(sala, "preparo", Date.now());
        return;
      }

      // ---- pintura da lagartixa
      if (msg.tipo === "pintar") {
        if (typeof msg.cor !== "string" || !/^#[0-9a-f]{6}$/i.test(msg.cor)) {
          return;
        }
        estado.pintura = msg.cor;
        // Cor chapada apaga a pintura à mão: é o "cobrir tudo".
        estado.textura = null;
        transmitir(estado.sala, { tipo: "pintar", id: estado.id, cor: msg.cor });
        return;
      }

      // ---- atlas pintado à mão
      if (msg.tipo === "textura") {
        if (!estado.sala || estado.perfil?.papel !== "lagartixa") return;
        const dados = msg.dados;
        if (
          typeof dados !== "string" ||
          dados.length > LIMITE_TEXTURA ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dados)
        ) {
          return;
        }
        // Uma pincelada por vez já é generoso: o cliente só envia ao soltar o
        // botão, e sem freio um cliente adulterado inundaria a sala com PNGs.
        const agoraT = Date.now();
        if (agoraT - (estado.ultimaTexturaEm ?? 0) < TEXTURA_INTERVALO_MS) return;
        estado.ultimaTexturaEm = agoraT;

        estado.textura = dados;
        transmitir(
          estado.sala,
          { tipo: "textura", id: estado.id, dados },
          estado.id,
        );
        return;
      }

      // ---- tiro
      //
      // Quem decide o acerto é o atirador; o servidor confere apenas o que dá
      // para conferir sem simular o mundo: cadência, alvo existente, alvo vivo
      // e alvo diferente de si mesmo. É honesto dizer que isto NÃO impede
      // trapaça -- um cliente adulterado pode declarar acertos que não houve.
      // Autoridade real exigiria a física rodando aqui.
      if (msg.tipo === "tiro") {
        const agoraT = Date.now();
        if (agoraT - estado.ultimoTiroEm < TIRO_INTERVALO_MS) return;
        estado.ultimoTiroEm = agoraT;

        // O rastro é retransmitido SEMPRE, acerte ou não: quem erra também faz
        // barulho, e ver de onde vieram os tiros é metade da informação numa
        // caçada. Sem isto, um tiro que passa raspando é invisível.
        const seg = (v) =>
          Array.isArray(v) && v.length === 3 && v.every(numero)
          && Math.abs(v[0]) <= MUNDO.xz && Math.abs(v[2]) <= MUNDO.xz;
        if (seg(msg.o) && seg(msg.f)) {
          transmitir(
            estado.sala,
            { tipo: "disparo", de: estado.id, o: msg.o, f: msg.f },
            estado.id,
          );
        }

        if (typeof msg.alvo !== "string" || msg.alvo === estado.id) return;
        const alvo = estado.sala.jogadores.get(msg.alvo);
        if (!alvo || alvo.vida <= 0) return;
        // Lagartixa não leva tiro fora da caçada. O caçador nem recebe a
        // posição dela no preparo, então um acerto declarado nessa janela ou é
        // sorte cega ou é cliente adulterado -- em nenhum dos dois casos vale.
        if (alvo.perfil?.papel === "lagartixa" && estado.sala.fase !== "caca") {
          return;
        }

        alvo.vida = Math.max(0, alvo.vida - 1);
        transmitir(estado.sala, {
          tipo: "dano",
          de: estado.id,
          alvo: alvo.id,
          vida: alvo.vida,
        });

        if (alvo.vida === 0) {
          // Revive sozinho depois de um tempo; sem isso o jogo trava no
          // primeiro abate e alguém precisa recarregar a página.
          const sala = estado.sala;
          setTimeout(() => {
            if (!sala.jogadores.has(alvo.id)) return;
            alvo.vida = VIDA_MAXIMA;
            transmitir(sala, { tipo: "reviver", alvo: alvo.id, vida: alvo.vida });
          }, 4000);
        }
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
      // O anfitrião foi embora: passa para quem está há mais tempo na sala.
      // `Map` preserva a ordem de inserção, então o primeiro é o mais antigo.
      // Sem isto a sala ficaria sem ninguém que pudesse dar a partida.
      if (sala.anfitriao === estado.id) {
        sala.anfitriao = sala.jogadores.keys().next().value ?? null;
      }
      transmitir(sala, { tipo: "saiu", id: estado.id });
      if (sala.jogadores.size > 0) anunciarSala(sala);
      estado.sala = null;
    });

    ws.on("error", (erro) => console.error("[mp] socket:", erro.message));
  });

  // Retransmite todas as posições de cada sala num pacote só: 12 jogadores
  // viram 1 mensagem por tick em vez de 12.
  /**
   * Avança o ciclo da sala e avisa quem estiver nela.
   *
   * A rodada só corre com gente das duas partes: uma caçada sem caçador (ou
   * sem lagartixa) é um cronômetro andando à toa.
   */
  function girarFase(sala, agora) {
    if (!podeIniciar(sala)) {
      // Perdeu um dos lados no meio da rodada: aborta e volta para a espera.
      // Continuar uma caçada sem caçador seria só um cronômetro andando à toa.
      if (sala.fase !== "espera") trocarFase(sala, "espera", agora);
      return;
    }

    // Parada é parada: quem tira do "espera" é o botão de iniciar, não o
    // relógio. Antes a rodada disparava no milissegundo em que o segundo papel
    // conectava, e quem entrasse cinco segundos depois já perdia cinco
    // segundos de preparo sem ter feito nada.
    if (sala.fase === "espera") return;
    if (agora < sala.faseAte) return;

    if (sala.fase === "preparo") return trocarFase(sala, "caca", agora);
    if (sala.fase === "caca") return trocarFase(sala, "intervalo", agora);
    // Fim do intervalo volta para a sala de espera, e não direto para outra
    // rodada: entre uma e outra as pessoas trocam de papel, entram e saem.
    return trocarFase(sala, "espera", agora);
  }

  function trocarFase(sala, fase, agora) {
    const duracao =
      fase === "espera" ? 0
      : fase === "preparo" ? PREPARO_MS
      : fase === "caca" ? CACA_MS
      : INTERVALO_MS;
    sala.fase = fase;
    sala.faseAte = agora + duracao;

    // Rodada nova começa com todo mundo de pé.
    if (fase === "preparo") {
      for (const j of sala.jogadores.values()) {
        j.vida = VIDA_MAXIMA;
        // Zerar o relógio do assobio junto. `assobiar` só roda na caçada,
        // então o prazo sorteado na rodada ANTERIOR ficava parado no passado
        // durante o intervalo e o preparo -- e vencia no primeiro tique da
        // caçada seguinte. Da segunda rodada em diante, a lagartixa se
        // entregava no instante exato em que a caçada começava, jogando fora
        // o minuto que ela passou se escondendo.
        j.proximoAssobio = 0;
      }
      transmitir(sala, { tipo: "reviver", alvo: null, vida: VIDA_MAXIMA });
    }
    transmitir(sala, {
      tipo: "fase",
      fase,
      restaMs: duracao,
      anfitriao: sala.anfitriao,
      podeIniciar: podeIniciar(sala),
    });
  }

  /** Uma rodada só faz sentido com os dois lados representados. */
  function podeIniciar(sala) {
    const papeis = [...sala.jogadores.values()].map((j) => j.perfil?.papel);
    return papeis.includes("lagartixa") && papeis.includes("pessoa");
  }

  /**
   * Avisa a sala de quem manda e se já dá para começar.
   *
   * Sai a cada entrada e saída porque as duas coisas mudam com a composição:
   * o botão acende quando aparece o papel que faltava, e apaga quando ele vai
   * embora.
   */
  function anunciarSala(sala) {
    transmitir(sala, {
      tipo: "sala",
      anfitriao: sala.anfitriao,
      podeIniciar: podeIniciar(sala),
    });
  }

  /**
   * Faz as lagartixas assobiarem de tempos em tempos.
   *
   * Quem decide é o servidor, não a lagartixa: se o assobio partisse do próprio
   * cliente, bastaria um cliente adulterado que nunca assobia para a camuflagem
   * virar invisibilidade. E o evento só vai para quem está perto o bastante
   * para ouvir -- mandar para a sala toda e confiar no volume do navegador
   * entregaria a posição a qualquer um lendo o socket.
   */
  function assobiar(sala, agora) {
    for (const bicho of sala.jogadores.values()) {
      if (bicho.perfil?.papel !== "lagartixa" || bicho.vida <= 0) continue;
      if (!bicho.proximoAssobio) {
        bicho.proximoAssobio = agora + sorteioAssobio();
        continue;
      }
      if (agora < bicho.proximoAssobio) continue;
      bicho.proximoAssobio = agora + sorteioAssobio();

      for (const ouvinte of sala.jogadores.values()) {
        if (ouvinte.ws.readyState !== ouvinte.ws.OPEN) continue;
        // A própria lagartixa sempre ouve: precisa saber que acabou de se
        // entregar, senão não tem como decidir mudar de esconderijo.
        if (ouvinte.id !== bicho.id && distancia(ouvinte.pos, bicho.pos) > ASSOBIO_ALCANCE) {
          continue;
        }
        enviar(ouvinte.ws, { tipo: "assobio", id: bicho.id });
      }
    }
  }

  function sorteioAssobio() {
    return ASSOBIO_MIN_MS + Math.random() * (ASSOBIO_MAX_MS - ASSOBIO_MIN_MS);
  }

  function distancia(a, b) {
    if (!a || !b) return Infinity;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /** Durante o preparo, quem caça não recebe NADA sobre as lagartixas. */
  function escondeLagartixas(sala) {
    return sala.fase === "preparo" || sala.fase === "espera";
  }

  const tick = setInterval(() => {
    const agora = Date.now();
    for (const sala of registro.salas.values()) {
      girarFase(sala, agora);
      if (sala.jogadores.size < 2) continue;

      const todos = [...sala.jogadores.values()].map((j) => ({
        id: j.id,
        papel: j.perfil?.papel,
        p: j.pos,
        y: j.yaw,
        a: j.anim,
        e: j.escondido,
      }));

      // Filtrar aqui, e não no navegador, é o ponto: mandar a posição e pedir
      // que o cliente não desenhe deixaria a lagartixa visível para qualquer um
      // com o inspetor aberto. O que não é enviado não pode ser trapaceado.
      if (sala.fase === "caca") assobiar(sala, agora);

      const ocultar = escondeLagartixas(sala);
      const semLagartixas = ocultar
        ? todos.filter((e) => e.papel !== "lagartixa")
        : todos;

      for (const jogador of sala.jogadores.values()) {
        if (jogador.ws.readyState !== jogador.ws.OPEN) continue;
        const lista =
          ocultar && jogador.perfil?.papel !== "lagartixa" ? semLagartixas : todos;
        jogador.ws.send(
          JSON.stringify({
            tipo: "estados",
            lista: lista.map(({ papel, ...resto }) => resto),
          }),
        );
      }
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
