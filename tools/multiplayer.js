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

/**
 * Destravar: volta o jogador para onde ele ESTAVA, e não para um lugar seguro.
 *
 * Um botão de "ir para área segura" seria uma saída de emergência de graça:
 * bastaria apertar ao ouvir o primeiro tiro. Rebobinar resolve isso sozinho --
 * o destino não é escolhido nem é vantajoso, é simplesmente um lugar onde a
 * pessoa já esteve há pouco, provavelmente ainda perto de quem atira. Não
 * salva de nada; só desfaz o travamento.
 *
 * Por cima disso, o servidor recusa logo depois de levar dano, para nem o
 * empate de "voltei dois passos" virar tática.
 */
const REBOBINAR_MS = 10_000;      // o quão atrás no tempo se volta
const REBOBINAR_ESPERA = 15_000;  // entre um uso e outro
const REBOBINAR_APOS_DANO = 5_000;
const FALA_INTERVALO_MS = 700;       // entre um balão e o seguinte
const FALA_MAX = 200;                // caracteres por balão

const HISTORICO_MS = 16_000;

/**
 * O assobio é a MOEDA da lagartixa.
 *
 * Ficar parada e escondida empurra o próximo assobio para longe; qualquer
 * poder o traz para perto. Isso resolve o problema de a lagartixa passar cinco
 * minutos sem nada para fazer: esperar deixa de ser tédio e vira carregar. E
 * dá ao caçador uma leitura honesta -- quando os assobios ficam frequentes, é
 * porque ela andou aprontando.
 */
const SILENCIO_BONUS_MS = 900;    // por segundo parada e escondida
const SILENCIO_TETO_MS = 9_000;   // o quanto o silêncio pode adiar, no máximo

/** Cada poder: o que custa em assobio, e de quanto em quanto pode ser usado. */
const PODERES = {
  assobioFalso: { custo: 3_000, espera: 6_000, alcance: 18 },
  cauda:        { custo: 2_000, espera: 45_000 },
  cuspe:        { custo: 4_000, espera: 9_000, alcance: 7 },
  escuro:       { custo: 5_000, espera: 40_000 },
  arranque:     { custo: 2_000, espera: 7_000 },
};

/**
 * Os poderes de quem caça.
 *
 * O preço aqui é só a recarga -- não existe "custo" como do outro lado, porque
 * a moeda da lagartixa é o assobio, e o caçador não tem nada equivalente a
 * gastar. O que ele paga é tempo e, em quase todos, a própria posição: bater
 * na parede faz barulho, o disjuntor prende parado, o sensor fica à vista.
 *
 * A escolha do que entra foi guiada por um número só: `SILENCIO_BONUS_MS`.
 * Parada e escondida, a lagartixa compra 0,9 s de silêncio por segundo parado,
 * e a estratégia dominante virava se enfiar num canto no minuto de preparo e
 * não se mexer mais. Metade destes poderes cobra imobilidade (`batida`,
 * `sensor`) e a outra metade cobra movimento (`po`, `rede`): juntos, apertam
 * dos dois lados. A `lanterna` não está aqui porque não passa pelo servidor --
 * é luz na tela de quem a segura, e nada mais.
 */
const PODERES_CACADOR = {
  batida:    { espera: 8_000,  alcance: 8 },
  armadilha: { espera: 18_000, maximo: 2, raio: 6, gatilho: 1.1, alcance: 4 },
  rede:      { espera: 14_000, alcance: 16 },
  disjuntor: { espera: 25_000, conjuracao: 1_800 },
  po:        { espera: 20_000, alcance: 14, raio: 5 },
};

const REDE_MS = 1_500;            // quanto tempo a rede prende
const PO_MS = 12_000;             // quanto a nuvem de pó dura no chão
const PINGO_MS = 6_000;           // rastro de tinta depois de levar um tiro
const MARCA_INTERVALO_MS = 320;   // uma pegada a cada tanto, por lagartixa
const MARCA_PASSO = 0.25;         // e só se ela tiver andado isto
const BATIDA_ALCANCE_SOM = 20;    // além disto ninguém ouve a batida
const SENSOR_INTERVALO_MS = 1_400;// para uma armadilha não metralhar apitos
const ARMADILHA_PRESO_MS = 4_000; // quanto ela segura, antes de se debater
/**
 * Debater-se: cada aperto alivia um tanto, com piso.
 *
 * O piso é fração da duração, não um número fixo: assim a mesma regra serve à
 * armadilha (4 s, piso de 1,6 s) e à rede (1,5 s, piso de 0,6 s) sem inventar
 * um caso especial para cada uma.
 *
 * A contagem é do SERVIDOR e vem limitada. Um cliente adulterado mandando mil
 * apertos por segundo se soltaria na hora, e o poder viraria enfeite -- o
 * limite faz o teclado de todo mundo valer o mesmo.
 */
const DEBATE_ALIVIO_MS = 180;
const DEBATE_INTERVALO_MS = 120;  // ~8 apertos por segundo, no máximo
const DEBATE_PISO = 0.4;          // não dá para escapar antes disto do total

/**
 * Pontos.
 *
 * A lagartixa marca ASSOBIANDO -- e é uma ideia melhor do que parece, porque
 * o assobio é justamente o que a entrega. Ficar viva e perto do perigo passa a
 * valer mais do que se enfiar num canto: cada ponto que ela ganha é um convite
 * que ela mandou. O silêncio comprado com imobilidade continua funcionando,
 * só que agora ele custa placar.
 *
 * O caçador marca ELIMINANDO. A escala sai da aritmética da rodada: cinco
 * minutos dão umas 20 a 30 chances de assobio a quem sobrevive inteira, então
 * uma eliminação vale 15 para uma caçada de duas lagartixas empatar com uma
 * fuga perfeita. Não é exato, e nem deveria ser -- é para os dois lados terem
 * o que perseguir.
 */
/**
 * Bônus: o PUXÃO que tira a lagartixa do canto.
 *
 * Até aqui tudo que a fazia se mexer era castigo -- batida, armadilha, pó. E
 * castigo funciona menos que recompensa, porque a conta dela continuava
 * fechando: parada e escondida ela COMPRA silêncio, 0,9 s a cada segundo
 * parado, até 9 s. Ficar quieta era pago pelo próprio jogo.
 *
 * Então o bônus paga na MESMA MOEDA. O de silêncio adia o próximo assobio, e
 * com isso "andar agora para ficar escondida depois" vira jogada em vez de
 * sacrifício. As outras duas mexem no corpo dela, o que a obriga a um segundo
 * movimento: quem encolheu tem de achar esconderijo novo, quem cresceu perdeu
 * o que tinha.
 *
 * Quatro regras seguram o resto, e importam mais que a lista:
 *  - nascem em lugar EXPOSTO, senão premiariam o canto que se quer quebrar;
 *  - os DOIS lados veem, senão viram dinheiro grátis em vez de disputa;
 *  - anunciam-se com assobio, dizendo onde a decisão vai acontecer;
 *  - expiram, o que cobra dos dois: ela não adia, e quem montar guarda perdeu
 *    o tempo se ela não for.
 *
 * O que eles NUNCA são: requisito para vencer. Sobreviver aos cinco minutos
 * continua bastando -- se coletar virasse obrigação, esconder-se deixaria de
 * ser viável e o jogo trocaria de gênero.
 */
/**
 * Eles nascem TODOS DE UMA VEZ, e não um a um.
 *
 * A primeira versão soltava um bônus por vez a cada 26 s, e o primeiro teste
 * mostrou o problema na hora: ele nasceu a 22 m da lagartixa, e 20 s não dão
 * para atravessar o escritório. Um bônus longe demais não é decisão, é
 * paisagem -- ela olha, calcula que não dá, e continua exatamente onde estava.
 *
 * Em onda de três, um deles quase sempre está perto o bastante para valer, e
 * ela passa a ESCOLHER qual troca quer em vez de aceitar ou recusar a única
 * oferta. Dá até para pegar dois, se correr -- e correr é o ponto.
 */
const BONUS_POR_ONDA = 3;
const BONUS_INTERVALO_MS = 26_000;   // entre o fim de uma onda e a próxima
const BONUS_VIDA_MS = 30_000;        // quanto a onda espera antes de sumir
const BONUS_ALCANCE = 1.4;           // o quão perto é preciso chegar
const BONUS_PONTOS = 5;
const BONUS_SILENCIO_MS = 9_000;     // o quanto o assobio se afasta
const BONUS_TAMANHO_MS = 25_000;     // quanto dura encolher ou crescer
const ESCALA_PEQUENA = 0.62;
const ESCALA_GRANDE = 1.55;
const TIPOS_DE_BONUS = ["silencio", "surpresa", "armadura"];

/**
 * O esconderijo estraga.
 *
 * Não expulsa ninguém: só faz o canto perfeito ir ficando menos perfeito. É o
 * empurrão suave que acompanha o puxão dos bônus -- sem ele, quem decidir
 * ignorar os bônus continua com a mesma vida boa de antes.
 */
const MOFO_RAIO = 3;                 // metros que contam como "o mesmo canto"
const MOFO_MS = 45_000;              // depois disto, o assobio vaza mais longe
const MOFO_ALCANCE_EXTRA = 4;

/**
 * A rede se fecha.
 *
 * Havia canto no escritório de onde era inviável ser achada -- e cinco minutos
 * procurando sem nenhuma chance não é tensão, é tédio. Em vez de dar mais um
 * aparelho ao caçador, o próprio assobio aperta: ele vaza mais longe conforme
 * a caçada avança e sai mais vezes no terço final. O começo continua igual,
 * que é quando esconder-se tem de valer.
 */
const CERCO_ALCANCE_EXTRA = 8;       // somados ao longo da caçada inteira
const CERCO_PRESSA = 0.45;           // encurta até 45% do intervalo, no fim

const PONTOS_ASSOBIO = 1;
const PONTOS_ELIMINACAO = 15;
const ESCURO_MS = 20_000;
const CAUDA_MS = 30_000;
// 5 s: os primeiros ~2,2 s cegam de verdade, o resto escorre.
const CUSPE_MS = 5_000;

// Limites do mundo. O cenário tem ~64 x 38 m; a folga é generosa para não
// brigar com quem cair fora da geometria, mas fecha o valor absurdo.
const MUNDO = { xz: 400, yMin: -60, yMax: 200 };
const VELOCIDADE_MAX = 14;           // m/s; correr são 4.6, pular sobe ~8

const ANIMACOES = new Set([
  "Parado", "Andar", "Pular", "Sentar", "Esconder",
  // Poses de silhueta da lagartixa. Viajam pelo mesmo campo das animações --
  // para os outros jogadores, uma pose é só o clipe que o bicho está tocando.
  "EmPe", "Deitada", "Encolhida",
  // As mesmas poses, andando. Sem elas na lista o servidor recusaria o nome e
  // os outros veriam a lagartixa parada enquanto ela atravessa a sala.
  "EmPeAndar", "DeitadaAndar", "EncolhidaAndar",
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

/** Vetor de 3 números com comprimento ~1, ou null. */
function unitario(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(numero)) return null;
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 0.5) || n > 1.5) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

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
      eliminado: jogador.eliminado === true,
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
      midia: { camera: false, microfone: false, tela: false },
      escondido: false,
      pintura: "#5f9e4a",
      textura: null,
      ultimaTexturaEm: 0,
      proximoAssobio: 0,
      eliminado: false,
      pitch: 0,
      cima: null,
      frente: null,
      // Rastro de posições, para o `destravar` ter para onde voltar.
      historico: [],
      ultimaFalaEm: 0,
      ultimoDanoEm: 0,
      ultimoDestravarEm: 0,
      pulaChecagemDeVelocidade: false,
      // Quando cada poder poderá ser usado de novo, e quanto silêncio a
      // lagartixa acumulou parada.
      esperaDePoder: {},
      // Placar da PARTIDA, não da rodada: só "nova partida" zera.
      pontos: 0,
      silencioMs: 0,
      paradaDesde: 0,
      // Poderes do caçador: sensores largados, e o disjuntor em conjuração.
      sensores: [],
      conjurandoAte: 0,
      // Da lagartixa: presa pela rede, e pingando tinta depois de um tiro.
      // Bônus: escudo, tamanho e o canto onde ela está mofando.
      escudo: false,
      escala: 1,
      escalaAte: 0,
      cantoDesde: 0,
      canto: null,
      presoAte: 0,
      presoDesde: 0,
      presoTotal: 0,
      ultimoDebateEm: 0,
      pingandoAte: 0,
      ultimaMarcaEm: 0,
      posDaMarca: null,
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
          // E o placar vai junto, para todos. Quem chega precisa dele para
          // saber onde a partida está; quem já estava precisa porque uma
          // reentrada pode ter TROCADO o papel de alguém, e o placar é onde o
          // papel de cada um aparece escrito.
          transmitir(sala, { tipo: "placar", lista: placarDe(sala) });
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
        // Um salto é esperado logo depois de destravar; a checagem volta a
        // valer no estado seguinte.
        if (estado.pulaChecagemDeVelocidade) {
          estado.pulaChecagemDeVelocidade = false;
        } else if (estado.ultimoEstadoEm && dt > 0) {
          const d = Math.hypot(
            p[0] - estado.pos[0],
            p[1] - estado.pos[1],
            p[2] - estado.pos[2],
          );
          // Rejeitar em vez de corrigir: o cliente legítimo nunca estoura isso,
          // e devolver uma posição "arrumada" só faria o avatar teleportar.
          if (d / dt > VELOCIDADE_MAX && dt < 1) return;
        }

        // Andar quebra o silêncio: o bônus é por ficar IMÓVEL, não por estar
        // escondida num canto enquanto se atravessa o escritório.
        const andou = estado.pos
          && Math.hypot(p[0] - estado.pos[0], p[1] - estado.pos[1], p[2] - estado.pos[2]) > 0.05;
        if (andou) {
          estado.silencioMs = 0;
          estado.paradaDesde = 0;
          // Marca própria de movimento: `paradaDesde` é reescrito a cada tique
          // pelo contador de silêncio, então não serve para perguntar "faz
          // quanto tempo que ela está parada?" -- que é o que o sensor precisa.
          estado.ultimoMovimentoEm = agora;
        }

        // Mofo: quanto tempo ela está no MESMO canto, e não quanto tempo está
        // imóvel. Andar em círculos dentro de três metros continua sendo o
        // mesmo esconderijo, e é isso que o alcance extra cobra.
        if (estado.perfil?.papel === "lagartixa") {
          if (!estado.canto || distancia(p, estado.canto) > MOFO_RAIO) {
            estado.canto = [p[0], p[1], p[2]];
            estado.cantoDesde = agora;
          }
        }

        // Presa pela rede: a posição não avança, decidido AQUI.
        //
        // Pedir ao cliente que congele funcionaria para quem joga limpo, e um
        // cliente adulterado ignoraria a rede inteira. Recusar o estado é o
        // mesmo remédio da checagem de velocidade: o que o servidor não aceita
        // não aconteceu.
        if (agora < (estado.presoAte ?? 0)) {
          estado.yaw = msg.y;   // olhar continua livre; andar, não
          estado.ultimoEstadoEm = agora;
          return;
        }

        // Andar cancela a conjuração do disjuntor. É o preço dele: quase dois
        // segundos parado e barulhento, no escuro, com a lagartixa ouvindo.
        if (andou && estado.conjurandoAte > agora) {
          estado.conjurandoAte = 0;
          transmitir(estado.sala, { tipo: "disjuntor-cancelado", de: estado.id });
        }
        estado.pos = [p[0], p[1], p[2]];
        estado.yaw = msg.y;
        // Preso à faixa que a câmera do jogo permite: um cliente adulterado
        // mandando 40 rad faria a câmera de quem assiste dar cambalhota.
        estado.pitch = numero(msg.t) ? Math.max(-1.5, Math.min(1.5, msg.t)) : 0;
        // Orientação de escalada da lagartixa. Só aceita vetor unitário: um
        // cliente adulterado mandando números enormes esticaria o avatar dela
        // pela sala inteira na tela dos outros.
        estado.cima = unitario(msg.c);
        estado.frente = unitario(msg.f);
        estado.anim = ANIMACOES.has(msg.a) ? msg.a : "Parado";
        estado.escondido = msg.e === true;
        estado.ultimoEstadoEm = agora;
        return;
      }

      // ---- chat entre jogadores

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

      // ---- pular o preparo / reiniciar a rodada
      //
      // Mesmas guardas do "começar": só o anfitrião, e só quando a ação faz
      // sentido na fase atual. Um cliente qualquer mandando "reiniciar" no
      // meio da caçada apagaria a partida dos outros.
      if (msg.tipo === "nova-partida") {
        if (!estado.sala) return;
        const sala = estado.sala;
        if (sala.anfitriao !== estado.id) {
          return enviar(ws, {
            tipo: "recado",
            texto: "Só quem abriu a sala comanda a rodada.",
          });
        }
        // Zera o placar e devolve todo mundo à escolha de personagem. É a
        // ÚNICA coisa que apaga pontos: reiniciar a caçada não apaga, senão
        // não haveria como jogar várias rodadas seguidas valendo alguma coisa.
        for (const j of sala.jogadores.values()) j.pontos = 0;
        trocarFase(sala, "espera", Date.now());
        transmitir(sala, { tipo: "placar", lista: placarDe(sala) });
        transmitir(sala, { tipo: "escolher-papel" });
        return;
      }

      if (msg.tipo === "pular" || msg.tipo === "reiniciar") {
        if (!estado.sala) return;
        const sala = estado.sala;
        if (sala.anfitriao !== estado.id) {
          return enviar(ws, {
            tipo: "recado",
            texto: "Só quem abriu a sala comanda a rodada.",
          });
        }
        if (!podeIniciar(sala)) {
          return enviar(ws, {
            tipo: "recado",
            texto: "Precisa de pelo menos uma lagartixa e um caçador.",
          });
        }

        if (msg.tipo === "pular") {
          if (sala.fase !== "preparo") return;
          trocarFase(sala, "caca", Date.now());
        } else {
          if (sala.fase === "espera") return;
          trocarFase(sala, "preparo", Date.now());
        }
        return;
      }

      // ---- destravar
      if (msg.tipo === "destravar") {
        if (!estado.sala) return;
        const agoraD = Date.now();

        if (agoraD - estado.ultimoDestravarEm < REBOBINAR_ESPERA) {
          const falta = Math.ceil(
            (REBOBINAR_ESPERA - (agoraD - estado.ultimoDestravarEm)) / 1000,
          );
          return enviar(ws, { tipo: "recado", texto: `Espere ${falta}s para destravar de novo.` });
        }

        // Cair no vazio não é tática: ninguém se joga para fora do mundo para
        // escapar de um tiro, e quem cai não tem outra saída. Fora esse caso,
        // levar dano recente tranca o botão.
        const caiu = msg.motivo === "limbo";
        if (!caiu && agoraD - estado.ultimoDanoEm < REBOBINAR_APOS_DANO) {
          return enviar(ws, {
            tipo: "recado",
            texto: "Não dá para destravar logo depois de levar tiro.",
          });
        }

        const antigo = estado.historico.find((h) => agoraD - h.t >= REBOBINAR_MS)
          ?? estado.historico[0];
        if (!antigo) {
          return enviar(ws, { tipo: "recado", texto: "Ainda não há para onde voltar." });
        }

        estado.ultimoDestravarEm = agoraD;
        estado.pos = [...antigo.p];
        // Marca o instante em vez de zerar: zerado, a checagem de velocidade
        // realmente é pulada no próximo estado -- mas a amostragem do rastro,
        // que também olha este campo, pararia para sempre.
        estado.ultimoEstadoEm = agoraD;
        estado.pulaChecagemDeVelocidade = true;
        estado.historico.length = 0;
        enviar(ws, { tipo: "reposicionar", p: estado.pos });
        return;
      }

      // ---- poderes da lagartixa
      //
      // Tudo validado aqui: papel, fase, vida, espera e alcance. Um cliente
      // adulterado poderia cuspir de 40 m ou soltar assobio falso sem parar;
      // o que o navegador manda é um PEDIDO, não um fato.
      // ---- os lugares onde um bônus pode nascer
      //
      // Vêm do cliente porque o servidor não carrega o cenário: ele valida
      // posições contra os limites do mundo e mais nada. Todo mundo calcula a
      // mesma lista do mesmo GLB, então o pior que um cliente adulterado
      // consegue é escolher lugares ruins -- não há vantagem a tirar daí, e o
      // servidor continua sendo quem decide QUANDO e QUAL bônus nasce.
      if (msg.tipo === "pontos-bonus") {
        if (!estado.sala || !Array.isArray(msg.lista)) return;
        if (estado.sala.pontosDeBonus?.length) return;   // o primeiro já mandou
        const pontos = msg.lista.slice(0, 200).map(ponto).filter(Boolean);
        if (pontos.length) estado.sala.pontosDeBonus = pontos;
        return;
      }

      if (msg.tipo === "pegar-bonus") {
        const sala = estado.sala;
        if (!sala?.bonusVivos?.length || sala.fase !== "caca") return;
        if (estado.perfil?.papel !== "lagartixa" || estado.eliminado) return;
        const bonus = sala.bonusVivos.find((b) => b.id === msg.id);
        if (!bonus) return;
        if (distancia(estado.pos, bonus.p) > BONUS_ALCANCE) return;
        aplicarBonus(sala, estado, bonus);
        return;
      }

      // ---- balão de fala sobre a cabeça
      //
      // Não é o chat da sala, que saiu: aqui a frase vira um balão no mundo,
      // some sozinha e não fica guardada em lugar nenhum. Por isso também não
      // há histórico -- quem chega depois não tem o que ler, e não deveria.
      if (msg.tipo === "fala") {
        if (!estado.sala) return;
        const agoraF = Date.now();
        if (agoraF - estado.ultimaFalaEm < FALA_INTERVALO_MS) return;
        const texto = limpar(msg.texto, FALA_MAX);
        if (!texto) return;
        estado.ultimaFalaEm = agoraF;
        transmitir(estado.sala, {
          tipo: "fala",
          id: estado.id,
          nome: estado.perfil.nome,
          cor: estado.perfil.cor,
          texto,
          em: agoraF,
        });
        return;
      }

      // ---- debater-se para sair de uma armadilha ou de uma rede
      if (msg.tipo === "debater") {
        const agoraD = Date.now();
        if (agoraD >= (estado.presoAte ?? 0)) return;
        // Limite de apertos contados. Sem ele, um cliente adulterado mandando
        // mil por segundo sairia no mesmo quadro em que entrou.
        if (agoraD - estado.ultimoDebateEm < DEBATE_INTERVALO_MS) return;
        estado.ultimoDebateEm = agoraD;

        const piso = estado.presoDesde + estado.presoTotal * DEBATE_PISO;
        estado.presoAte = Math.max(piso, estado.presoAte - DEBATE_ALIVIO_MS);
        enviar(estado.ws, {
          tipo: "preso",
          restaMs: Math.max(0, estado.presoAte - agoraD),
          totalMs: estado.presoTotal,
        });
        return;
      }

      if (msg.tipo === "poder") {
        if (!estado.sala) return;
        // Cada papel tem a sua tabela, e o nome do poder decide junto com ela:
        // um caçador pedindo "cuspe" não acha regra nenhuma e para aqui.
        const daLagartixa = estado.perfil?.papel === "lagartixa";
        const regra = daLagartixa ? PODERES[msg.qual] : PODERES_CACADOR[msg.qual];
        if (!regra) return;
        if (estado.eliminado || estado.vida <= 0) return;
        if (estado.sala.fase !== "caca") return;

        const agoraP = Date.now();
        if (agoraP < (estado.esperaDePoder[msg.qual] ?? 0)) return;
        estado.esperaDePoder[msg.qual] = agoraP + regra.espera;

        if (daLagartixa) {
          // O preço: o próximo assobio chega mais cedo. Nunca antes de agora --
          // um poder adianta a entrega, não a torna instantânea.
          estado.proximoAssobio = Math.max(agoraP + 500, (estado.proximoAssobio || agoraP) - regra.custo);
          estado.silencioMs = 0;
        }

        const feito = daLagartixa
          ? despacharPoder(estado, msg, regra, agoraP)
          : despacharPoderCacador(estado, msg, regra, agoraP);
        if (!feito) {
          // Recusado por alcance ou alvo inválido: devolve a espera, senão a
          // pessoa perde o poder por um erro de mira.
          estado.esperaDePoder[msg.qual] = 0;
        }
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

        // A armadura segura um tiro e QUEBRA à vista. Um acerto que não faz
        // nada pareceria defeito para os dois lados: quem atirou precisa saber
        // que acertou, e quem levou precisa saber que foi descoberta.
        if (alvo.escudo) {
          alvo.escudo = false;
          alvo.ultimoDanoEm = agoraT;
          transmitir(estado.sala, { tipo: "escudo-quebrou", alvo: alvo.id });
          return;
        }

        alvo.vida = Math.max(0, alvo.vida - 1);
        alvo.ultimoDanoEm = agoraT;
        // Sobreviveu ao tiro: sai pingando tinta.
        //
        // A lagartixa aguenta três acertos, e sem isto o primeiro não valia
        // quase nada -- ela sumia atrás do armário e a caçada recomeçava do
        // zero. O rastro dura seis segundos e só aparece se ela ANDAR, então
        // continua havendo a escolha de congelar e apostar em não ser vista.
        if (alvo.vida > 0 && alvo.perfil?.papel === "lagartixa") {
          alvo.pingandoAte = agoraT + PINGO_MS;
          alvo.posDaMarca = [...alvo.pos];
          enviar(alvo.ws, { tipo: "pingando", duracaoMs: PINGO_MS });
        }
        transmitir(estado.sala, {
          tipo: "dano",
          de: estado.id,
          alvo: alvo.id,
          vida: alvo.vida,
        });

        if (alvo.vida === 0) {
          const sala = estado.sala;

          // Lagartixa achada está fora da rodada, e não volta.
          //
          // É o que dá peso à caçada: com respawn, ser encontrada custava
          // quatro segundos e a camuflagem não valia nada. Sem ele, cada
          // acerto é definitivo -- e é por isso que a eliminada ganha câmera
          // de espectador em vez de simplesmente ficar olhando a tela de
          // "abatido".
          if (alvo.perfil?.papel === "lagartixa") {
            alvo.eliminado = true;
            estado.pontos += PONTOS_ELIMINACAO;
            sala.placarSujo = true;
            transmitir(sala, {
              tipo: "eliminado",
              id: alvo.id,
              nome: alvo.perfil?.nome ?? "",
              por: estado.perfil?.nome ?? "",
            });
            // Sem lagartixa viva não há o que caçar; deixar o cronômetro
            // correr até o fim seria mandar os caçadores procurarem ninguém.
            if (!restamLagartixas(sala)) {
              trocarFase(sala, "intervalo", Date.now(), {
                vencedor: "cacadores",
                motivo: "Todas as lagartixas foram encontradas.",
              });
            }
            return;
          }

          // Caçador volta: ele é o lado que precisa continuar procurando.
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
      // Os sensores dele saem junto: sem isto, um caçador que fecha a aba
      // deixaria dois apitos tocando pela rodada inteira, sem dono.
      for (const posto of estado.sensores ?? []) {
        transmitir(sala, { tipo: "armadilha-fora", id: posto.id });
      }
      estado.sensores.length = 0;
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
    // O relógio venceu com lagartixa viva: elas ganham. É a única condição de
    // vitória delas, e é o que dá sentido aos cinco minutos.
    if (sala.fase === "caca") {
      return trocarFase(sala, "intervalo", agora, {
        vencedor: "lagartixas",
        motivo: "O tempo acabou com lagartixa solta.",
      });
    }
    // Fim do intervalo volta para a sala de espera, e não direto para outra
    // rodada: entre uma e outra as pessoas trocam de papel, entram e saem.
    return trocarFase(sala, "espera", agora);
  }

  /**
   * Quem ganha.
   *
   * Só há duas maneiras de a caçada acabar, e cada uma tem um dono: se todas
   * as lagartixas forem encontradas antes do relógio, os caçadores vencem; se
   * o relógio vencer com uma solta, elas vencem. Não existe empate, e é de
   * propósito -- num esconde-esconde o empate é sempre a favor de quem se
   * escondeu, então chamá-lo de vitória delas é mais honesto do que fingir
   * que ninguém ganhou.
   *
   * O resultado é da RODADA. O placar, que atravessa as rodadas, é outra
   * conta: dá para perder a rodada e ainda liderar a partida por ter assobiado
   * muito antes de cair.
   */
  function trocarFase(sala, fase, agora, resultado = null) {
    const duracao =
      fase === "espera" ? 0
      : fase === "preparo" ? PREPARO_MS
      : fase === "caca" ? CACA_MS
      : INTERVALO_MS;
    sala.fase = fase;
    sala.faseAte = agora + duracao;

    // Rodada nova começa com todo mundo de pé -- e a volta para a sala de
    // espera também, senão a lagartixa eliminada ficaria presa no modo
    // espectador entre uma rodada e outra, sem poder se reposicionar nem
    // repintar para a próxima.
    if (fase === "preparo" || fase === "espera") {
      for (const j of sala.jogadores.values()) {
        j.vida = VIDA_MAXIMA;
        // Rodada nova zera as eliminações: quem caiu volta a jogar.
        j.eliminado = false;
        // Zerar o relógio do assobio junto. `assobiar` só roda na caçada,
        // então o prazo sorteado na rodada ANTERIOR ficava parado no passado
        // durante o intervalo e o preparo -- e vencia no primeiro tique da
        // caçada seguinte. Da segunda rodada em diante, a lagartixa se
        // entregava no instante exato em que a caçada começava, jogando fora
        // o minuto que ela passou se escondendo.
        j.proximoAssobio = 0;
        // Todo mundo volta ao ponto de nascimento, e esse salto seria recusado
        // pela checagem de velocidade se não fosse liberado aqui.
        j.pulaChecagemDeVelocidade = true;
        j.historico.length = 0;
        // E nada da rodada passada atravessa: sensor largado, rede, tinta
        // pingando e disjuntor pela metade morrem com a rodada.
        j.sensores.length = 0;
        j.esperaDePoder = {};
        j.presoAte = 0;
        j.pingandoAte = 0;
        j.conjurandoAte = 0;
        j.posDaMarca = null;
        j.escudo = false;
        j.escala = 1;
        j.escalaAte = 0;
        j.canto = null;
        j.cantoDesde = 0;
      }
      sala.nuvens = [];
      sala.bonusVivos = [];
      sala.proximoBonus = 0;
      transmitir(sala, { tipo: "limpar-campo" });
      transmitir(sala, { tipo: "reviver", alvo: null, vida: VIDA_MAXIMA });
    }
    // O resultado morre com a rodada seguinte: guardar só até a próxima troca
    // evita que a tela de fim reapareça no começo da caçada seguinte.
    sala.resultado = fase === "intervalo" ? resultado : null;
    transmitir(sala, {
      tipo: "fase",
      fase,
      restaMs: duracao,
      anfitriao: sala.anfitriao,
      podeIniciar: podeIniciar(sala),
      resultado: sala.resultado,
    });
  }

  /** Solta uma onda de bônus, e recolhe os que venceram. */
  function girarBonus(sala, agora) {
    sala.bonusVivos = sala.bonusVivos ?? [];

    if (sala.bonusVivos.length) {
      const vencidos = sala.bonusVivos.filter((b) => agora >= b.expiraEm);
      for (const b of vencidos) transmitir(sala, { tipo: "bonus-fora", id: b.id });
      if (vencidos.length) {
        sala.bonusVivos = sala.bonusVivos.filter((b) => agora < b.expiraEm);
      }
      // A próxima onda só é marcada quando a atual esvazia -- por vencimento
      // ou porque ela pegou tudo.
      if (!sala.bonusVivos.length) sala.proximoBonus = agora + BONUS_INTERVALO_MS;
      return;
    }

    if (!sala.pontosDeBonus?.length) return;
    if (agora < (sala.proximoBonus ?? 0)) return;

    // Pontos distintos, sorteados sem repetir: dois bônus no mesmo lugar
    // desperdiçariam metade da onda.
    const sobrando = [...sala.pontosDeBonus];
    const tipos = [...TIPOS_DE_BONUS];
    const quantos = Math.min(BONUS_POR_ONDA, sobrando.length, tipos.length);

    for (let i = 0; i < quantos; i++) {
      const p = sobrando.splice(Math.floor(Math.random() * sobrando.length), 1)[0];
      // Um de cada tipo por onda: sorteando com repetição, uma onda inteira de
      // armadura tiraria dela justamente a escolha que a onda existe para dar.
      const qual = tipos.splice(Math.floor(Math.random() * tipos.length), 1)[0];
      sala.contaDeBonus = (sala.contaDeBonus ?? 0) + 1;
      const bonus = {
        id: `b${sala.contaDeBonus}`,
        p: [...p],
        qual,
        expiraEm: agora + BONUS_VIDA_MS,
      };
      sala.bonusVivos.push(bonus);
      transmitir(sala, {
        tipo: "bonus", id: bonus.id, p: bonus.p, qual, duracaoMs: BONUS_VIDA_MS,
      });
      // Cada um se anuncia de onde caiu. Como o som é posicional, ninguém ouve
      // os três: cada pessoa ouve os que estão perto dela, que é a informação
      // que interessa.
      for (const j of sala.jogadores.values()) {
        if (j.ws.readyState !== j.ws.OPEN) continue;
        enviar(j.ws, { tipo: "assobio", p: bonus.p, falso: true });
      }
    }
  }

  function aplicarBonus(sala, bicho, bonus) {
    const agora = Date.now();
    bicho.pontos += BONUS_PONTOS;
    sala.placarSujo = true;

    let efeito = bonus.qual;
    if (bonus.qual === "silencio") {
      // Paga na moeda da imobilidade: em vez de ficar parada para adiar o
      // assobio, ela anda até o bônus e adia mais do que ficaria parada.
      bicho.proximoAssobio = Math.max(agora + 1000, (bicho.proximoAssobio || agora) + BONUS_SILENCIO_MS);
    } else if (bonus.qual === "armadura") {
      bicho.escudo = true;
    } else {
      // Surpresa: o servidor sorteia, e é ele quem sabe. Nada no pacote que
      // cria o bônus diz o que vai sair -- é isso que faz pegá-lo ser uma
      // aposta, e a aposta é o que tira a lagartixa do canto.
      efeito = Math.random() < 0.5 ? "encolher" : "crescer";
      bicho.escala = efeito === "encolher" ? ESCALA_PEQUENA : ESCALA_GRANDE;
      bicho.escalaAte = agora + BONUS_TAMANHO_MS;
    }

    enviar(bicho.ws, {
      tipo: "bonus-meu", qual: bonus.qual, efeito,
      duracaoMs: bonus.qual === "surpresa" ? BONUS_TAMANHO_MS : 0,
    });
    transmitir(sala, { tipo: "bonus-pego", id: bonus.id, de: bicho.id, qual: bonus.qual });
    // Sai só ELE. Os irmãos de onda continuam de pé -- dá para pegar dois se
    // correr, e correr é exatamente o que se quer dela.
    sala.bonusVivos = sala.bonusVivos.filter((b) => b.id !== bonus.id);
    if (!sala.bonusVivos.length) sala.proximoBonus = agora + BONUS_INTERVALO_MS;
  }

  /** Devolve o tamanho normal quando o efeito vence. */
  function girarTamanhos(sala, agora) {
    for (const j of sala.jogadores.values()) {
      if (!j.escalaAte || agora < j.escalaAte) continue;
      j.escalaAte = 0;
      j.escala = 1;
      enviar(j.ws, { tipo: "bonus-meu", qual: "surpresa", efeito: "normal", duracaoMs: 0 });
    }
  }

  /**
   * O alcance do assobio DELA, agora.
   *
   * Três coisas o esticam: o tempo de caçada (a rede se fechando), mofar no
   * mesmo canto, e nada mais. Encolher não entra de propósito -- seria punir
   * duas vezes o mesmo sorteio.
   */
  function alcanceDoAssobio(sala, bicho, agora) {
    let alcance = ASSOBIO_ALCANCE;

    const decorrido = CACA_MS - Math.max(0, sala.faseAte - agora);
    const andamento = Math.min(1, Math.max(0, decorrido / CACA_MS));
    alcance += CERCO_ALCANCE_EXTRA * andamento;

    if (bicho.cantoDesde && agora - bicho.cantoDesde > MOFO_MS) {
      alcance += MOFO_ALCANCE_EXTRA;
    }
    return alcance;
  }

  /** O placar da sala, do maior para o menor. */
  function placarDe(sala) {
    return [...sala.jogadores.values()]
      .map((j) => ({
        id: j.id,
        nome: j.perfil?.nome ?? "",
        papel: j.perfil?.papel,
        pontos: j.pontos ?? 0,
      }))
      .sort((a, b) => b.pontos - a.pontos);
  }

  function restamLagartixas(sala) {
    for (const j of sala.jogadores.values()) {
      if (j.perfil?.papel === "lagartixa" && !j.eliminado) return true;
    }
    return false;
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
      if (bicho.perfil?.papel !== "lagartixa" || bicho.vida <= 0 || bicho.eliminado) continue;
      if (!bicho.proximoAssobio) {
        // No terço final o assobio sai mais vezes: é a outra metade do cerco.
      const decorrido = CACA_MS - Math.max(0, sala.faseAte - agora);
      const andamento = Math.min(1, Math.max(0, decorrido / CACA_MS));
      const pressa = 1 - (1 - CERCO_PRESSA) * Math.max(0, (andamento - 0.6) / 0.4);
      bicho.proximoAssobio = agora + sorteioAssobio() * pressa;
        bicho.paradaDesde = agora;
        continue;
      }

      // Silêncio comprado com imobilidade: parada E escondida, o próximo
      // assobio se afasta. É o que dá sentido a esperar.
      const quieta = bicho.escondido && bicho.paradaDesde > 0;
      if (quieta && bicho.silencioMs < SILENCIO_TETO_MS) {
        const ganho = Math.min(
          SILENCIO_BONUS_MS * ((agora - bicho.paradaDesde) / 1000),
          SILENCIO_TETO_MS - bicho.silencioMs,
        );
        if (ganho > 0) {
          bicho.silencioMs += ganho;
          bicho.proximoAssobio += ganho;
        }
      }
      bicho.paradaDesde = agora;

      if (agora < bicho.proximoAssobio) continue;
      // No terço final o assobio sai mais vezes: é a outra metade do cerco.
      const decorrido = CACA_MS - Math.max(0, sala.faseAte - agora);
      const andamento = Math.min(1, Math.max(0, decorrido / CACA_MS));
      const pressa = 1 - (1 - CERCO_PRESSA) * Math.max(0, (andamento - 0.6) / 0.4);
      bicho.proximoAssobio = agora + sorteioAssobio() * pressa;
      bicho.silencioMs = 0;
      // Assobiou e continua viva: marca. O ponto e a entrega são a mesma coisa.
      bicho.pontos += PONTOS_ASSOBIO;
      sala.placarSujo = true;

      const alcance = alcanceDoAssobio(sala, bicho, agora);
      for (const ouvinte of sala.jogadores.values()) {
        if (ouvinte.ws.readyState !== ouvinte.ws.OPEN) continue;
        // A própria lagartixa sempre ouve: precisa saber que acabou de se
        // entregar, senão não tem como decidir mudar de esconderijo.
        if (ouvinte.id !== bicho.id && distancia(ouvinte.pos, bicho.pos) > alcance) {
          continue;
        }
        enviar(ouvinte.ws, { tipo: "assobio", id: bicho.id });
      }
    }
  }

  /**
   * Executa o poder. Devolve false se o pedido não fazia sentido no mundo.
   */
  function despacharPoder(estado, msg, regra, agora) {
    const sala = estado.sala;

    if (msg.qual === "assobioFalso") {
      const alvo = ponto(msg.p);
      if (!alvo || distancia(alvo, estado.pos) > regra.alcance) return false;
      // Vai para quem está perto do PONTO FALSO, não da lagartixa: é isso que
      // manda o caçador para a sala errada.
      for (const ouvinte of sala.jogadores.values()) {
        if (ouvinte.ws.readyState !== ouvinte.ws.OPEN) continue;
        if (ouvinte.id !== estado.id && distancia(ouvinte.pos, alvo) > ASSOBIO_ALCANCE) continue;
        // `de` vai junto para o cliente saber de onde a pedra sai.
        enviar(ouvinte.ws, { tipo: "assobio", p: alvo, falso: true, de: estado.id });
      }
      return true;
    }

    if (msg.qual === "cauda") {
      const alvo = ponto(msg.p) ?? estado.pos;
      // A direção da fuga vem do cliente e é normalizada aqui; ela só decide
      // para onde a isca corre na tela, então errar não quebra nada -- mas um
      // vetor gigante mandaria o chamariz para fora do mapa num quadro.
      const fuga = unitario(msg.d);
      transmitir(sala, {
        tipo: "cauda", id: estado.id, p: alvo, d: fuga, duracaoMs: CAUDA_MS,
      });
      // A isca assobia sozinha logo depois de cair -- sem isso ninguém iria
      // até ela.
      setTimeout(() => {
        if (!sala.jogadores.has(estado.id)) return;
        for (const ouvinte of sala.jogadores.values()) {
          if (ouvinte.ws.readyState !== ouvinte.ws.OPEN) continue;
          if (distancia(ouvinte.pos, alvo) > ASSOBIO_ALCANCE) continue;
          enviar(ouvinte.ws, { tipo: "assobio", p: alvo, falso: true });
        }
      }, 1200);
      return true;
    }

    if (msg.qual === "cuspe") {
      const alvo = sala.jogadores.get(msg.alvo);
      if (!alvo || alvo.perfil?.papel === "lagartixa") return false;
      if (distancia(alvo.pos, estado.pos) > regra.alcance) return false;
      const cor = /^#[0-9a-f]{6}$/i.test(msg.cor ?? "") ? msg.cor : "#5f9e4a";
      enviar(alvo.ws, { tipo: "cuspe", cor, duracaoMs: CUSPE_MS });
      // Todo mundo vê o jato sair: é o que torna o cuspe arriscado.
      transmitir(sala, { tipo: "cuspe-visto", de: estado.id, alvo: alvo.id, cor });
      return true;
    }

    if (msg.qual === "escuro") {
      transmitir(sala, { tipo: "escuro", ateMs: ESCURO_MS });
      return true;
    }

    // Arranque é só velocidade local; o servidor cobra o preço e não faz mais.
    return true;
  }

  /**
   * Os poderes de quem caça.
   *
   * Todos passam por aqui pelo mesmo motivo dos da lagartixa: quem decide se
   * valeu é o servidor. A diferença é o que cada um manda de volta -- a batida
   * não revela ninguém, o sensor revela que ALGO se moveu e não o quê, e só a
   * rede toca no corpo de outro jogador.
   */
  function despacharPoderCacador(estado, msg, regra, agora) {
    const sala = estado.sala;

    if (msg.qual === "batida") {
      // Desfaz o silêncio comprado com imobilidade.
      //
      // É o poder que existe por causa de um número: parada e escondida, a
      // lagartixa ganha 0,9 s de silêncio a cada segundo parado, e ficar num
      // canto sem se mexer era a jogada dominante. A batida não diz onde ela
      // está nem tira vida -- só devolve o relógio ao zero e adianta o próximo
      // assobio. Quem estava parada há dois minutos volta a valer o mesmo que
      // quem acabou de chegar.
      for (const bicho of sala.jogadores.values()) {
        if (bicho.perfil?.papel !== "lagartixa" || bicho.eliminado) continue;
        if (distancia(bicho.pos, estado.pos) > regra.alcance) continue;
        bicho.silencioMs = 0;
        bicho.paradaDesde = agora;
        bicho.proximoAssobio = Math.min(bicho.proximoAssobio || agora, agora + 1200);
        enviar(bicho.ws, { tipo: "batida-sentida" });
      }
      // E o barulho custa a posição de quem bateu: quem está perto ouve de
      // onde veio. Sem isso a batida seria informação de graça.
      for (const ouvinte of sala.jogadores.values()) {
        if (ouvinte.ws.readyState !== ouvinte.ws.OPEN) continue;
        if (distancia(ouvinte.pos, estado.pos) > BATIDA_ALCANCE_SOM) continue;
        enviar(ouvinte.ws, { tipo: "batida", p: estado.pos, de: estado.id });
      }
      return true;
    }

    if (msg.qual === "armadilha") {
      const alvo = ponto(msg.p);
      if (!alvo || distancia(alvo, estado.pos) > regra.alcance) return false;
      // Passando do limite, o mais antigo sai. Travar o poder quando os dois
      // estão postos obrigaria a lembrar onde foram largados para recolher.
      if (estado.sensores.length >= regra.maximo) {
        const velho = estado.sensores.shift();
        transmitir(sala, { tipo: "armadilha-fora", id: velho.id });
      }
      sala.proximoSensor = (sala.proximoSensor ?? 0) + 1;
      const posto = {
        id: `${estado.id}:${sala.proximoSensor}`,
        p: alvo,
        dono: estado.id,
        // Um respiro antes de armar, senão ele apita com quem acabou de
        // largá-lo ainda em cima.
        prontoEm: agora + 1500,
        ultimoApitoEm: 0,
      };
      estado.sensores.push(posto);
      // Visível para TODO MUNDO, de propósito. Um sensor invisível seria uma
      // armadilha sem resposta; à vista, ele nega a área -- que é o que se
      // queria dele -- e a lagartixa ainda pode dar a volta.
      transmitir(sala, { tipo: "armadilha", id: posto.id, p: alvo, dono: estado.id });
      return true;
    }

    if (msg.qual === "rede") {
      const alvo = sala.jogadores.get(msg.alvo);
      if (!alvo || alvo.perfil?.papel !== "lagartixa" || alvo.eliminado) return false;
      if (distancia(alvo.pos, estado.pos) > regra.alcance) return false;
      // Não tira vida: prende. É a resposta ao arranque, e por isso ela
      // recompensa mirar na frente dela em vez de perseguir.
      prender(alvo, agora, REDE_MS);
      transmitir(sala, {
        tipo: "rede", de: estado.id, alvo: alvo.id, duracaoMs: REDE_MS,
      });
      return true;
    }

    if (msg.qual === "disjuntor") {
      // Tem tempo de conjuração, e ele é o ponto: acender a luz de qualquer
      // lugar seria desfazer o poder da lagartixa de graça. Aqui custa ficar
      // parado e barulhento durante quase dois segundos -- e andar cancela
      // (ver a checagem no estado).
      estado.conjurandoAte = agora + regra.conjuracao;
      estado.conjurandoEm = [...estado.pos];
      transmitir(sala, {
        tipo: "disjuntor", de: estado.id, p: estado.pos, duracaoMs: regra.conjuracao,
      });
      setTimeout(() => {
        if (!sala.jogadores.has(estado.id)) return;
        if (!estado.conjurandoAte) return;   // cancelado por ter se mexido
        estado.conjurandoAte = 0;
        transmitir(sala, { tipo: "escuro", ateMs: 0 });
        transmitir(sala, { tipo: "disjuntor-pronto", de: estado.id });
      }, regra.conjuracao);
      return true;
    }

    if (msg.qual === "po") {
      const alvo = ponto(msg.p);
      if (!alvo || distancia(alvo, estado.pos) > regra.alcance) return false;
      sala.nuvens = sala.nuvens ?? [];
      sala.nuvens.push({ p: alvo, raio: regra.raio, ate: agora + PO_MS });
      transmitir(sala, { tipo: "po", p: alvo, raio: regra.raio, duracaoMs: PO_MS });
      return true;
    }

    return true;
  }

  /**
   * Pegadas: onde uma lagartixa PASSOU, para quem caça.
   *
   * Duas coisas alimentam o mesmo canal, porque as duas são a mesma ideia --
   * o rastro que alguém deixa ao andar. O pó revela quem atravessa a nuvem; a
   * tinta, quem levou um tiro e sobreviveu. Nos dois casos a marca só nasce se
   * a lagartixa se MEXER: quem congela não deixa rastro, e continua valendo a
   * pena parar.
   *
   * Vai só para o lado que caça. Mandar para todos e pedir que o cliente da
   * lagartixa não desenhasse entregaria o próprio rastro a ela, e daria para
   * saber exatamente quando se está sendo seguida.
   */
  function marcarPegadas(sala, agora) {
    if (sala.nuvens?.length) {
      sala.nuvens = sala.nuvens.filter((n) => n.ate > agora);
    }
    const temNuvem = Boolean(sala.nuvens?.length);

    const marcas = [];
    for (const bicho of sala.jogadores.values()) {
      if (bicho.perfil?.papel !== "lagartixa" || bicho.eliminado) continue;
      if (!bicho.ultimoEstadoEm) continue;

      const pingando = (bicho.pingandoAte ?? 0) > agora;
      if (!pingando && !temNuvem) continue;
      if (agora - (bicho.ultimaMarcaEm ?? 0) < MARCA_INTERVALO_MS) continue;

      // Só marca quem ANDOU. A primeira leitura serve de referência e não
      // deixa pegada, senão bastava entrar na nuvem para ser desenhada.
      const de = bicho.posDaMarca;
      bicho.posDaMarca = [...bicho.pos];
      if (!de || distancia(bicho.pos, de) < MARCA_PASSO) continue;

      const naNuvem = temNuvem
        && sala.nuvens.some((n) => distancia(bicho.pos, n.p) <= n.raio);
      if (!naNuvem && !pingando) continue;

      bicho.ultimaMarcaEm = agora;
      marcas.push({ p: bicho.pos, t: pingando ? "tinta" : "po" });
    }
    if (!marcas.length) return;

    for (const j of sala.jogadores.values()) {
      if (j.ws.readyState !== j.ws.OPEN) continue;
      // Lagartixa viva não vê rastro nenhum -- nem o das outras.
      if (j.perfil?.papel === "lagartixa" && !j.eliminado) continue;
      enviar(j.ws, { tipo: "marcas", lista: marcas });
    }
  }

  /** Prende alguém, guardando o começo e o total para o debate ter piso. */
  function prender(quem, agora, duracaoMs) {
    quem.presoDesde = agora;
    quem.presoTotal = duracaoMs;
    quem.presoAte = agora + duracaoMs;
    enviar(quem.ws, { tipo: "preso", restaMs: duracaoMs, totalMs: duracaoMs });
  }

  /**
   * Armadilhas: apitam de longe e FECHAM de perto.
   *
   * O apito continua sendo o aviso -- ele diz que algo se moveu num raio de
   * seis metros, sem dizer o quê. O fechamento é outra coisa: encostar no
   * aparelho prende, e a armadilha se gasta nisso. É o que faz dela armadilha
   * e não alarme: um aparelho com essa cara, largado no chão, prometia agarrar
   * quem pisasse, e não prometia à toa.
   *
   * Ela é visível para os dois lados desde sempre, e é isso que torna o
   * gatilho curto justo: dá para desviar. Uma armadilha invisível seria sorte.
   */
  function verArmadilhas(sala, agora) {
    const regra = PODERES_CACADOR.armadilha;
    for (const dono of sala.jogadores.values()) {
      if (!dono.sensores?.length) continue;

      for (let i = dono.sensores.length - 1; i >= 0; i--) {
        const posto = dono.sensores[i];
        if (agora < posto.prontoEm) continue;

        // 1) Fechar: alguém encostou. Vale mesmo parada -- ela teve de andar
        // até ali, e uma armadilha que solta quem congela em cima dela seria
        // uma armadilha que não funciona.
        let pegou = null;
        for (const bicho of sala.jogadores.values()) {
          if (bicho.perfil?.papel !== "lagartixa" || bicho.eliminado) continue;
          if (agora < (bicho.presoAte ?? 0)) continue;   // já está presa
          if (distancia(bicho.pos, posto.p) <= regra.gatilho) { pegou = bicho; break; }
        }
        if (pegou) {
          prender(pegou, agora, ARMADILHA_PRESO_MS);
          // Some ao disparar: uma armadilha que fica prendendo para sempre
          // trancaria um corredor inteiro pela rodada toda.
          dono.sensores.splice(i, 1);
          transmitir(sala, {
            tipo: "armadilha-fechou", id: posto.id, p: posto.p,
            alvo: pegou.id, duracaoMs: ARMADILHA_PRESO_MS,
          });
          continue;
        }

        // 2) Apitar: algo se moveu por perto, sem dizer o quê.
        if (agora - posto.ultimoApitoEm < SENSOR_INTERVALO_MS) continue;
        let mexeu = false;
        for (const bicho of sala.jogadores.values()) {
          if (bicho.perfil?.papel !== "lagartixa" || bicho.eliminado) continue;
          if (distancia(bicho.pos, posto.p) > regra.raio) continue;
          // Só o que se MOVE. Um aparelho que apita com quem está parada seria
          // um detector de presença, e acabaria com o esconderijo.
          if (agora - (bicho.ultimoMovimentoEm ?? 0) > 500) continue;
          mexeu = true;
          break;
        }
        if (!mexeu) continue;

        posto.ultimoApitoEm = agora;
        // O apito vai para todos os caçadores, não só para o dono: a armadilha
        // é do time, e avisar só quem largou faria dois caçadores tropeçarem.
        for (const j of sala.jogadores.values()) {
          if (j.ws.readyState !== j.ws.OPEN) continue;
          if (j.perfil?.papel === "lagartixa" && !j.eliminado) continue;
          enviar(j.ws, { tipo: "armadilha-apitou", id: posto.id, p: posto.p });
        }
      }
    }
  }


  function ponto(v) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(numero)) return null;
    if (Math.abs(v[0]) > MUNDO.xz || Math.abs(v[2]) > MUNDO.xz) return null;
    return [v[0], v[1], v[2]];
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

      // O rastro é amostrado ANTES do corte por sala vazia: quem está sozinho
      // também trava e também cai do mapa, e sem histórico o `destravar` não
      // teria para onde voltar. Uma amostra por segundo basta para rebobinar
      // dez; guardar as 15 leituras por segundo do fluxo seria desperdício.
      for (const j of sala.jogadores.values()) {
        // Só depois do primeiro estado de verdade. `pos` nasce em [0,0,0], que
        // é um lugar onde ninguém esteve -- rebobinar para lá jogava o jogador
        // fora do piso, e ele caía de novo.
        if (!j.ultimoEstadoEm) continue;
        const ultimo = j.historico[j.historico.length - 1];
        if (!ultimo || agora - ultimo.t > 1000) {
          j.historico.push({ t: agora, p: [...j.pos] });
          while (j.historico.length && agora - j.historico[0].t > HISTORICO_MS) {
            j.historico.shift();
          }
        }
      }

      if (sala.jogadores.size < 2) continue;

      const todos = [...sala.jogadores.values()].map((j) => ({
        id: j.id,
        papel: j.perfil?.papel,
        p: j.pos,
        y: j.yaw,
        a: j.anim,
        e: j.escondido,
        s: j.escala !== 1 ? j.escala : undefined,
        c: j.cima,
        f: j.frente,
        // Para assistir pelos olhos de um caçador não basta a posição e o giro
        // horizontal: sem a inclinação a câmera olha sempre para o horizonte.
        t: j.pitch,
      }));

      // Filtrar aqui, e não no navegador, é o ponto: mandar a posição e pedir
      // que o cliente não desenhe deixaria a lagartixa visível para qualquer um
      // com o inspetor aberto. O que não é enviado não pode ser trapaceado.
      // O placar só viaja quando muda. Mandá-lo a 15 Hz junto dos estados
      // seria repetir os mesmos números centenas de vezes por rodada.
      if (sala.placarSujo) {
        sala.placarSujo = false;
        transmitir(sala, { tipo: "placar", lista: placarDe(sala) });
      }

      if (sala.fase === "caca") {
        girarBonus(sala, agora);
        girarTamanhos(sala, agora);
        assobiar(sala, agora);
        marcarPegadas(sala, agora);
        verArmadilhas(sala, agora);
      }

      const ocultar = escondeLagartixas(sala);
      const semLagartixas = ocultar
        ? todos.filter((e) => e.papel !== "lagartixa")
        : todos;

      for (const jogador of sala.jogadores.values()) {
        if (jogador.ws.readyState !== jogador.ws.OPEN) continue;
        const lista =
          ocultar && jogador.perfil?.papel !== "lagartixa" ? semLagartixas : todos;
        // A inclinação só vai para quem já está eliminado, que é quem pode
        // assistir. Mandar para todo mundo entregaria a uma lagartixa VIVA se
        // o caçador está olhando para o chão ou para o teto -- informação de
        // sobra para quem está escondida embaixo de um móvel.
        const espectador = jogador.eliminado === true;
        jogador.ws.send(
          JSON.stringify({
            tipo: "estados",
            lista: lista.map(({ papel, t, ...resto }) =>
              espectador ? { ...resto, t } : resto,
            ),
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
