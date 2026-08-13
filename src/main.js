import * as THREE from "three";
import "./style.css";
import { criarPalco, enquadrar } from "./scene.js";
import { carregarEscritorio, carregarPersonagem } from "./carregarModelo.js";
import {
  construirColisor,
  construirCobertura,
  construirTampa,
  encontrarNascimento,
} from "./colisor.js";
import { Jogador, criarEntrada } from "./jogador.js";
import { CameraTerceiraPessoa } from "./cameraTerceiraPessoa.js";
import { Npc, PERSONA, encontrarPontoParaNpc } from "./npc.js";
import { Chat } from "./chat.js";
import { Lobby } from "./lobby.js";
import { Rede, LIMITE_TEXTURA } from "./rede.js";
import { JogadoresRemotos } from "./jogadoresRemotos.js";
import { Balao } from "./etiquetas.js";
import { MidiaLocal, disponivel, podeCompartilharTela } from "./midia.js";
import { MalhaWebRTC } from "./webrtc.js";
import { PainelChat } from "./painelChat.js";
import { TilesVideo } from "./tilesVideo.js";
import { montarIcones, trocarIcone } from "./icones.js";
import { GradeDeNavegacao } from "./navegacao.js";
import { MarcadorDeDestino } from "./marcador.js";
import { Assentos } from "./assentos.js";
import { Combate } from "./combate.js";
import { Explosoes } from "./explosao.js";
import { Assobios } from "./assobio.js";
import { CameraLivre } from "./cameraLivre.js";
import { Interruptores } from "./interruptores.js";
import { CaudasSoltas, CuspeNaTela, Escuridao, Faro, PedrasJogadas } from "./poderes.js";
import { Batidas, Lanterna, Nuvens, Pegadas, Redes, Sensores } from "./poderesCacador.js";
import { isolarMateriais } from "./pinturaLagartixa.js";
import { ARTE, ARTE_CACADOR, ARTE_POSES, ARTE_ACOES } from "./artePoderes.js";
import {
  PoderesDaLagartixa,
  PALETA,
  CORPO as CORPO_LAGARTIXA,
  pintarRemoto,
  corDoChao,
  corNoToque,
  POSES,
  CAMERAS,
} from "./lagartixa.js";

montarIcones();


const palco = criarPalco(document.getElementById("palco"));
const { renderer, scene, camera, controls } = palco;

const el = (id) => document.getElementById(id);
const elCarregando = el("carregando");
const elErro = el("erro");

/**
 * A capa sai no START.
 *
 * Registrado aqui em cima, na avaliação do módulo, e não junto com o resto da
 * interface: a capa aparece ANTES de o cenário terminar de carregar, e o botão
 * precisa responder desde o primeiro instante. Quem apertar cedo demais cai na
 * tela de carregamento -- que é justamente o que a capa estava cobrindo.
 */
el("btn-start").addEventListener("click", () => {
  const capa = el("capa");
  capa.classList.add("saindo");
  capa.addEventListener("transitionend", () => (capa.hidden = true), { once: true });
});
const elHud = el("hud");
const elDica = el("dica");

// ------------------------------------------------------------- overlays

function mostrarProgresso(fracao) {
  const barra = elCarregando.querySelector(".preenchimento");
  const pct = elCarregando.querySelector(".percentual");
  if (fracao === null) {
    pct.textContent = "baixando…";
    return;
  }
  barra.style.width = `${Math.round(fracao * 100)}%`;
  pct.textContent = `${Math.round(fracao * 100)}%`;
}

function mostrarEtapa(texto) {
  elCarregando.querySelector(".titulo").textContent = texto;
}

function mostrarErro(mensagem) {
  elCarregando.hidden = true;
  elErro.hidden = false;
  elErro.querySelector(".detalhe").textContent = mensagem;
}

function esconderCarregando() {
  elCarregando.classList.add("saindo");
  elCarregando.addEventListener(
    "transitionend",
    () => {
      elCarregando.hidden = true;
    },
    { once: true },
  );
}

// ----------------------------------------------------------------- teto

function criarAlternadorDeTeto(escritorio, { hemisferio }) {
  const cobertura = ["Roof", "Ceiling"]
    .map((nome) => escritorio.getObjectByName(nome))
    .filter(Boolean);

  const luzFechado = hemisferio.intensity;
  const botao = el("alternar-teto");
  let aberto = false;

  return function alternar(forcar) {
    aberto = forcar === undefined ? !aberto : forcar;
    for (const parte of cobertura) parte.visible = !aberto;
    hemisferio.intensity = aberto ? luzFechado * 2.1 : luzFechado;
    botao.setAttribute("aria-pressed", String(aberto));
    botao.textContent = aberto ? "Ver por fora" : "Ver interior";
    return aberto;
  };
}

// ------------------------------------------------------------------ hud

const hudCampos = Object.fromEntries(
  [...elHud.querySelectorAll("[data-campo]")].map((e) => [e.dataset.campo, e]),
);
let quadros = 0;
let ultimaAmostra = performance.now();

function atualizarHud(agora) {
  quadros += 1;
  const decorrido = agora - ultimaAmostra;
  if (decorrido < 500) return;
  hudCampos.fps.textContent = `${Math.round((quadros * 1000) / decorrido)} fps`;
  hudCampos.draws.textContent = `${renderer.info.render.calls} draws`;
  hudCampos.tris.textContent = `${renderer.info.render.triangles.toLocaleString("pt-BR")} tris`;
  quadros = 0;
  ultimaAmostra = agora;
}

// ------------------------------------------------------------- estado

const relogio = new THREE.Clock();
const lerEntrada = criarEntrada();
const _alvo = new THREE.Vector3();
const _alvoNpc = new THREE.Vector3();

const PARADO = {
  frente: false, tras: false, esquerda: false, direita: false,
  correndo: false, pular: false,
};

let escritorio = null;
const coberturas = [];   // teto do pacote + tampa gerada
let caudas = null;
let cuspeNaTela = null;
/** Poderes de quem caça. Só nascem para quem caça. */
let lanterna = null;
let batidas = null;
let sensores = null;
let pegadas = null;
let nuvens = null;
let redesVoando = null;
/** Presa pela rede: o servidor decide, isto só congela a entrada e avisa. */
let presoPelaRedeAte = 0;
/** Conjurando o disjuntor: some se andar. */
let conjurandoAte = 0;
let escuridao = null;
let faro = null;
let pedras = null;
let interruptores = null;
/** Poder armado esperando um clique no mundo (hoje só o assobio falso). */
let poderMirando = null;
let colisor = null;
let nascimento = null;
let jogador = null;
let cameraJogo = null;
let npc = null;
let chat = null;
let balaoProprio = null;
let alternarTeto = null;
let raioCena = 40;

const rede = new Rede();
let remotos = null;
const naSala = new Map();

const midia = new MidiaLocal();
let malha = null;
let painelChat = null;
let tiles = null;
let grade = null;
let marcador = null;
const assentos = new Assentos();
let assentoPerto = null;
let combate = null;
let explosoes = null;
let poderes = null;      // só existe quando se joga de lagartixa
let assobios = null;
let faseAtual = "espera";
let faseAte = 0;
let anfitriao = null;
let podeIniciar = false;
let cameraLivre = null;
/** Fora da rodada, assistindo. Só acontece com lagartixa encontrada. */
let espectando = false;
let modoEspectador = "livre";   // "livre" | "cacador"
/** Lagartixa VIVA olhando de fora do corpo. null | "livre" | id de uma amiga. */
let olhando = null;
const RAIO_COLEIRA = 14;        // metros de corda para a câmera livre viva
let cacadorAssistido = null;
const caidas = [];              // {id, nome, por}
let souLagartixa = false;
let primeiraPessoa = false;
let abatido = false;
const _alvoTiro = new THREE.Vector3();

let andando = false;
let conversando = false;
let digitando = false;

// ------------------------------------------------------------ carga

async function carregar() {
  escritorio = await carregarEscritorio(renderer, mostrarProgresso);
  scene.add(escritorio);

  const { raio } = enquadrar(palco, escritorio);
  raioCena = raio;
  scene.fog.near = raio * 1.4;
  scene.fog.far = raio * 5;

  alternarTeto = criarAlternadorDeTeto(escritorio, palco);
  el("alternar-teto").addEventListener("click", () => {
    if (!andando) alternarTeto();
  });
  addEventListener("keydown", (e) => {
    if (!andando && !digitando && (e.key === "t" || e.key === "T")) alternarTeto();
  });

  mostrarEtapa("Calculando a colisão");
  await new Promise((r) => setTimeout(r, 0));
  colisor = construirColisor(escritorio);
  // Depois do principal, e nunca fundido a ele: veja `construirCobertura`.
  const teto = construirCobertura(escritorio);
  if (teto) coberturas.push(teto);
  scene.add(colisor);
  nascimento = encontrarNascimento(colisor);

  mostrarEtapa("Mapeando o caminhável");
  await new Promise((r) => setTimeout(r, 0));
  grade = new GradeDeNavegacao(colisor);
  console.info("[navegação]", grade.construir());
  // A tampa depende da grade, então nasce aqui. Altura entre o forro do pacote
  // (6.1) e o topo das paredes (6.85): fecha os vãos sem passar na frente do
  // teto de verdade nem deixar o topo das paredes ao alcance.
  // Os interruptores dependem da grade (para saber onde há piso) e do colisor
  // (para achar a parede). Nascem aqui, junto com a tampa, pelo mesmo motivo.
  interruptores = new Interruptores(scene, colisor, grade);
  console.info("[interruptores]", interruptores.pontos.length, "encontrados");

  const tampa = construirTampa(grade, { altura: 6.5 });
  if (tampa) coberturas.push(tampa);
  console.info("[teto]", coberturas.map((c) => c.name).join(" + "));
  console.info("[assentos]", await assentos.carregar(), "lugares");

  cameraJogo = new CameraTerceiraPessoa(camera, renderer.domElement, colisor);
  // A câmera só é barrada pelo teto DE VERDADE, nunca pela tampa gerada.
  //
  // A tampa é uma laje invisível a 6,5 m, feita para impedir que alguém suba
  // no topo das paredes. Deixá-la empurrar a câmera fazia o braço encolher
  // contra o nada -- a lente saltava sem que houvesse nada na tela para
  // explicar o salto, que é a pior forma de colisão de câmera.
  cameraJogo.coberturas = coberturas.filter((c) => c.name !== "tampa");
  // O viewmodel é filho da câmera; sem a câmera na cena ele não é renderizado.
  scene.add(camera);
  marcador = new MarcadorDeDestino(scene);
  explosoes = new Explosoes(scene);
  combate = new Combate(scene, camera, colisor, renderer.domElement);
  await combate.carregarArma().catch((e) =>
    console.warn("[combate] arma não carregou:", e.message),
  );
  remotos = new JogadoresRemotos(scene, renderer);
  assobios = new Assobios(camera);
  cameraLivre = new CameraLivre(camera, renderer.domElement);
  caudas = new CaudasSoltas(scene, criarClone);
  cuspeNaTela = new CuspeNaTela(el("cuspe-tela"));
  // As pegadas e a nuvem existem dos dois lados: a lagartixa precisa VER onde
  // o pó assentou para poder desviar (as marcas em si o servidor só manda a
  // quem caça). O resto é só de quem caça.
  pegadas = new Pegadas(scene);
  nuvens = new Nuvens(scene);
  batidas = new Batidas(scene);
  redesVoando = new Redes(scene);
  sensores = new Sensores(scene);
  escuridao = new Escuridao({ ...palco, scene });
  faro = new Faro(scene);
  pedras = new PedrasJogadas(scene);
  remotos.aoCriar = (remoto) => {
    if (remoto.papel !== "lagartixa") return;
    // A voz mora no avatar: é isso que faz o assobio vir da direção certa.
    assobios.registrar(remoto.id, remoto.raiz);
    // Um avatar que carregou durante o preparo já nasce escondido do caçador.
    if (remoto.eliminado ||
        ((faseAtual === "preparo" || faseAtual === "espera") && !souLagartixa)) {
      remoto.raiz.visible = false;
    }
  };
  remotos.aoRemover = (id) => assobios.remover(id);

  mostrarEtapa("Posicionando o NPC");
  // A Renata usa o mesmo GLB que o jogador pode escolher no lobby, em vez de
  // uma cópia própria: eram arquivos byte a byte idênticos, 1.5 MB baixados
  // duas vezes.
  const npcGltf = await carregarPersonagem(
    renderer,
    "/models/personagens/Developer_Female_01.glb",
  );
  npc = new Npc(npcGltf.modelo, npcGltf.clipes, "Renata");
  npc.posicionar(encontrarPontoParaNpc(colisor, nascimento));
  npc.encarar(nascimento, 1);
  npc.raiz.visible = false;
  scene.add(npc.raiz);

  chat = new Chat({ persona: PERSONA, nome: npc.nome });
  chat.aoFechar = () => encerrarConversa();

  painelChat = new PainelChat();
  tiles = new TilesVideo();

  configurarInteracao();
  configurarFala();
  configurarModo();
  configurarRede();
  configurarMidia();
  configurarAssentos();

  esconderCarregando();
  elHud.hidden = false;
  el("lobby").hidden = false;
  lobby.mostrar();
  requestAnimationFrame(animar);
}

// ------------------------------------------------------------- lobby

const lobby = new Lobby();

lobby.aoConfirmar = async (pedido) => {
  const bemvindo = await rede.conectar(pedido);

  // A malha PRECISA existir antes de qualquer await daqui para baixo.
  //
  // No instante em que o servidor confirma nossa entrada, ele avisa os outros,
  // e quem for o iniciador cria a oferta na hora. Se ainda estivéssemos
  // baixando o GLB do personagem (1.5 MB), esse sinal chegaria com `malha`
  // nula, seria descartado em silêncio -- e não há retransmissão: a chamada
  // ficaria presa em "new" para sempre.
  naSala.clear();
  naSala.set(bemvindo.eu.id, bemvindo.eu);

  malha = new MalhaWebRTC(bemvindo.eu.id, (para, dados) =>
    rede.enviarSinal(para, dados),
  );
  malha.aoFaixa = (id, canal, faixa) => tiles.definirFaixa(id, canal, faixa);

  for (const outro of bemvindo.jogadores) {
    naSala.set(outro.id, outro);
    tiles.garantir(outro);
    tiles.aplicarMidia(outro.id, outro.midia);
    malha.conectar(outro.id);
  }

  painelChat.carregarHistorico(bemvindo.historico ?? [], rede.meuId);

  mostrarEtapa("Carregando seu personagem");
  elCarregando.hidden = false;
  elCarregando.classList.remove("saindo");

  souLagartixa = pedido.perfil.papel === "lagartixa";
  // A fase vem no "bemvindo": entrar no meio de uma caçada e só descobrir isso
  // na virada seguinte deixaria até cinco minutos sem cronômetro na tela.
  faseAtual = bemvindo.fase ?? "espera";
  faseAte = performance.now() + (bemvindo.restaMs ?? 0);
  anfitriao = bemvindo.anfitriao ?? null;
  podeIniciar = Boolean(bemvindo.podeIniciar);

  const { modelo, clipes } = await carregarPersonagem(
    renderer,
    souLagartixa
      ? "/models/lagartixa.glb"
      : `/models/personagens/${pedido.perfil.personagem}.glb`,
  );

  jogador = new Jogador(
    modelo, clipes, colisor,
    {
      ...(souLagartixa ? CORPO_LAGARTIXA : {}),
      coberturas,
      // Só a lagartixa escala. Uma pessoa subindo pela parede acabaria com a
      // graça de fechar o telhado.
      escalar: souLagartixa,
    },
  );

  if (souLagartixa) {
    cameraJogo.distancia = CORPO_LAGARTIXA.distanciaCamera;
    poderes = new PoderesDaLagartixa(jogador);
  } else {
    // Primeira pessoa: a arma fica colada na câmera, não na mão. O corpo é
    // escondido logo abaixo, então a arma na mão não seria vista mesmo.
    combate.equiparNaCamera();
  }
  primeiraPessoa = !souLagartixa;
  cameraJogo.primeiraPessoa = primeiraPessoa;
  jogador.nascerEm(nascimento);
  scene.add(jogador.raiz);
  balaoProprio = new Balao(jogador.raiz);
  configurarCliqueParaAndar();
  configurarCombate();

  // Os avatares 3D dependem do colisor e da cena montada, então vêm agora --
  // ao contrário da malha, eles aguentam esperar.
  for (const outro of bemvindo.jogadores) remotos.adicionar(outro);

  lobby.esconder();
  esconderCarregando();
  mostrarSala(bemvindo);
  document.getElementById("barra-midia").hidden = false;
  entrarNoModoAndar();
};

function mostrarSala(bemvindo) {
  el("sala-codigo").textContent = bemvindo.codigo;
  el("painel-sala").hidden = false;
  // A régua já pode aparecer na órbita, se a pessoa tiver pedido; até aqui
  // ficava escondida porque nem sala havia.
  dicaPermitida = true;
  atualizarDica();
  atualizarListaDaSala();

  const botaoConvite = el("copiar-convite");
  botaoConvite.addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}?sala=${bemvindo.codigo}`;
    const rotulo = botaoConvite.querySelector("span");
    try {
      await navigator.clipboard.writeText(link);
      trocarIcone(botaoConvite.querySelector("i"), "ok", 13);
      rotulo.textContent = "Copiado";
      botaoConvite.classList.add("feito");
    } catch {
      // A área de transferência exige contexto seguro; em http:// mostramos o
      // link para a pessoa copiar à mão em vez de falhar calado.
      rotulo.textContent = link;
    }
    setTimeout(() => {
      trocarIcone(botaoConvite.querySelector("i"), "copiar", 13);
      rotulo.textContent = "Convite";
      botaoConvite.classList.remove("feito");
    }, 2400);
  });
}

function atualizarListaDaSala() {
  const lista = el("sala-jogadores");
  el("sala-total").textContent = String(naSala.size);
  lista.replaceChildren();
  for (const jog of naSala.values()) {
    const item = document.createElement("li");
    item.style.setProperty("--c", jog.cor);
    item.textContent = jog.id === rede.meuId ? `${jog.nome} (você)` : jog.nome;
    // Lagartixa clica em lagartixa para ver onde a amiga está. Em caçador,
    // não: o servidor nem manda a inclinação da cabeça dele para quem está
    // viva, e uma câmera em cima de quem procura acabaria com a caçada.
    if (jog.papel === "lagartixa" && jog.id !== rede.meuId && podeOlhar()) {
      item.classList.add("clicavel");
      item.title = "ver onde ela está";
      item.addEventListener("click", () => {
        entrarNoOlhar(jog.id);
        fecharConfig();
      });
    }
    lista.append(item);
  }
}

// -------------------------------------------------------------- rede

function configurarRede() {
  rede.aoJogadorEntrar = (jog) => {
    naSala.set(jog.id, jog);
    remotos.adicionar(jog);
    tiles.garantir(jog);
    tiles.aplicarMidia(jog.id, jog.midia);
    malha?.conectar(jog.id);
    painelChat.avisoDoSistema(`${jog.nome} entrou`);
    atualizarListaDaSala();
  };

  rede.aoJogadorSair = (id) => {
    const quem = naSala.get(id);
    naSala.delete(id);
    remotos.remover(id);
    tiles.remover(id);
    malha?.desconectar(id);
    if (quem) painelChat.avisoDoSistema(`${quem.nome} saiu`);
    atualizarListaDaSala();
  };

  rede.aoEstados = (lista) => remotos.receberEstados(lista, rede.meuId);

  // O balão sobre a cabeça e o painel lateral recebem a mesma mensagem: um diz
  // quem falou no espaço, o outro guarda o que foi dito.
  rede.aoFala = (msg) => {
    if (msg.id === rede.meuId) balaoProprio?.dizer(msg.texto);
    else remotos.falar(msg.id, msg.texto);
    painelChat.adicionar(msg, rede.meuId);
  };

  rede.aoSinal = (de, dados) => {
    if (!malha) {
      // Não deve acontecer -- a malha é criada antes de qualquer espera após
      // a entrada na sala. Se aparecer, é um sinal perdido e uma chamada que
      // nunca conecta; melhor gritar do que sumir.
      console.error("[rede] sinal de", de, "chegou antes da malha existir");
      return;
    }
    malha.receberSinal(de, dados);
  };

  rede.aoMidia = (id, estado) => {
    const jog = naSala.get(id);
    if (jog) jog.midia = estado;
    tiles.aplicarMidia(id, estado);
  };

  rede.aoPintar = (id, cor) => {
    const perfil = naSala.get(id);
    if (perfil) perfil.pintura = cor;
    const remoto = remotos.mapa.get(id);
    if (!remoto) return;
    // Cor chapada substitui a pintura à mão, então o atlas precisa sair antes
    // -- a cor do material MULTIPLICA a textura, e com ela no lugar o desenho
    // antigo continuaria aparecendo, só que tingido.
    remoto.limparTextura();
    pintarRemoto(remoto.raiz, cor, remoto.escondido);
  };

  rede.aoTextura = (id, dados) => {
    remotos.mapa.get(id)?.pintarTextura(dados);
  };

  rede.aoReposicionar = ({ p }) => {
    if (!jogador) return;
    jogador.posicao.set(p[0], p[1], p[2]);
    jogador.velocidade.set(0, 0, 0);
    jogador.cancelarCaminho();
    preso = false;
    el("destravar").hidden = true;
    recado("Voltou para onde estava.");
  };

  rede.aoRecado = (texto) => recado(texto);

  rede.aoAssobio = (msg) => {
    if (!msg.p) return assobios?.tocar(msg.id);

    const onde = new THREE.Vector3(...msg.p);
    // Assobio falso ganha a pedra: sai de quem jogou, voa em arco e só faz
    // barulho ao bater. Sem o objeto, o som nascia do nada e não havia como
    // ligar o efeito à causa.
    const meu = msg.de === rede.meuId;
    const dono = meu ? jogador?.posicao : remotos.mapa.get(msg.de)?.raiz.position;
    if (msg.falso && dono) {
      pedras.jogar(
        dono.clone().setY(dono.y + 0.15),
        onde,
        (ponto) => assobios?.tocarEm(scene, ponto, meu),
      );
      return;
    }
    assobios?.tocarEm(scene, onde);
  };

  rede.aoCauda = ({ id, p, d, duracaoMs }) => {
    const perfil = naSala.get(id);
    caudas.soltar(
      new THREE.Vector3(...p),
      duracaoMs,
      perfil?.pintura,
      d ? new THREE.Vector3(...d) : null,
    );
  };

  rede.aoCuspe = ({ cor, duracaoMs }) => cuspeNaTela.sujar(cor, duracaoMs);

  rede.aoCuspeVisto = ({ de, alvo, cor }) => {
    // Todo mundo vê o jato: é o que torna o cuspe um risco para quem cospe.
    const origem = de === rede.meuId ? jogador?.posicao : remotos.mapa.get(de)?.raiz.position;
    const fim = alvo === rede.meuId ? jogador?.posicao : remotos.mapa.get(alvo)?.raiz.position;
    if (origem && fim) {
      // Na CARA, não no peito. A 1,2 m o jato batia na altura do crachá, e de
      // longe lia como tiro no tronco -- mas quem toma fica cego, então o
      // efeito precisa combinar com a causa. `ALTURA_OLHOS_CACADOR` é a mesma
      // altura que a câmera de primeira pessoa usa: é onde ficam os olhos.
      const cara = fim.clone().setY(fim.y + ALTURA_OLHOS_CACADOR);
      combate.dispararProjetil(origem.clone().setY(origem.y + 0.2), cara);
      explosoes.estourar(cara, cor, 0.75);
    }
  };

  rede.aoEscuro = ({ ateMs }) => {
    escuridao.acionar(ateMs);
    // Luz de volta: a lanterna para de gastar e volta a carregar sozinha.
    if (ateMs === 0) recado("As luzes voltaram.");
  };

  // ---- poderes de quem caça

  rede.aoBatida = ({ p, de }) => {
    const onde = new THREE.Vector3(...p);
    batidas?.estourar(onde, ALCANCE_BATIDA);
    // O estrondo usa o mesmo sintetizador do assobio, posicionado no ponto:
    // é o que faz a batida custar a posição de quem bateu.
    assobios?.tocarEm(scene, onde, de === rede.meuId);
  };

  rede.aoBatidaSentida = () => {
    // Só a lagartixa varrida recebe isto. Ela precisa saber que perdeu o
    // silêncio -- senão o próximo assobio pareceria azar, e não consequência.
    recado("Bateram na parede — seu silêncio foi por água abaixo.");
  };

  rede.aoSensor = ({ id, p, dono }) => {
    sensores?.largar(id, new THREE.Vector3(...p), dono === rede.meuId);
  };
  rede.aoSensorFora = ({ id }) => sensores?.recolher(id);
  rede.aoSensorApitou = ({ id, p }) => {
    sensores?.apitar(id);
    if (p) assobios?.tocarEm(scene, new THREE.Vector3(...p), true);
    recado("Um sensor apitou.");
  };

  rede.aoRede = ({ de, alvo, duracaoMs }) => {
    const origem = de === rede.meuId ? jogador?.posicao : remotos.mapa.get(de)?.raiz.position;
    const preso = remotos.mapa.get(alvo);
    const fim = alvo === rede.meuId ? jogador?.posicao : preso?.raiz.position;
    if (origem && fim) {
      // A malha SEGUE o corpo enquanto prende: parada no ar, ela ficaria ao
      // lado da lagartixa em vez de em cima dela assim que o chão a empurrasse
      // um palmo. E o alvo pode sair da sala no meio -- daí ela fica onde caiu.
      const seguir = alvo === rede.meuId
        ? () => jogador?.posicao ?? null
        : () => remotos.mapa.get(alvo)?.raiz.position ?? null;
      redesVoando?.lancar(
        origem.clone().setY(origem.y + 1.3),
        fim.clone().setY(fim.y + 0.2),
        seguir,
        duracaoMs,
      );
    }
    if (alvo === rede.meuId) {
      presoPelaRedeAte = performance.now() + duracaoMs;
      recado("Presa na rede!");
    }
  };

  rede.aoPo = ({ p, raio, duracaoMs }) => nuvens?.soltar(p, raio, duracaoMs);

  rede.aoMarcas = ({ lista }) => {
    for (const marca of lista) pegadas?.pisar(marca.p, marca.t);
  };

  rede.aoPingando = () => {
    recado("Você está pingando tinta — parar de andar apaga o rastro.");
  };

  rede.aoDisjuntor = ({ de, p, duracaoMs }) => {
    if (de === rede.meuId) return;
    // A conjuração é barulhenta de propósito: é o que dá à lagartixa a chance
    // de decidir se corre ou se aproveita para se mexer no escuro que resta.
    if (p) assobios?.tocarEm(scene, new THREE.Vector3(...p));
    if (souLagartixa) recado("Alguém está mexendo no disjuntor.");
  };

  rede.aoDisjuntorPronto = () => { conjurandoAte = 0; };
  rede.aoDisjuntorCancelado = ({ de }) => {
    conjurandoAte = 0;
    if (de === rede.meuId) recado("Você se mexeu — o disjuntor não religou.");
  };

  rede.aoLimparCampo = () => {
    sensores?.limpar();
    pegadas?.limpar();
    nuvens?.limpar();
    batidas?.limpar();
    redesVoando?.limpar();
    presoPelaRedeAte = 0;
    conjurandoAte = 0;
  };

  rede.aoEliminado = ({ id, nome, por }) => {
    if (!caidas.some((c) => c.id === id)) caidas.push({ id, nome, por });
    const perfil = naSala.get(id);
    if (perfil) perfil.eliminado = true;
    mostrarCaidas();

    const remoto = remotos.mapa.get(id);
    if (remoto) {
      remoto.eliminado = true;
      remoto.raiz.visible = false;
    }
    painelChat?.avisoDoSistema(
      por ? `${nome} foi encontrada por ${por}` : `${nome} foi encontrada`,
    );
    if (id === rede.meuId) entrarEmEspectador();
  };

  rede.aoFase = (msg) => {
    faseAtual = msg.fase;
    faseAte = performance.now() + (msg.restaMs ?? 0);
    if (msg.anfitriao !== undefined) anfitriao = msg.anfitriao;
    if (msg.podeIniciar !== undefined) podeIniciar = msg.podeIniciar;
    aplicarFase();
  };

  rede.aoSala = ({ anfitriao: dono, podeIniciar: pronto }) => {
    anfitriao = dono;
    podeIniciar = pronto;
    aplicarFase();
  };

  rede.aoDisparo = ({ o, f }) => {
    // `dispararProjetil`, não um rastro solto: o tiro do outro jogador tem que
    // ter o mesmo dardo e o mesmo clarão que o nosso, senão só quem atira vê
    // de onde veio. O clarão sai na origem, que é a boca da arma dele.
    combate.dispararProjetil(
      new THREE.Vector3(o[0], o[1], o[2]),
      new THREE.Vector3(f[0], f[1], f[2]),
    );
  };

  rede.aoDano = ({ alvo, vida }) => {
    const perfil = naSala.get(alvo);
    if (perfil) perfil.vida = vida;

    // Todo mundo vê o estouro, não só quem levou: é o retorno de quem acertou.
    const remoto = remotos.mapa.get(alvo);
    const onde = remoto ? remoto.raiz.position : jogador?.posicao;
    if (onde) {
      // Lagartixa estoura na cor com que está pintada; pessoa, na cor dela.
      const cor = perfil?.papel === "lagartixa"
        ? (perfil.pintura ?? "#5f9e4a")
        : (perfil?.cor ?? "#ffd166");
      // A escala sai do tamanho de quem levou: a lagartixa tem 10 cm de
      // corpo, a pessoa tem 1,8 m. Abate estoura o dobro do impacto normal.
      const porte = perfil?.papel === "lagartixa" ? 0.4 : 1;
      explosoes.estourar(onde, cor, porte * (vida === 0 ? 2.2 : 1));
      if (vida === 0 && remoto) remoto.raiz.visible = false;
    }

    if (alvo !== rede.meuId) return;

    combate.vida = vida;
    if (!souLagartixa) pintarVida();
    piscarDano();

    if (vida === 0) {
      // A lagartixa não "volta em instantes": a mensagem de eliminação chega
      // logo atrás e abre o modo espectador. Mostrar o cartaz de abatido aqui
      // deixaria uma promessa falsa piscando na tela.
      if (!souLagartixa) {
        abatido = true;
        el("abatido").hidden = false;
      }
      jogador?.cancelarCaminho();
      poderes?.esconder(false);
    }
  };

  rede.aoReviver = ({ alvo, vida }) => {
    // `alvo: null` é o revive coletivo do começo de rodada. Sem tratar esse
    // caso, o `alvo !== meuId` abaixo descartava a mensagem para TODO mundo, e
    // a lagartixa eliminada continuava morta na rodada seguinte.
    const todos = alvo == null;

    for (const [id, perfil] of naSala) {
      if (!todos && id !== alvo) continue;
      perfil.vida = vida;
      perfil.eliminado = false;
    }
    for (const [id, remoto] of remotos.mapa) {
      if (!remoto || (!todos && id !== alvo)) continue;
      remoto.eliminado = false;
      remoto.raiz.visible = true;
    }
    if (!todos && alvo !== rede.meuId) return;

    abatido = false;
    combate.vida = vida;
    if (!souLagartixa) pintarVida();
    el("abatido").hidden = true;
    // Volta ao ponto de nascimento: reaparecer onde levou o tiro seria
    // aparecer na mira de quem atirou.
    jogador?.nascerEm(nascimento);
  };

  rede.aoDesconectar = () => {
    remotos.limpar();
    tiles.limpar();
    malha?.fecharTudo();
    midia.desligarTudo();
    naSala.clear();
    mostrarErro(
      "A conexão com a sala caiu. Recarregue a página para entrar de novo.",
    );
  };

  rede.aoErro = (mensagem) => console.warn("[rede]", mensagem);
}

// ------------------------------------------------------- falar no jogo

function configurarFala() {
  const form = el("falar");
  const campo = form.querySelector("input");

  addEventListener("keydown", (evento) => {
    if (!andando || conversando || digitando || painelChat?.digitando) return;
    if (evento.code !== "KeyY" || evento.repeat) return;
    evento.preventDefault();
    digitando = true;
    form.hidden = false;
    campo.focus();
  });

  function fechar() {
    digitando = false;
    form.hidden = true;
    campo.value = "";
    campo.blur();
  }

  form.addEventListener("submit", (evento) => {
    evento.preventDefault();
    const texto = campo.value.trim();
    if (texto) rede.falar(texto);
    fechar();
  });

  // As teclas de movimento não podem vazar para o jogo enquanto se digita.
  for (const tipo of ["keydown", "keyup", "keypress"]) {
    form.addEventListener(tipo, (evento) => {
      if (evento.key === "Escape") {
        fechar();
        return;
      }
      evento.stopPropagation();
    });
  }
}

// ------------------------------------------------------------- mídia

function avisoDeMidia(texto) {
  const aviso = el("aviso-midia");
  aviso.textContent = texto;
  aviso.hidden = !texto;
  if (texto) setTimeout(() => (aviso.hidden = true), 7000);
}

/**
 * Trava da mídia.
 *
 * Microfone, câmera e tela estão desligados no jogo. Esconder os botões não
 * bastava: um engano meu (dois elementos com o mesmo `id`) reexibiu o botão de
 * webcam, e clicar nele pedia permissão de câmera ao navegador -- que é a
 * última coisa que um jogo deveria fazer sem motivo.
 *
 * Com a trava, nem o clique chega a `getUserMedia`. Para reativar a chamada de
 * vídeo, é este `false` que vira `true` (mais o `hidden` dos botões no HTML e a
 * regra de `#tiles` no CSS).
 */
const MIDIA_LIGADA = false;

function configurarMidia() {
  if (!MIDIA_LIGADA) return;

  const botoes = {
    microfone: el("btn-microfone"),
    camera: el("btn-enquadramento"),
    tela: el("btn-tela"),
  };

  // Sem contexto seguro, getUserMedia nem existe. Melhor desabilitar e dizer
  // o porquê do que deixar o clique falhar com um erro críptico.
  if (!disponivel()) {
    for (const b of Object.values(botoes)) {
      b.disabled = true;
      b.title = "Requer HTTPS (ou localhost)";
    }
  } else if (!podeCompartilharTela()) {
    botoes.tela.disabled = true;
    botoes.tela.title = "Este navegador não permite compartilhar tela";
  }

  // Ligar ou desligar qualquer canal significa duas coisas: trocar a faixa em
  // todos os pares e avisar a sala, para os ícones dos outros ficarem certos.
  midia.aoMudar = (canal, faixa) => {
    malha?.definirFaixa(canal, faixa);
    botoes[canal].setAttribute("aria-pressed", String(Boolean(faixa)));
    // O ícone muda junto com o estado: microfone cortado quando desligado é
    // mais direto de ler do que só a mudança de cor da borda.
    const ligado = Boolean(faixa);
    const nomes = {
      microfone: ligado ? "mic" : "mic-off",
      camera: ligado ? "camera" : "camera-off",
      tela: ligado ? "monitor-off" : "compartilhar-tela",
    };
    trocarIcone(botoes[canal].querySelector(".icone"), nomes[canal], 17);
    rede.enviarMidia(midia.estado);

    // O próprio tile passa pelo mesmo caminho dos remotos: guarda a faixa e
    // deixa o estado decidir o que aparece. Um caminho só, um comportamento só.
    tiles.garantir({ ...naSala.get(rede.meuId), nome: "você" });
    tiles.definirFaixa(rede.meuId, canal, faixa);
    tiles.aplicarMidia(rede.meuId, midia.estado);
  };

  const acoes = {
    microfone: [() => midia.ligarMicrofone(), () => midia.desligarMicrofone()],
    camera: [() => midia.ligarCamera(), () => midia.desligarCamera()],
    tela: [() => midia.ligarTela(), () => midia.desligarTela()],
  };

  for (const [canal, botao] of Object.entries(botoes)) {
    botao.addEventListener("click", async () => {
      const [ligar, desligar] = acoes[canal];
      try {
        if (midia.estado[canal]) desligar();
        else await ligar();
        avisoDeMidia("");
      } catch (erro) {
        avisoDeMidia(erro.message);
      }
    });
  }

  painelChat.aoEnviar = (texto) => rede.falar(texto);
}

// ------------------------------------------------------------ combate

function pintarVida() {
  const pontos = el("vida").querySelector(".pontos");
  pontos.replaceChildren();
  for (let i = 0; i < combate.vidaMaxima; i++) {
    const p = document.createElement("span");
    p.className = "ponto" + (i < combate.vida ? "" : " vazio");
    pontos.append(p);
  }
}

function piscarDano() {
  document.body.classList.add("levou-tiro");
  setTimeout(() => document.body.classList.remove("levou-tiro"), 140);
}

/**
 * Lista de alvos para o hitscan.
 *
 * A lagartixa tem uma esfera menor e mais baixa: usar a caixa de uma pessoa
 * nela seria acertar o ar acima do bicho. Quem está escondido continua
 * acertável -- esconder é ficar difícil de VER, não intangível.
 */
function alvosVisiveis() {
  const lista = [];
  for (const [id, remoto] of remotos.mapa) {
    if (!remoto) continue;
    const perfil = naSala.get(id);
    const bicho = perfil?.papel === "lagartixa";
    lista.push({
      id,
      objeto3d: remoto.raiz,
      raio: bicho ? 0.22 : 0.45,
      centroY: bicho ? 0.12 : 1.0,
    });
  }
  return lista;
}

function configurarCombate() {
  // A lagartixa não atira: a vantagem dela é sumir, não trocar tiros.
  combate.podeAtirar = () =>
    andando && !souLagartixa && !abatido && !conversando && !digitando
    && !painelChat?.digitando && !jogador?.sentado;

  combate.listarAlvos = alvosVisiveis;

  // A câmera interpreta o mouse e avisa; o combate só reage.
  // No ateliê o mouse é pincel e cavalete: o esquerdo pinta, o direito gira em
  // volta do bicho. Nenhum dos dois pode disparar -- levar um tiro do próprio
  // pincel enquanto se escolhe a cor seria absurdo.
  cameraJogo.aoClicar = () => { if (!modoPintura) combate.puxarGatilho(); };
  cameraJogo.aoTocarDireito = () => { if (!modoPintura) combate.puxarGatilho(); };
  cameraJogo.aoMirar = (sim) => combate.definirMira(sim && !modoPintura);
  // Todo disparo é anunciado, mesmo errando: o rastro é o que conta.
  combate.aoAtirar = (boca, fim, alvoId) => rede.atirar(alvoId, boca, fim);
  combate.aoAcertar = () => {};
  combate.ativar();

  // O contexto de áudio nasce suspenso e só o gesto de entrar na sala o
  // libera; daqui em diante os assobios tocam.
  assobios.liberar();
  // O molde da isca e o utilitário de clonagem entram em segundo plano: nada
  // depende deles para começar a jogar.
  import("three/examples/jsm/utils/SkeletonUtils.js")
    .then((m) => { _cloneUtil = m.clone; })
    .catch(() => {});
  prepararClone();
  configurarInicio();
  configurarDestravar();
  configurarCamera();
  configurarEspectador();
  configurarOlhar();
  aplicarFase();
  configurarPaineis();
  if (souLagartixa) configurarPoderes();
  else configurarPoderesCacador();
  if (souLagartixa) {
    // A própria lagartixa ouve o próprio assobio: sem isso ela não tem como
    // saber que acabou de se entregar e que é hora de mudar de canto.
    assobios.registrar(rede.meuId, jogador.raiz);
    // A paleta NÃO abre sozinha: quem quiser pintar aperta "Ações".
    montarPaleta();
    montarPoses();
    configurarAtelie();
  } else {
    el("vida").hidden = false;
    pintarVida();
  }
}

/**
 * Barra de pintura da lagartixa.
 *
 * Três formas de escolher a cor, porque servem a momentos diferentes:
 * as seis prontas (com atalho 1-6) para trocar sem tirar a mão do teclado
 * durante a partida; o seletor livre para escolher qualquer cor com calma;
 * e o conta-gotas, que copia a cor do chão embaixo do bicho -- é o que
 * transforma pintura em camuflagem de verdade, já que acertar o tom do
 * carpete no olho é praticamente impossível.
 */
function montarPaleta() {
  const paleta = el("paleta");
  const cores = paleta.querySelector(".cores");
  const livre = el("cor-livre");

  const aplicar = (cor) => {
    if (!poderes) return;
    poderes.pintar(cor);
    rede.pintar(cor);
    for (const outro of cores.children) {
      outro.setAttribute("aria-pressed", String(outro.dataset.cor === cor));
    }
    livre.value = cor;
  };

  cores.replaceChildren();
  PALETA.forEach((tinta, i) => {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "tinta";
    botao.style.setProperty("--c", tinta.cor);
    botao.dataset.cor = tinta.cor;
    botao.dataset.atalho = String(i + 1);
    botao.title = `${tinta.nome} (${i + 1})`;
    botao.setAttribute("aria-pressed", String(tinta.cor === poderes.cor));
    botao.addEventListener("click", () => aplicar(tinta.cor));
    cores.append(botao);
  });

  livre.value = poderes.cor;
  // `input`, não `change`: a lagartixa muda de cor enquanto se arrasta o
  // seletor, então dá para comparar com o chão antes de fechar.
  livre.addEventListener("input", () => aplicar(livre.value));

  const conta = el("copiar-chao");
  const copiarChao = () => {
    if (!poderes || !jogador) return;
    const cor = corDoChao(escritorio, jogador.posicao, THREE);
    if (cor) aplicar(cor);
    else recado("Nada embaixo para copiar a cor.");
  };
  conta.addEventListener("click", copiarChao);

  addEventListener("keydown", (evento) => {
    if (evento.repeat || !poderes || !andando) return;
    if (digitando || painelChat?.digitando || conversando) return;
    if (evento.code === "KeyX") {
      copiarChao();
      return;
    }
    // `code`, não `key`: em teclado ABNT2 e AZERTY o dígito exige Shift, e
    // `key` devolveria o símbolo em vez do número.
    const n = /^Digit([1-6])$/.exec(evento.code);
    if (n) aplicar(PALETA[Number(n[1]) - 1].cor);
  });
}

/**
 * Botões de pose.
 *
 * Clicar na pose ativa desfaz -- é o mesmo botão de ida e volta, e evita
 * precisar de um quarto botão só para "normal". `T` percorre as três em
 * ordem, para trocar de silhueta sem tirar a mão do teclado enquanto se
 * procura um canto.
 */
function montarPoses() {
  const caixa = el("poses");
  caixa.hidden = false;
  caixa.replaceChildren();

  const titulo = document.createElement("div");
  titulo.className = "titulo";
  titulo.textContent = "pose";
  caixa.append(titulo);

  const slots = new Map();

  const refletir = () => {
    for (const [nome, botao] of slots) {
      botao.setAttribute("aria-pressed", String(nome === poderes?.pose));
    }
  };

  const aplicar = (nome) => {
    if (!poderes) return;
    poderes.posar(nome);
    refletir();
  };

  for (const pose of POSES) {
    const arte = ARTE_POSES[pose.nome];
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "pose-slot";
    botao.dataset.pose = pose.nome;
    botao.style.setProperty("--tom", arte.cor);
    botao.setAttribute("aria-pressed", "false");
    botao.setAttribute("aria-label", arte.nome);
    // Marcação nossa, escrita no módulo de arte: nada de texto de usuário aqui.
    botao.innerHTML = `
      ${arte.svg}
      <span class="tecla">T</span>
      <span class="balao"><strong>${arte.nome}</strong><span>${arte.resumo}</span></span>
    `;
    botao.addEventListener("click", () => aplicar(pose.nome));
    caixa.append(botao);
    slots.set(pose.nome, botao);
  }

  addEventListener("keydown", (evento) => {
    if (evento.repeat || !poderes || !andando || modoPintura) return;
    if (digitando || painelChat?.digitando || conversando) return;
    if (evento.code !== "KeyT") return;
    const i = POSES.findIndex((p) => p.nome === poderes.pose);
    // Depois da última volta para "sem pose", senão não haveria como sair
    // pelo teclado.
    const proxima = i + 1 >= POSES.length ? null : POSES[i + 1].nome;
    poderes.posar(null);
    if (proxima) poderes.posar(proxima);
    refletir();
  });

  // Andar desfaz a pose lá em `filtrarEntrada`, sem passar por aqui. O laço
  // compara e só redesenha na mudança.
  _refletirPoses = refletir;
}

let _refletirPoses = null;
let _poseMostrada = null;

function sincronizarPoses() {
  if (!poderes || poderes.pose === _poseMostrada) return;
  _poseMostrada = poderes.pose;
  _refletirPoses?.();
}

/**
 * Clone da lagartixa para a isca correr.
 *
 * O modelo é carregado uma vez e guardado; cada isca ganha a própria cópia da
 * hierarquia, porque compartilhar faria todas as iscas da sala assumirem a
 * mesma pose. Materiais também são clonados, senão pintar uma pintaria todas.
 */
let _moldeDoClone = null;

async function prepararClone() {
  try {
    _moldeDoClone = await carregarPersonagem(renderer, "/models/lagartixa.glb");
  } catch (erro) {
    // Sem o molde a isca cai nas caixas, que continua sendo uma isca.
    console.warn("[isca] modelo indisponível, usando caixas:", erro);
  }
}

function criarClone(cor) {
  if (!_moldeDoClone || !_cloneUtil) return null;
  const raiz = _cloneUtil(_moldeDoClone.modelo);
  isolarMateriais(raiz);
  pintarRemoto(raiz, `#${cor.getHexString()}`, false);

  const mixer = new THREE.AnimationMixer(raiz);
  // "Andar" e não "Parado": a isca só engana enquanto parece estar fugindo.
  const clipe = _moldeDoClone.clipes.find((c) => c.name === "Andar")
    ?? _moldeDoClone.clipes[0];
  if (clipe) mixer.clipAction(clipe).play();
  return { raiz, mixer };
}

let _cloneUtil = null;

/**
 * Aviso curto no meio da tela.
 *
 * Substitui o `avisoDoSistema`, que escrevia no chat lateral -- fechado por
 * padrão desde que a tela ficou limpa. Explicação em painel escondido não
 * explica nada.
 */
let _recadoAte = 0;

function recado(texto) {
  const el_ = el("recado");
  el_.textContent = texto;
  el_.hidden = false;
  requestAnimationFrame(() => el_.classList.add("visivel"));
  _recadoAte = performance.now() + 2600;
}

function atualizarRecado() {
  const el_ = el("recado");
  if (el_.hidden || performance.now() < _recadoAte) return;
  el_.classList.remove("visivel");
  // Espera a transição antes de sumir de vez, senão o texto pisca.
  if (performance.now() > _recadoAte + 300) el_.hidden = true;
}

// ------------------------------------------------------ enquadramento

/**
 * Três enquadramentos, um botão.
 *
 * Jogar rente ao chão num escritório cheio de móveis é difícil de enxergar --
 * às vezes falta distância, às vezes o problema é justamente estar longe. Em
 * vez de eu escolher um compromisso, a pessoa alterna.
 */
let cameraEscolhida = 0;

function aplicarCamera() {
  const modo = CAMERAS[cameraEscolhida];
  primeiraPessoa = Boolean(modo.primeiraPessoa);
  cameraJogo.primeiraPessoa = primeiraPessoa;
  cameraJogo.alturaDosOlhos = modo.alturaDosOlhos ?? 1.62;
  cameraJogo.ombro = modo.ombro ?? { lado: 0, altura: 0 };
  if (modo.distancia) cameraJogo.distancia = modo.distancia;
  if (modo.alvo !== undefined) jogador.alvoCamera = modo.alvo;

  // Em primeira pessoa o corpo some (a lente fica dentro dele); nos outros
  // enquadramentos ele precisa voltar.
  if (jogador && !primeiraPessoa) jogador.raiz.visible = !espectando;

  const botao = el("btn-enquadramento");
  botao.querySelector(".nome").textContent = modo.rotulo;
  botao.querySelector(".balao > span").textContent = modo.dica;
}

function configurarCamera() {
  const botao = el("btn-enquadramento");
  botao.hidden = !souLagartixa;
  if (!souLagartixa) return;

  const girar = () => {
    cameraEscolhida = (cameraEscolhida + 1) % CAMERAS.length;
    aplicarCamera();
  };
  botao.addEventListener("click", girar);
  addEventListener("keydown", (evento) => {
    if (evento.code !== "KeyO" || evento.repeat) return;
    if (digitando || painelChat?.digitando || conversando || modoPintura) return;
    girar();
  });
  aplicarCamera();
}

// ------------------------------------------------------------ destravar

/**
 * Conserto de travamento, sem virar saída de emergência.
 *
 * O problema: um botão de "voltar para área segura" seria apertado ao ouvir o
 * primeiro tiro. A saída não é vigiar o botão, é escolher outro DESTINO --
 * quem destrava volta para onde estava dez segundos atrás. Não é lugar novo,
 * não é lugar melhor, e provavelmente ainda está perto de quem atira. Só
 * desfaz o travamento, porque dez segundos atrás o corpo andava.
 *
 * Some três guardas por cima, todas no servidor: espera entre usos, recusa
 * logo depois de levar dano, e o botão só APARECE quando o jogo detecta que o
 * corpo está mesmo preso.
 */
const LIMBO = -5;            // abaixo disso, caiu para fora do mundo
const PRESO_MS = 1600;       // insistindo em andar sem sair do lugar
const PRESO_DISTANCIA = 0.08;

let _tentandoAndarDesde = 0;
let _ondeTentou = null;
let preso = false;
let _ultimoPedidoDeLimbo = 0;

function vigiarTravamento(dt, entrada) {
  if (!jogador || espectando || abatido || jogador.sentado) {
    preso = false;
    el("destravar").hidden = true;
    return;
  }

  // Caiu para fora do mundo: nem espera o jogador perceber. Com freio, porque
  // a queda continua enquanto o servidor não responde, e pedir a cada quadro
  // encheria o socket de pedidos idênticos.
  if (jogador.posicao.y < LIMBO) {
    const agora = performance.now();
    if (agora - _ultimoPedidoDeLimbo > 1200) {
      _ultimoPedidoDeLimbo = agora;
      rede.destravar("limbo");
    }
    jogador.velocidade.set(0, 0, 0);
    jogador._velNormal = 0;
    _tentandoAndarDesde = 0;
    return;
  }

  const querendo = entrada.frente || entrada.tras || entrada.esquerda || entrada.direita;
  if (!querendo) {
    _tentandoAndarDesde = 0;
    _ondeTentou = null;
  } else {
    const agora = performance.now();
    if (!_ondeTentou) {
      _ondeTentou = jogador.posicao.clone();
      _tentandoAndarDesde = agora;
    } else if (jogador.posicao.distanceTo(_ondeTentou) > PRESO_DISTANCIA) {
      // Andou: não está preso. Some o botão -- se destravou sozinho (um empurrão
      // da física, um móvel que saiu do caminho), não faz sentido continuar
      // oferecendo o conserto.
      preso = false;
      _ondeTentou.copy(jogador.posicao);
      _tentandoAndarDesde = agora;
    } else if (agora - _tentandoAndarDesde > PRESO_MS) {
      preso = true;
    }
  }

  el("destravar").hidden = !preso;
}

function configurarDestravar() {
  const pedir = () => {
    if (!preso) return;
    rede.destravar("preso");
    preso = false;
    _tentandoAndarDesde = 0;
    _ondeTentou = null;
    el("destravar").hidden = true;
  };
  el("destravar").addEventListener("click", pedir);
  addEventListener("keydown", (evento) => {
    if (evento.code === "KeyK" && !evento.repeat && !digitando && !painelChat?.digitando) {
      pedir();
    }
  });
}

// ------------------------------------------------------------ truques

/**
 * Os poderes da lagartixa, do lado do navegador.
 *
 * Aqui só se pede e se desenha. O servidor é que decide se o poder vale, cobra
 * o preço em assobio e avisa a sala -- é isso que impede um cliente adulterado
 * de cuspir de longe ou soltar assobio falso sem parar.
 */
const ESPERAS = { assobioFalso: 6000, cauda: 45000, cuspe: 9000, escuro: 40000, arranque: 7000 };
const ARRANQUE_MS = 1100;
const ARRANQUE_FATOR = 2.3;
const FARO_ALCANCE = 9;

let arranqueAte = 0;
const _proximoUso = {};
const _ndcPoder = new THREE.Vector2();
const _raioPoder = new THREE.Raycaster();

function configurarPoderes() {
  const barra = el("skills");
  barra.hidden = false;
  barra.replaceChildren();

  const teclas = {
    esconder: "C", assobioFalso: "Q", cauda: "E", cuspe: "R", escuro: "G", arranque: "V",
  };
  const porTecla = Object.fromEntries(
    Object.entries(teclas).map(([qual, t]) => [`Key${t}`, qual]),
  );
  const slots = new Map();

  for (const [qual, arte] of Object.entries(ARTE)) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "skill";
    botao.dataset.poder = qual;
    botao.style.setProperty("--tom", arte.cor);
    botao.setAttribute("aria-pressed", "false");
    botao.setAttribute("aria-label", arte.nome);
    // A arte vem do módulo como marcação confiável, escrita por nós -- não é
    // texto de usuário, então `innerHTML` aqui não abre porta para nada.
    botao.innerHTML = `
      ${arte.svg}
      <span class="recarga"></span>
      <span class="conta"></span>
      <span class="tecla">${teclas[qual]}</span>
      <span class="balao">
        <strong>${arte.nome}</strong>
        <span>${arte.resumo}</span>
        <span class="motivo"></span>
      </span>
    `;
    botao.addEventListener("click", () => usar(qual));
    barra.append(botao);
    slots.set(qual, botao);
  }

  /**
   * Por que este truque não pode ser usado agora, ou null se pode.
   *
   * O botão apagado diz isso antes do clique. Antes só se descobria depois de
   * apertar e ler o recado, o que faz a pessoa achar que a habilidade está
   * quebrada -- foi exatamente o que aconteceu com a lâmpada.
   */
  const motivoDeBloqueio = (qual) => {
    // Esconder-se vale em qualquer fase: é o que se faz no minuto de preparo.
    if (qual === "esconder") return null;
    if (faseAtual !== "caca") return "Só durante a caçada.";
    if (qual === "escuro" && !interruptores?.aoAlcance(jogador?.posicao)) {
      const d = interruptores?.distanciaAoMaisProximo(jogador?.posicao);
      return Number.isFinite(d)
        ? `Chegue a um interruptor (${Math.round(d)} m).`
        : "Nenhum interruptor por perto.";
    }
    if (qual === "cuspe" && !cacadorMaisProximo()) {
      return "Nenhum caçador ao alcance.";
    }
    return null;
  };

  const usar = (qual) => {
    if (!poderes || !andando || espectando || abatido) return;

    // Esconder é ALTERNÁVEL: não gasta assobio nem tem recarga, porque não é
    // um truque -- é o estado natural do bicho. Fica na mesma régua das outras
    // por ser a coisa que mais se aperta, e procurar por ela noutro canto da
    // tela no meio de uma caçada não faria sentido.
    if (qual === "esconder") {
      poderes.esconder(!poderes.escondida);
      refletir();
      return;
    }

    if (performance.now() < (_proximoUso[qual] ?? 0)) return;

    // Fora da caçada o servidor recusa em silêncio. Dizer o porquê aqui evita
    // o pior tipo de defeito de interface: apertar, não acontecer nada, e não
    // haver como saber se o problema é a regra ou o jogo.
    if (faseAtual !== "caca") {
      recado(faseAtual === "preparo"
        ? "Os truques só valem quando a caçada começa."
        : "Comece a rodada para usar os truques.");
      return;
    }

    if (qual === "assobioFalso") {
      // Precisa de alvo: arma e espera o clique no mundo.
      poderMirando = poderMirando === qual ? null : qual;
      document.body.classList.toggle("mirando-poder", Boolean(poderMirando));
      refletir();
      return;
    }

    if (qual === "escuro" && !interruptores?.aoAlcance(jogador.posicao)) {
      const d = interruptores?.distanciaAoMaisProximo(jogador.posicao) ?? Infinity;
      recado(Number.isFinite(d)
        ? `Chegue até um interruptor — o mais perto está a ${Math.round(d)} m.`
        : "Nenhum interruptor por perto.");
      return;
    }

    if (qual === "cauda") {
      // A isca dispara para TRÁS: a lagartixa segue em frente enquanto o olho
      // do caçador vai atrás do que se move na direção oposta.
      const fuga = new THREE.Vector3(
        -Math.sin(jogador.olhandoPara), 0, -Math.cos(jogador.olhandoPara),
      );
      rede.usarPoder("cauda", { p: paraLista(jogador.posicao), d: paraLista(fuga) });
    } else if (qual === "cuspe") {
      const vitima = cacadorMaisProximo();
      if (!vitima) {
        recado("Chegue mais perto de um caçador para cuspir.");
        return;
      }
      rede.usarPoder("cuspe", { alvo: vitima.id, cor: poderes.cor });
    } else if (qual === "arranque") {
      arranqueAte = performance.now() + ARRANQUE_MS;
      rede.usarPoder("arranque");
    } else {
      rede.usarPoder(qual);
    }

    _proximoUso[qual] = performance.now() + (ESPERAS[qual] ?? 5000);
    refletir();
  };

  /**
   * Desenha o estado de cada slot.
   *
   * O setor de recarga é um `conic-gradient` cujo ângulo desce de uma volta a
   * zero. Chamado todo quadro, mas só escreve quando o valor muda de verdade:
   * mexer no estilo de cinco elementos a 60 Hz por nada é trabalho de layout
   * que a barra não precisa dar.
   */
  const refletir = () => {
    const agora = performance.now();
    for (const [qual, botao] of slots) {
      const resta = (_proximoUso[qual] ?? 0) - agora;
      const total = ESPERAS[qual] ?? 5000;
      const esperando = qual !== "esconder" && resta > 0;

      // A recarga vem antes do bloqueio: se as duas valem, o número no
      // relógio é a informação mais útil.
      const motivo = esperando ? null : motivoDeBloqueio(qual);
      if (botao.dataset.motivo !== (motivo ?? "")) {
        botao.dataset.motivo = motivo ?? "";
        botao.querySelector(".motivo").textContent = motivo ?? "";
        botao.classList.toggle("indisponivel", Boolean(motivo));
      }

      if (botao.classList.contains("esperando") !== esperando) {
        botao.classList.toggle("esperando", esperando);
      }
      botao.disabled = esperando || Boolean(motivo);
      if (esperando) {
        const volta = (resta / total).toFixed(3);
        if (botao.dataset.volta !== volta) {
          botao.dataset.volta = volta;
          botao.style.setProperty("--volta", `${volta}turn`);
          botao.querySelector(".conta").textContent = String(Math.ceil(resta / 1000));
        }
      }
      const marcado = qual === "esconder"
        ? Boolean(poderes?.escondida)
        : poderMirando === qual;
      botao.setAttribute("aria-pressed", String(marcado));
    }
  };
  _refletirPoderes = refletir;

  addEventListener("keydown", (evento) => {
    if (evento.repeat || !poderes || !andando || modoPintura) return;
    if (digitando || painelChat?.digitando || conversando) return;
    const qual = porTecla[evento.code];
    if (qual) usar(qual);
    else if (evento.code === "Escape" && poderMirando) {
      poderMirando = null;
      document.body.classList.remove("mirando-poder");
      refletir();
    }
  });

  // O clique no mundo entrega o ponto do assobio falso.
  renderer.domElement.addEventListener("pointerdown", (evento) => {
    if (!poderMirando || evento.button !== 0 || modoPintura) return;
    const caixaTela = renderer.domElement.getBoundingClientRect();
    _ndcPoder.x = ((evento.clientX - caixaTela.left) / caixaTela.width) * 2 - 1;
    _ndcPoder.y = -((evento.clientY - caixaTela.top) / caixaTela.height) * 2 + 1;
    _raioPoder.setFromCamera(_ndcPoder, camera);
    const toque = _raioPoder.intersectObject(colisor, true)[0];
    if (toque) {
      rede.usarPoder("assobioFalso", { p: paraLista(toque.point) });
      _proximoUso.assobioFalso = performance.now() + ESPERAS.assobioFalso;
    }
    poderMirando = null;
    document.body.classList.remove("mirando-poder");
    refletir();
  }, true);

  refletir();
}

let _refletirPoderes = null;

function paraLista(v) {
  return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
}

function cacadorMaisProximo() {
  let melhor = null;
  let dist = Infinity;
  for (const r of remotos.mapa.values()) {
    if (!r || r.papel === "lagartixa") continue;
    const d = r.raiz.position.distanceTo(jogador.posicao);
    if (d < dist) { dist = d; melhor = r; }
  }
  // O servidor recusa acima de 7 m; conferir aqui evita gastar a espera à toa.
  return dist <= 7 ? melhor : null;
}

// ------------------------------------------------------------ tela limpa

/**
 * Painéis sob demanda.
 *
 * A tela de jogo mostra o mínimo: cronômetro, vida e três botões. Barra de
 * pintura, régua de comandos e código da sala só aparecem quando pedidos --
 * numa caçada de esconde-esconde, cada faixa fixa na tela é área que deixa de
 * mostrar o escritório onde alguém pode estar escondido.
 */
const CHAVE_COMANDOS = "poligono:mostrar-comandos";
let fecharConfig = () => {};
let mostrarComandos = localStorage.getItem(CHAVE_COMANDOS) === "1";

/** A régua de comandos aparece só se a pessoa tiver pedido nas configurações. */
function atualizarDica() {
  elDica.hidden = !mostrarComandos || conversando || !dicaPermitida;
}
let dicaPermitida = false;

function configurarPaineis() {
  const paleta = el("paleta");
  const config = el("config");
  const btnAcoes = el("btn-acoes");
  const btnConfig = el("btn-config");
  const optComandos = el("opt-comandos");

  const abrir = (elemento, botao, sim) => {
    elemento.hidden = !sim;
    botao.setAttribute("aria-pressed", String(sim));
  };

  btnAcoes.addEventListener("click", () => {
    abrir(paleta, btnAcoes, paleta.hidden);
  });

  btnConfig.addEventListener("click", () => {
    abrir(config, btnConfig, config.hidden);
  });
  el("fechar-config").addEventListener("click", () => abrir(config, btnConfig, false));
  // Clicar numa amiga na lista já troca a câmera; deixar as configurações
  // abertas por cima esconderia justamente o que se foi ver.
  fecharConfig = () => abrir(config, btnConfig, false);

  optComandos.checked = mostrarComandos;
  optComandos.addEventListener("change", () => {
    mostrarComandos = optComandos.checked;
    // Guardado: quem gosta da régua não quer reativá-la a cada partida.
    localStorage.setItem(CHAVE_COMANDOS, mostrarComandos ? "1" : "0");
    atualizarDica();
  });

  // Só a lagartixa pinta e posa; para o caçador o botão nem existe.
  btnAcoes.hidden = !souLagartixa;
  btnAcoes.querySelector(".arte").innerHTML = ARTE_ACOES;
  btnAcoes.title = "Paleta: cores, pincel e poses";
}

// ------------------------------------------------------------ olhar

/**
 * Sair do corpo sem sair da rodada.
 *
 * Duas coisas diferentes com a mesma saída: a câmera LIVRE, para conferir o
 * próprio esconderijo de fora (presa por uma corda ao corpo, senão viraria
 * reconhecimento aéreo dos caçadores), e a câmera da AMIGA, que pula para
 * outra lagartixa em qualquer canto do prédio -- ali o alvo é uma aliada, não
 * o mapa, então não precisa de corda.
 *
 * O corpo continua no lugar, respirando e vulnerável: quem está olhando de
 * fora não anda, não atira e não pinta. É esse o preço, e é o que impede que
 * a câmera vire uma forma de jogar melhor em vez de uma forma de olhar.
 *
 * Não existe versão disto para caçador nem para ver caçador -- pelo mesmo
 * motivo de sempre, o servidor só manda a inclinação da cabeça alheia a quem
 * já foi eliminado.
 */
function podeOlhar() {
  // Só com rodada em curso: na sala de espera todo mundo está no mesmo canto,
  // e um painel que não serve para nada é a mesma sujeira que os botões
  // ligados fora de hora.
  return souLagartixa && andando && !!jogador && !espectando && !abatido
    && (faseAtual === "preparo" || faseAtual === "caca");
}

/** As outras lagartixas vivas, para a lista e para a câmera de amiga. */
function amigasVivas() {
  return [...remotos.mapa.values()].filter(
    (r) => r && r.papel === "lagartixa" && !r.eliminado,
  );
}

function entrarNoOlhar(alvo) {
  if (!podeOlhar()) return;
  const primeiraVez = olhando === null;
  olhando = alvo;

  if (primeiraVez) {
    cameraJogo.desativar();
    cameraJogo.pincelando = false;
    if (modoPintura) abrirAtelie(false);
    combate?.desativar();
    el("mira").hidden = true;
    cameraLivre.assumir(camera);
  }

  if (alvo === "livre") {
    cameraLivre.coleira = { centro: jogador.posicao.clone(), raio: RAIO_COLEIRA };
    cameraLivre.ativar();
  } else {
    const amiga = remotos.mapa.get(alvo);
    // Sem a amiga na cena não há o que enquadrar; cair na livre é melhor do
    // que ficar com a câmera onde estava, sem explicação.
    if (!amiga) return entrarNoOlhar("livre");
    enquadrarAmiga(amiga);
  }
  mostrarOlhar();
}

function sairDoOlhar() {
  if (olhando === null) return;
  olhando = null;
  cameraLivre.desativar();
  cameraLivre.coleira = null;
  revelarAvatarAssistido();
  cameraJogo.ativar();
  combate?.ativar();
  mostrarOlhar();
}

/** O painel de olhar: só existe para lagartixa viva, e some junto com ela. */
function mostrarOlhar() {
  const painel = el("olhar");
  painel.hidden = !podeOlhar();
  el("olhar-barra").hidden = olhando === null;
  el("btn-olhar").setAttribute("aria-pressed", String(olhando !== null));

  const amigas = amigasVivas();
  el("btn-amigas").disabled = amigas.length === 0;
  el("btn-olhar-livre").setAttribute("aria-pressed", String(olhando === "livre"));

  const quem = el("olhar-quem");
  const alvo = remotos.mapa.get(olhando);
  quem.textContent = olhando === "livre"
    ? "WASD voa, espaço sobe — preso a 14 m do seu corpo"
    : alvo
      ? `vendo ${alvo.nome} — WASD dá a volta nela; o mouse solta a mira`
      : "";

  // Os botões são reaproveitados enquanto o elenco não muda.
  //
  // A distância se mexe o tempo todo, então este painel se redesenha duas
  // vezes por segundo -- e trocar os botões debaixo do dedo comia o clique de
  // quem estava mirando um nome para reenquadrar. Só o texto da distância é
  // reescrito; o botão em si continua o mesmo elemento.
  const lista = el("olhar-amigas");
  const mesmas = lista.children.length === amigas.length
    && amigas.every((a, i) => lista.children[i].dataset.id === a.id);

  if (!mesmas) {
    lista.replaceChildren();
    for (const amiga of amigas) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "amiga";
      b.dataset.id = amiga.id;
      b.style.setProperty("--c", naSala.get(amiga.id)?.cor ?? "#8de08d");
      b.append(
        Object.assign(document.createElement("span"), { textContent: amiga.nome }),
        Object.assign(document.createElement("span"), { className: "longe" }),
      );
      // Clicar de novo na que já se vê REENQUADRA: depois de dar a volta nela
      // com o WASD é o jeito de voltar ao ombro sem sair do modo.
      b.addEventListener("click", () => entrarNoOlhar(amiga.id));
      lista.append(b);
    }
  }

  amigas.forEach((amiga, i) => {
    const b = lista.children[i];
    b.setAttribute("aria-pressed", String(olhando === amiga.id));
    b.title = olhando === amiga.id ? "reenquadrar nela" : "ver onde ela está";
    // Quanto longe ela está: é a informação que a lista dá antes do clique.
    b.lastChild.textContent =
      `${Math.round(amiga.raiz.position.distanceTo(jogador.posicao))} m`;
  });
}

function configurarOlhar() {
  el("btn-olhar").addEventListener("click", () => {
    if (olhando !== null) sairDoOlhar();
    else entrarNoOlhar("livre");
  });
  el("btn-olhar-livre").addEventListener("click", () => entrarNoOlhar("livre"));
  el("btn-amigas").addEventListener("click", () => {
    // Sem amiga escolhida vai para a primeira; com uma escolhida, passa à
    // seguinte -- o mesmo gesto de trocar de caçador no espectador.
    const lista = amigasVivas();
    if (!lista.length) return;
    const i = lista.findIndex((r) => r.id === olhando);
    entrarNoOlhar(lista[(i + 1) % lista.length].id);
  });
  el("btn-voltar-corpo").addEventListener("click", () => sairDoOlhar());
}

/**
 * Aponta a câmera livre para uma amiga, sem prendê-la ali.
 *
 * Travada, a câmera da amiga virava uma foto: mostrava onde ela está e mais
 * nada, e para entender a situação dela -- o caçador que vem pelo corredor,
 * a saída atrás do armário -- era preciso adivinhar. Aqui o clique só faz o
 * ENQUADRAMENTO inicial; a partir dele é a mesma câmera livre de sempre, e dá
 * para dar a volta em torno dela.
 *
 * A coleira passa a valer em torno da AMIGA, não do seu corpo. Sem isso a
 * corda puxaria a câmera de volta para você no primeiro quadro, e o clique não
 * teria serventia nenhuma; com isso, o que se ganha continua sendo os catorze
 * metros em volta de uma aliada, e não o prédio inteiro.
 */
function enquadrarAmiga(alvo) {
  // O ombro sai pela NORMAL da superfície, não "para cima" do mundo.
  //
  // Uma lagartixa passa metade da partida grudada numa parede, e ali "2,2 m
  // atrás dela" fica dentro do concreto -- a tela vinha cinza. Tirando o ombro
  // pela normal, a câmera cai no meio do cômodo em frente à parede; e no chão,
  // onde a normal é (0,1,0), continua sendo o enquadramento de ombro de
  // sempre.
  alvo.raiz.updateMatrixWorld();
  const m = alvo.raiz.matrixWorld.elements;
  _olharCima.set(m[4], m[5], m[6]).normalize();
  _olharFrente.set(m[8], m[9], m[10]).normalize();

  _olharAlvo.copy(alvo.raiz.position).addScaledVector(_olharCima, 0.3);
  _olharOnde.copy(_olharAlvo)
    .addScaledVector(_olharCima, 2.0)
    .addScaledVector(_olharFrente, -1.2);

  // Sonda até o ponto do ombro, senão a câmera NASCE dentro da parede. Depois
  // do enquadramento ela volta a atravessar tudo, como toda câmera livre --
  // isto é só para o primeiro quadro não ser uma tela de concreto.
  _olharDir.subVectors(_olharOnde, _olharAlvo);
  const alcance = _olharDir.length();
  if (colisor && alcance > 1e-3) {
    _olharDir.divideScalar(alcance);
    _olharSonda.set(_olharAlvo, _olharDir);
    _olharSonda.near = 0;
    _olharSonda.far = alcance;
    _olharSonda.firstHitOnly = true;
    const toque = _olharSonda.intersectObject(colisor, true)[0];
    // Uma folga antes da parede: encostada nela, o plano de corte da lente
    // come o reboco e volta a aparecer o vazio do outro lado.
    if (toque) {
      _olharOnde.copy(_olharAlvo)
        .addScaledVector(_olharDir, Math.max(0.9, toque.distance - 0.15));
    }
  }

  // A câmera livre herda posição E direção daqui: `assumir` lê as duas de uma
  // câmera de verdade, então basta montar o quadro nela primeiro.
  camera.position.copy(_olharOnde);
  camera.lookAt(_olharAlvo);
  cameraLivre.assumir(camera);
  cameraLivre.coleira = { centro: alvo.raiz.position.clone(), raio: RAIO_COLEIRA };
  cameraLivre.ativar();
}

/**
 * Viva, a câmera não atravessa parede.
 *
 * A coleira segurava a DISTÂNCIA, não a geometria: bastava apontar para fora
 * e em dois segundos a câmera estava do lado de fora do prédio, olhando o
 * escritório pelo avesso -- vista inútil, e de quebra a visão de raio-X que a
 * corda existia para evitar. Aqui ela é puxada de volta para o primeiro
 * obstáculo entre ela e o que está seguindo, então continua livre dentro do
 * cômodo e não sai dele.
 *
 * Vale só para a câmera de AMIGA: ali o alvo é ela, e ficar do lado de cá da
 * parede dela é o que mantém o cômodo dela na tela. Na câmera livre do próprio
 * corpo não vale -- ver só o que o corpo já vê não seria olhar nada. E a de
 * quem já foi ELIMINADA continua atravessando tudo, como sempre: lá não há
 * mais nada a proteger, e emperrar em batente de porta seria pior.
 */
function manterNaVista(centro) {
  if (!colisor) return;
  _olharDir.subVectors(cameraLivre.posicao, centro);
  const alcance = _olharDir.length();
  if (alcance < 1e-3) return;
  _olharDir.divideScalar(alcance);

  _olharSonda.set(centro, _olharDir);
  _olharSonda.near = 0;
  _olharSonda.far = alcance;
  _olharSonda.firstHitOnly = true;
  const toque = _olharSonda.intersectObject(colisor, true)[0];
  if (!toque) return;

  // Uma folga antes da parede: encostada nela, o plano de corte da lente come
  // o reboco e volta a aparecer o vazio do outro lado.
  cameraLivre.posicao.copy(centro)
    .addScaledVector(_olharDir, Math.max(0.25, toque.distance - 0.15));
}

/** Onde a câmera fica em cada modo de olhar. */
function atualizarOlhar(dt) {
  if (olhando === "livre") {
    // A corda acompanha o corpo: empurrada por um tiro, a câmera vai junto em
    // vez de a lagartixa escorregar para fora do próprio alcance de visão.
    if (cameraLivre.coleira) cameraLivre.coleira.centro.copy(jogador.posicao);
    cameraLivre.atualizar(dt);
    // Aqui a câmera atravessa parede, e só a corda a segura.
    //
    // Prendê-la à linha de visão do corpo, como se faz na câmera de amiga,
    // deixava de mostrar qualquer coisa: no escritório em baias, quase tudo
    // está atrás de uma divisória, e sobrava exatamente o que já se via de
    // dentro do corpo. Como o alcance é o seu próprio esconderijo mais catorze
    // metros, o que se ganha é conferir a divisória do lado -- e voar para
    // fora do prédio só rende tela vazia, que se resolve sozinho.
    return;
  }

  const alvo = remotos.mapa.get(olhando);
  if (!alvo || alvo.eliminado) {
    // A amiga foi achada ou saiu da sala: cai para a livre em vez de congelar
    // a imagem de alguém que não está mais lá.
    entrarNoOlhar("livre");
    return;
  }

  // A corda segue a amiga enquanto ela anda, senão bastava ela atravessar uma
  // sala para arrastar a câmera pela coleira ou deixá-la para trás.
  if (cameraLivre.coleira) cameraLivre.coleira.centro.copy(alvo.raiz.position);
  cameraLivre.atualizar(dt);
  // Mesma história do lado da amiga: a origem sai pela normal da superfície
  // em que ela está, senão o raio começa dentro da parede em que ela escala.
  alvo.raiz.updateMatrixWorld();
  const mm = alvo.raiz.matrixWorld.elements;
  _olharCima.set(mm[4], mm[5], mm[6]).normalize();
  _olharMira.copy(alvo.raiz.position).addScaledVector(_olharCima, 0.5);
  manterNaVista(_olharMira);
  cameraLivre.camera.position.copy(cameraLivre.posicao);
  // E a lente continua nela: voando só com o teclado, o passo lateral tirava a
  // lagartixa do quadro em meio segundo, e o jeito de reencontrá-la era clicar
  // no nome de novo. Mexer o mouse desliga a mira, para quem quiser olhar o
  // resto do cômodo.
  cameraLivre.mirarEm(_olharMira, dt);
}

const _olharAlvo = new THREE.Vector3();
const _olharOnde = new THREE.Vector3();
const _olharMira = new THREE.Vector3();
const _olharCima = new THREE.Vector3();
const _olharFrente = new THREE.Vector3();
const _olharDir = new THREE.Vector3();
const _olharSonda = new THREE.Raycaster();
let _olharDesde = 0;

/** O medidor de bateria: só aparece com a lanterna existindo. */
function atualizarBateria() {
  const caixa = el("bateria");
  if (caixa.hidden) caixa.hidden = false;
  const pct = Math.round((lanterna?.carga ?? 0) * 100);
  if (caixa.dataset.pct === String(pct)) return;
  caixa.dataset.pct = String(pct);
  caixa.style.setProperty("--carga", `${pct}%`);
  caixa.querySelector(".numero").textContent = `${pct}%`;
  // Vermelho no fim, e apagado quando não está gastando: o medidor precisa
  // gritar só quando falta pouco E a lanterna está acesa.
  caixa.classList.toggle("baixa", pct <= 20);
  caixa.classList.toggle("ligada", Boolean(lanterna?.ligada));
}

/** A barra de conjuração do disjuntor. */
function atualizarConjuracao() {
  const barra = el("conjuracao");
  const resta = conjurandoAte - performance.now();
  const ativa = resta > 0;
  if (barra.hidden !== !ativa) barra.hidden = !ativa;
  if (!ativa) return;
  const k = 1 - resta / CONJURACAO_MS;
  barra.style.setProperty("--feito", `${Math.round(k * 100)}%`);
}

// -------------------------------------------------- truques de quem caça

/**
 * A barra de habilidades do caçador.
 *
 * Até aqui ele tinha uma arma e mais nada: os cinco poderes eram todos do
 * outro lado. O desequilíbrio não era de força -- era de INFORMAÇÃO, e vinha
 * de um número só. Parada e escondida, a lagartixa compra 0,9 s de silêncio a
 * cada segundo parado, então a jogada dominante era se enfiar num canto no
 * minuto de preparo e não se mexer mais.
 *
 * Metade destes poderes cobra imobilidade (`batida`, `sensor`) e a outra
 * metade cobra movimento (`po`, `rede`): juntos, apertam dos dois lados, e
 * nenhum deles diz onde ela está. O `disjuntor` é a resposta ao apagão, e a
 * `lanterna` é a resposta ao escuro que sobrar.
 */
const ESPERAS_CACADOR = {
  lanterna: 0, batida: 8000, sensor: 18000, rede: 14000, disjuntor: 25000, po: 20000,
};
const ALCANCE_BATIDA = 8;
const ALCANCE_REDE = 16;
const ALCANCE_PO = 14;
const ALCANCE_SENSOR = 4;
const CONJURACAO_MS = 1800;
let _refletirCacador = () => {};

function configurarPoderesCacador() {
  lanterna = new Lanterna(camera);

  const barra = el("skills");
  barra.hidden = false;
  barra.replaceChildren();

  // L de Lanterna. O F já era o "Sentar", e dar a mesma tecla às duas coisas
  // fazia o caçador acender a lanterna e sentar no mesmo aperto.
  const teclas = {
    lanterna: "L", batida: "Q", sensor: "E", rede: "R", disjuntor: "G", po: "V",
  };
  const porTecla = Object.fromEntries(
    Object.entries(teclas).map(([qual, t]) => [`Key${t}`, qual]),
  );
  const slots = new Map();

  for (const [qual, arte] of Object.entries(ARTE_CACADOR)) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "skill";
    botao.dataset.poder = qual;
    botao.style.setProperty("--tom", arte.cor);
    botao.setAttribute("aria-pressed", "false");
    botao.setAttribute("aria-label", arte.nome);
    // A arte vem do módulo como marcação confiável, escrita por nós.
    botao.innerHTML = `
      ${arte.svg}
      <span class="recarga"></span>
      <span class="conta"></span>
      <span class="tecla">${teclas[qual]}</span>
      <span class="balao">
        <strong>${arte.nome}</strong>
        <span>${arte.resumo}</span>
        <span class="motivo"></span>
      </span>
    `;
    botao.addEventListener("click", () => usar(qual));
    barra.append(botao);
    slots.set(qual, botao);
  }

  /** Por que este truque não pode ser usado agora, ou null se pode. */
  const motivoDeBloqueio = (qual) => {
    // A lanterna vale em qualquer fase: procurar no escuro é o trabalho, e no
    // preparo ela ainda serve para se posicionar.
    if (qual === "lanterna") {
      return lanterna?.carga <= 0.02 && !lanterna?.ligada ? "Bateria vazia." : null;
    }
    if (faseAtual !== "caca") return "Só durante a caçada.";
    if (qual === "rede" && !lagartixaMaisProxima()) {
      return "Nenhuma lagartixa à vista.";
    }
    if (qual === "disjuntor" && !escuridao?.escuro) {
      return "As luzes já estão acesas.";
    }
    return null;
  };

  const usar = (qual) => {
    if (!andando || espectando || abatido) return;

    // A lanterna é ALTERNÁVEL e não passa pelo servidor: é luz na tela de quem
    // a segura. Fica na barra por ser onde alguém vai procurá-la.
    if (qual === "lanterna") {
      if (!lanterna?.alternar()) recado("A bateria da lanterna está vazia.");
      _refletirCacador();
      return;
    }

    if (performance.now() < (_proximoUso[qual] ?? 0)) return;

    if (faseAtual !== "caca") {
      recado(faseAtual === "preparo"
        ? "Espere a caçada começar — elas ainda estão se escondendo."
        : "Comece a rodada para usar os truques.");
      return;
    }

    // Os dois que precisam de alvo no mundo armam e esperam o clique.
    if (qual === "po") {
      poderMirando = poderMirando === qual ? null : qual;
      document.body.classList.toggle("mirando-poder", Boolean(poderMirando));
      _refletirCacador();
      return;
    }

    if (qual === "sensor") {
      // Larga aos pés: não precisa de mira, e um sensor que exige apontar o
      // chão no meio de uma perseguição não seria usado nunca.
      rede.usarPoder("sensor", { p: paraLista(jogador.posicao) });
    } else if (qual === "rede") {
      const presa = lagartixaMaisProxima();
      if (!presa) {
        recado("Nenhuma lagartixa ao alcance da rede.");
        return;
      }
      rede.usarPoder("rede", { alvo: presa.id });
    } else if (qual === "disjuntor") {
      if (!escuridao?.escuro) {
        recado("As luzes já estão acesas.");
        return;
      }
      conjurandoAte = performance.now() + CONJURACAO_MS;
      rede.usarPoder("disjuntor");
    } else {
      rede.usarPoder(qual);
    }

    _proximoUso[qual] = performance.now() + (ESPERAS_CACADOR[qual] ?? 5000);
    _refletirCacador();
  };

  const refletir = () => {
    const agora = performance.now();
    for (const [qual, botao] of slots) {
      const resta = (_proximoUso[qual] ?? 0) - agora;
      const total = ESPERAS_CACADOR[qual] || 5000;
      const esperando = qual !== "lanterna" && resta > 0;

      const motivo = esperando ? null : motivoDeBloqueio(qual);
      if (botao.dataset.motivo !== (motivo ?? "")) {
        botao.dataset.motivo = motivo ?? "";
        botao.querySelector(".motivo").textContent = motivo ?? "";
        botao.classList.toggle("indisponivel", Boolean(motivo));
      }
      if (botao.classList.contains("esperando") !== esperando) {
        botao.classList.toggle("esperando", esperando);
      }
      botao.disabled = esperando || Boolean(motivo);
      if (esperando) {
        const volta = (resta / total).toFixed(3);
        if (botao.dataset.volta !== volta) {
          botao.dataset.volta = volta;
          botao.style.setProperty("--volta", `${volta}turn`);
          botao.querySelector(".conta").textContent = String(Math.ceil(resta / 1000));
        }
      }
      const marcado = qual === "lanterna"
        ? Boolean(lanterna?.ligada)
        : poderMirando === qual;
      botao.setAttribute("aria-pressed", String(marcado));
    }
  };
  _refletirCacador = refletir;

  addEventListener("keydown", (evento) => {
    if (evento.repeat || !andando || modoPintura) return;
    if (digitando || painelChat?.digitando || conversando) return;
    const qual = porTecla[evento.code];
    if (qual) usar(qual);
    else if (evento.code === "Escape" && poderMirando) {
      poderMirando = null;
      document.body.classList.remove("mirando-poder");
      refletir();
    }
  });

  // O clique no mundo entrega o ponto do pó.
  renderer.domElement.addEventListener("pointerdown", (evento) => {
    if (poderMirando !== "po" || evento.button !== 0 || modoPintura) return;
    const caixaTela = renderer.domElement.getBoundingClientRect();
    _ndcPoder.x = ((evento.clientX - caixaTela.left) / caixaTela.width) * 2 - 1;
    _ndcPoder.y = -((evento.clientY - caixaTela.top) / caixaTela.height) * 2 + 1;
    _raioPoder.setFromCamera(_ndcPoder, camera);
    const toque = _raioPoder.intersectObject(colisor, true)[0];
    if (toque) {
      if (toque.point.distanceTo(jogador.posicao) > ALCANCE_PO) {
        recado("Longe demais para acertar o pó ali.");
      } else {
        rede.usarPoder("po", { p: paraLista(toque.point) });
        _proximoUso.po = performance.now() + ESPERAS_CACADOR.po;
      }
    }
    poderMirando = null;
    document.body.classList.remove("mirando-poder");
    refletir();
  }, true);

  refletir();
}

/** A lagartixa mais perto, para a rede. O servidor recusa acima de 16 m. */
function lagartixaMaisProxima() {
  let melhor = null;
  let dist = Infinity;
  for (const r of remotos.mapa.values()) {
    if (!r || r.papel !== "lagartixa" || r.eliminado) continue;
    const d = r.raiz.position.distanceTo(jogador.posicao);
    if (d < dist) { dist = d; melhor = r; }
  }
  return dist <= ALCANCE_REDE ? melhor : null;
}

// ------------------------------------------------------------ espectador

/**
 * Modo espectador da lagartixa encontrada.
 *
 * Ser achada tira a lagartixa da rodada de vez -- é o que dá peso à
 * camuflagem. Mas ficar olhando uma tela de "abatido" por até cinco minutos é
 * castigo, não jogo, então quem cai passa a acompanhar a caçada: voando livre
 * pelo escritório, ou pelos olhos de um dos caçadores.
 *
 * A visão do caçador é DE PROPÓSITO exclusiva de quem já saiu. Uma lagartixa
 * viva enxergando pela mira de quem a procura veria cada canto ser checado
 * antes de ser checado -- a caçada viraria impossível de ganhar. É por isso
 * que o servidor só manda a inclinação da cabeça alheia para quem está
 * eliminado: não é o botão que protege, é o dado que não chega.
 */
function mostrarCaidas() {
  const caixa = el("caidas");
  caixa.hidden = caidas.length === 0;
  const lista = caixa.querySelector("ul");
  lista.replaceChildren();
  for (const { nome, por } of caidas) {
    const item = document.createElement("li");
    item.textContent = nome;
    if (por) {
      const quem = document.createElement("span");
      quem.className = "por";
      quem.textContent = ` por ${por}`;
      item.append(quem);
    }
    lista.append(item);
  }
}

/** Os caçadores vivos, na ordem da sala, para alternar entre eles. */
function cacadoresVivos() {
  return [...remotos.mapa.values()].filter(
    (r) => r && r.papel !== "lagartixa",
  );
}

function entrarEmEspectador() {
  if (espectando) return;
  sairDoOlhar();
  el("olhar").hidden = true;
  espectando = true;

  // Nada de arma, pose ou pintura para quem saiu.
  combate?.desativar();
  cameraJogo.desativar();
  cameraJogo.pincelando = false;
  if (modoPintura) abrirAtelie(false);
  if (document.pointerLockElement) document.exitPointerLock();

  // O corpo some da própria tela; para os outros ele já sumiu no `dano`.
  if (jogador) jogador.raiz.visible = false;
  el("abatido").hidden = true;
  el("paleta").hidden = true;
  el("mira").hidden = true;
  el("espectador").hidden = false;

  cameraLivre.assumir(camera);
  trocarModoEspectador("livre");
}

function sairDeEspectador() {
  if (!espectando) return;
  espectando = false;
  revelarAvatarAssistido();
  cameraLivre.desativar();
  cacadorAssistido = null;
  el("espectador").hidden = true;
  if (jogador) jogador.raiz.visible = true;
  if (souLagartixa) el("paleta").hidden = false;
  cameraJogo.ativar();
  combate?.ativar();
}

function trocarModoEspectador(modo) {
  modoEspectador = modo;
  el("ver-livre").setAttribute("aria-pressed", String(modo === "livre"));
  el("ver-cacador").setAttribute("aria-pressed", String(modo === "cacador"));

  if (modo === "livre") {
    revelarAvatarAssistido();
    cameraLivre.assumir(camera);
    cameraLivre.ativar();
  } else {
    cameraLivre.desativar();
    const lista = cacadoresVivos();
    // Clicar de novo passa para o próximo: com vários caçadores, um botão só
    // que fixa sempre o mesmo não serviria para acompanhar a caçada.
    const i = lista.findIndex((r) => r.id === cacadorAssistido);
    const proximo = lista.length ? lista[(i + 1) % lista.length] : null;
    if (proximo?.id !== cacadorAssistido) revelarAvatarAssistido();
    cacadorAssistido = proximo?.id ?? null;
  }
  mostrarQuemAssiste();
}

let _avatarOculto = null;

function esconderAvatarAssistido(alvo) {
  if (_avatarOculto === alvo) return;
  revelarAvatarAssistido();
  _avatarOculto = alvo;
  alvo.raiz.visible = false;
}

function revelarAvatarAssistido() {
  if (!_avatarOculto) return;
  // Só devolve a visibilidade se ele ainda deveria aparecer: uma lagartixa
  // eliminada continua sumida.
  if (!_avatarOculto.eliminado) _avatarOculto.raiz.visible = true;
  _avatarOculto = null;
}

function mostrarQuemAssiste() {
  const rotulo = el("espectador").querySelector(".quem");
  if (modoEspectador !== "cacador") {
    rotulo.hidden = true;
    return;
  }
  const alvo = remotos.mapa.get(cacadorAssistido);
  rotulo.hidden = false;
  rotulo.textContent = alvo
    ? `pelos olhos de ${alvo.nome} — clique de novo para trocar`
    : "nenhum caçador na sala";
}

function configurarEspectador() {
  el("ver-livre").addEventListener("click", () => trocarModoEspectador("livre"));
  el("ver-cacador").addEventListener("click", () => trocarModoEspectador("cacador"));
}

/** Posiciona a câmera conforme o modo escolhido. */
function atualizarEspectador(dt) {
  if (modoEspectador === "livre") {
    cameraLivre.atualizar(dt);
    return;
  }

  const alvo = remotos.mapa.get(cacadorAssistido);
  if (!alvo) {
    // O caçador que estávamos vendo saiu da sala; volta para a câmera livre em
    // vez de congelar a imagem sem explicação.
    trocarModoEspectador("livre");
    return;
  }

  // O corpo de quem se assiste some, pelo mesmo motivo que ele some para o
  // próprio dono em primeira pessoa: a câmera fica DENTRO da malha, e olhar
  // para baixo mostrava o avesso do paletó dele ocupando a tela inteira.
  esconderAvatarAssistido(alvo);

  _olhosDoCacador.copy(alvo.raiz.position);
  _olhosDoCacador.y += ALTURA_OLHOS_CACADOR;
  camera.position.copy(_olhosDoCacador);
  // Mesma convenção da câmera de primeira pessoa: yaw do corpo, inclinação da
  // cabeça vinda da rede.
  // `-sin(pitch)` e não `+`: é a convenção de `atualizarPrimeiraPessoa`, onde
  // pitch positivo faz o caçador olhar para BAIXO. Com o sinal trocado, quem
  // assiste veria o teto toda vez que o caçador procurasse embaixo da mesa.
  const inclin = alvo.pitch ?? 0;
  const cp = Math.cos(inclin);
  _mira.set(
    _olhosDoCacador.x + Math.sin(alvo.raiz.rotation.y) * cp,
    _olhosDoCacador.y - Math.sin(inclin),
    _olhosDoCacador.z + Math.cos(alvo.raiz.rotation.y) * cp,
  );
  camera.lookAt(_mira);
}

const ALTURA_OLHOS_CACADOR = 1.62;
const _olhosDoCacador = new THREE.Vector3();
const _mira = new THREE.Vector3();

// ------------------------------------------------------------ rodada

const ROTULO_FASE = {
  preparo: "As lagartixas estão se escondendo",
  caca: "Caçada",
  intervalo: "Fim da rodada",
};

/** O que dizer na sala de espera depende de quem lê e do que falta. */
function rotuloDaEspera() {
  if (!podeIniciar) return "Falta alguém: é preciso uma lagartixa e um caçador";
  if (anfitriao === rede.meuId) return "Todos prontos";
  const dono = naSala.get(anfitriao);
  return dono ? `Esperando ${dono.nome} começar` : "Esperando começar";
}

/**
 * Reflete a fase na tela.
 *
 * As lagartixas somem do cenário do caçador no preparo, mas quem faz isso de
 * verdade é o servidor, que simplesmente não manda a posição delas. Aqui só
 * escondemos o avatar que já tinha sido criado ao entrar na sala -- sem isto
 * ele ficaria congelado no último lugar conhecido, que é pior do que sumir.
 */
let _faseAnterior = null;

function aplicarFase() {
  // Fim da rodada devolve o controle a quem foi eliminada; o quadro de
  // encontradas, porém, só zera na rodada SEGUINTE -- ele é o resultado da que
  // acabou, e apagá-lo no intervalo tiraria da tela justamente a informação
  // que as pessoas querem ler quando a caçada termina.
  if (faseAtual !== _faseAnterior) {
    if (faseAtual === "espera" || faseAtual === "preparo") sairDeEspectador();
    if (faseAtual === "preparo") {
      caidas.length = 0;
      mostrarCaidas();
    }
  }
  _faseAnterior = faseAtual;
  // O painel de olhar vem e vai com a rodada: reiniciar devolve a lagartixa
  // ao corpo, senão ela renasceria com a câmera parada na amiga.
  if (faseAtual === "espera" || faseAtual === "intervalo") sairDoOlhar();
  mostrarOlhar();
  // A lista da sala é desenhada quando alguém entra -- e nessa hora ainda não
  // há rodada, então nenhuma amiga saía clicável. Redesenhar na troca de fase
  // é o que liga (e desliga) o clique junto com a caçada.
  atualizarListaDaSala();

  const caixa = el("rodada");
  caixa.hidden = false;
  caixa.dataset.fase = faseAtual;
  caixa.querySelector(".fase").textContent =
    faseAtual === "espera" ? rotuloDaEspera() : (ROTULO_FASE[faseAtual] ?? faseAtual);

  // Os botões são só do anfitrião. Quem não é vê a frase dizendo de quem se
  // espera -- um botão desabilitado ali só faria a pessoa clicar sem entender.
  //
  // Um botão por fase, e não os três sempre: "começar" no vazio, "caçar agora"
  // durante o preparo, "reiniciar" com a rodada em curso.
  const souDono = anfitriao === rede.meuId;
  const comecar = el("iniciar-rodada");
  comecar.hidden = !(souDono && faseAtual === "espera");
  comecar.disabled = !podeIniciar;
  comecar.title = podeIniciar
    ? "Começar a rodada"
    : "Precisa de pelo menos uma lagartixa e um caçador";

  el("pular-preparo").hidden = !(souDono && faseAtual === "preparo");
  el("reiniciar-rodada").hidden =
    !(souDono && (faseAtual === "caca" || faseAtual === "intervalo"));

  const escondendo = faseAtual === "preparo" || faseAtual === "espera";
  for (const remoto of remotos?.mapa.values() ?? []) {
    if (remoto?.papel !== "lagartixa") continue;
    // Eliminada continua sumida. Sem esta guarda, qualquer reaplicação de fase
    // no meio da caçada -- alguém entrando na sala, por exemplo -- ressuscitava
    // na tela uma lagartixa que já tinha sido achada.
    if (remoto.eliminado) {
      remoto.raiz.visible = false;
      continue;
    }
    remoto.raiz.visible = !(escondendo && !souLagartixa);
  }
}

function configurarInicio() {
  el("iniciar-rodada").addEventListener("click", () => rede.iniciarRodada());
  el("pular-preparo").addEventListener("click", () => rede.pularPreparo());
  el("reiniciar-rodada").addEventListener("click", () => rede.reiniciarRodada());
}

function atualizarRelogio() {
  const caixa = el("rodada");
  if (caixa.hidden) return;
  const resta = Math.max(0, faseAte - performance.now());
  const seg = Math.ceil(resta / 1000);
  caixa.querySelector(".relogio").textContent =
    faseAtual === "espera" ? "--:--" : `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`;
  caixa.classList.toggle("urgente", faseAtual !== "espera" && resta > 0 && resta < 10_000);
}

// ------------------------------------------------------------ ateliê

/**
 * Modo de pintura à mão.
 *
 * Acontece dentro do jogo, com o cenário atrás: pintar a lagartixa numa tela
 * separada daria uma cor bonita e uma camuflagem ruim, porque o que importa é
 * como ela fica CONTRA a parede em que vai se grudar. A câmera chega perto, o
 * corpo para de andar, e o botão esquerdo vira pincel.
 */
let modoPintura = false;
let pegandoCor = false;
let corPincel = PALETA[0].cor;
let raioPincel = 0.018;
let _pintando = false;

const _alvoPincel = new THREE.Vector3();
const _meio = new THREE.Vector3();
let _ultimoPonto = null;
const _raioPincelada = new THREE.Raycaster();
const _ndcPincel = new THREE.Vector2();

/** O controle vai de 4 a 60; o pincel, de 4 mm a 6 cm. */
function raioDoControle(v) {
  return (Number(v) / 1000) * 1.0;
}

function ndcDoEvento(evento, saida) {
  const caixa = renderer.domElement.getBoundingClientRect();
  saida.x = ((evento.clientX - caixa.left) / caixa.width) * 2 - 1;
  saida.y = -((evento.clientY - caixa.top) / caixa.height) * 2 + 1;
  return saida;
}

function configurarAtelie() {
  const painel = el("atelie");
  const entradaCor = el("cor-pincel");
  const entradaTam = el("tamanho-pincel");
  const amostra = painel.querySelector(".amostra-pincel");
  const btnGotas = el("conta-gotas");

  const mostrarPincel = () => {
    painel.style.setProperty("--cor-pincel", corPincel);
    // O disco da amostra cresce junto, limitado à caixa de 34 px.
    amostra.style.setProperty("--tam-pincel", `${Math.min(30, Number(entradaTam.value) / 2)}px`);
  };

  const usarCor = (cor) => {
    corPincel = cor;
    entradaCor.value = cor;
    for (const b of painel.querySelectorAll(".tinta")) {
      b.setAttribute("aria-pressed", String(b.dataset.cor === cor));
    }
    mostrarPincel();
  };

  const cores = painel.querySelector(".cores-atelie");
  cores.replaceChildren();
  for (const tinta of PALETA) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "tinta";
    botao.style.setProperty("--c", tinta.cor);
    botao.dataset.cor = tinta.cor;
    botao.title = tinta.nome;
    botao.addEventListener("click", () => usarCor(tinta.cor));
    cores.append(botao);
  }

  entradaCor.addEventListener("input", () => usarCor(entradaCor.value));
  entradaTam.addEventListener("input", () => {
    raioPincel = raioDoControle(entradaTam.value);
    mostrarPincel();
  });

  const armarGotas = (sim) => {
    pegandoCor = sim;
    btnGotas.setAttribute("aria-pressed", String(sim));
    document.body.classList.toggle("pegando-cor", sim);
  };
  btnGotas.addEventListener("click", () => armarGotas(!pegandoCor));

  el("preencher-tudo").addEventListener("click", () => {
    poderes?.pintar(corPincel);
    rede.pintar(corPincel);
  });

  el("abrir-pintura").addEventListener("click", () => abrirAtelie(true));
  el("fechar-pintura").addEventListener("click", () => abrirAtelie(false));

  addEventListener("keydown", (evento) => {
    if (evento.repeat || !poderes || !andando) return;
    if (digitando || painelChat?.digitando || conversando) return;
    if (evento.code === "KeyP") abrirAtelie(!modoPintura);
    else if (evento.code === "Escape" && modoPintura) abrirAtelie(false);
  });

  // --------------------------------------------------- pincel no cenário

  const pincelar = (evento) => {
    ndcDoEvento(evento, _ndcPincel);
    _raioPincelada.setFromCamera(_ndcPincel, camera);
    const toque = _raioPincelada.intersectObject(jogador.modelo, true)[0];
    if (!toque) {
      // Saiu do corpo: o próximo ponto recomeça o traço em vez de costurar
      // uma linha reta por cima do ar.
      _ultimoPonto = null;
      return;
    }

    // Um `pointermove` a cada quadro, com a mão andando rápido, deixa buracos
    // entre as marcas. O traço é costurado ligando o ponto anterior ao atual
    // com marcas espaçadas de meio pincel.
    if (_ultimoPonto) {
      const passo = Math.max(raioPincel * 0.5, 0.002);
      const vao = _ultimoPonto.distanceTo(toque.point);
      const n = Math.min(Math.floor(vao / passo), 48);
      for (let i = 1; i <= n; i++) {
        _meio.lerpVectors(_ultimoPonto, toque.point, i / (n + 1));
        poderes.pincelar(_meio, corPincel, raioPincel);
      }
    }

    poderes.pincelar(toque.point, corPincel, raioPincel);
    _ultimoPonto = (_ultimoPonto ?? new THREE.Vector3()).copy(toque.point);
  };

  renderer.domElement.addEventListener("pointerdown", (evento) => {
    if (!modoPintura || evento.button !== 0) return;

    if (pegandoCor) {
      // O conta-gotas do ateliê pega de QUALQUER coisa: cenário, móvel, ou a
      // própria lagartixa. É o que o "Chão" não dá -- copiar o tom da parede
      // em que ela vai se encostar, não o do piso sob os pés.
      ndcDoEvento(evento, _ndcPincel);
      _raioPincelada.setFromCamera(_ndcPincel, camera);
      const toque = _raioPincelada.intersectObjects([escritorio, jogador.modelo], true)[0];
      const cor = toque && corNoToque(toque);
      if (cor) usarCor(cor);
      armarGotas(false);
      return;
    }

    _pintando = true;
    _ultimoPonto = null;
    renderer.domElement.setPointerCapture(evento.pointerId);
    pincelar(evento);
  });

  renderer.domElement.addEventListener("pointermove", (evento) => {
    if (modoPintura && _pintando) pincelar(evento);
  });

  const soltar = () => {
    if (!_pintando) return;
    _pintando = false;
    _ultimoPonto = null;
    // Só ao soltar: mandar o atlas a cada quadro do traço encheria a sala de
    // PNGs de 1024x1024.
    rede.pintarTextura(poderes.tela.paraPNG(LIMITE_TEXTURA));
  };
  addEventListener("pointerup", soltar);
  addEventListener("pointercancel", soltar);

  usarCor(corPincel);
  raioPincel = raioDoControle(entradaTam.value);
}

function abrirAtelie(sim) {
  if (!poderes || modoPintura === sim) return;
  modoPintura = sim;
  el("atelie").hidden = !sim;
  // A paleta rápida some enquanto o ateliê está aberto: os dois moram na
  // mesma lateral e o ateliê já traz as mesmas cores, com mais coisa junto.
  el("paleta").hidden = sim || !el("btn-acoes").matches('[aria-pressed="true"]');
  cameraJogo.pincelando = sim;

  if (sim) {
    // Escondida, a lagartixa fica translúcida e achatada -- péssimo para
    // pintar. Sair do esconderijo é o preço de abrir o ateliê.
    poderes.esconder(false);
    if (cameraJogo.travada) document.exitPointerLock();
    cameraJogo.distanciaPintura = 0.62;
  } else {
    _pintando = false;
    pegandoCor = false;
    el("conta-gotas").setAttribute("aria-pressed", "false");
    document.body.classList.remove("pegando-cor");
    rede.pintarTextura(poderes.tela.paraPNG(LIMITE_TEXTURA));
  }
}

// ------------------------------------------------------------ sentar

/**
 * Botão de sentar, que aparece ao chegar perto de um sofá.
 *
 * Sentar é local e imediato: o corpo é encaixado no assento e a animação
 * "Sentar" entra por cima. A rede leva só a posição, o giro e o nome da
 * animação -- os outros jogadores veem a pessoa sentada sem precisar de
 * mensagem nova, porque `Sentar` já viaja no mesmo campo de sempre.
 */
function configurarAssentos() {
  const botao = el("btn-sentar");

  const acionar = () => {
    if (!andando || conversando || digitando || !jogador || souLagartixa) return;

    if (jogador.sentado) {
      jogador.levantar();
      assentos.liberar(rede.meuId);
      return;
    }
    if (!assentoPerto) return;

    jogador.sentar(assentoPerto.ponto, assentoPerto.angulo);
    assentos.ocupar(assentoPerto.indice, rede.meuId);
    marcador.esconder();
  };

  botao.addEventListener("click", acionar);
  addEventListener("keydown", (evento) => {
    if (evento.code === "KeyF" && !evento.repeat) acionar();
    // O C mora na barra de habilidades agora (`configurarPoderes`). Tratar
    // aqui também alternava DUAS vezes por toque, o que dava em nada.
  });
}

function atualizarBotaoDeSentar() {
  const botao = el("btn-sentar");

  // A lagartixa não senta: o modelo dela só tem Parado, Andar e Esconder, e
  // sem clipe "Sentar" ela ficaria de pé, congelada, flutuando sobre o sofá --
  // além de ocupar um assento que faz falta para quem consegue usá-lo.
  if (souLagartixa) {
    assentoPerto = null;
    botao.hidden = true;
    return;
  }

  if (jogador.sentado) {
    assentoPerto = null;
    trocarIcone(botao.querySelector("i"), "levantar", 16);
    botao.querySelector("span").textContent = "Levantar";
    botao.hidden = digitando || conversando;
    return;
  }

  assentoPerto = assentos.maisProximo(jogador.posicao, rede.meuId);
  const mostrar = Boolean(assentoPerto) && !digitando && !conversando;
  if (mostrar && botao.hidden) {
    trocarIcone(botao.querySelector("i"), "sentar", 16);
    botao.querySelector("span").textContent = "Sentar";
  }
  botao.hidden = !mostrar;
}

// -------------------------------------------------- clicar e caminhar

const _raioClique = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

/** O que o clique atingiu no cenário, e se aquilo é uma superfície pisável. */
function alvoDoClique(evento) {
  const caixa = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((evento.clientX - caixa.left) / caixa.width) * 2 - 1;
  _ndc.y = -((evento.clientY - caixa.top) / caixa.height) * 2 + 1;

  _raioClique.setFromCamera(_ndc, camera);
  _raioClique.far = Infinity;
  _raioClique.firstHitOnly = true;
  const toque = _raioClique.intersectObject(colisor, true)[0];
  if (!toque) return null;

  const normal = toque.face?.normal;
  return { ponto: toque.point.clone(), horizontal: (normal?.y ?? 0) >= 0.6 };
}

const _paraBaixo = new THREE.Vector3(0, -1, 0);

/**
 * Primeiro piso abaixo de um ponto.
 *
 * O resultado é puxado 30 cm na direção do jogador antes de virar destino.
 * Um clique na parede aterrissa exatamente sobre a face dela, e essa coluna
 * não tem piso na grade -- o caminho falharia por 1 centímetro. Recuar um
 * pouco cai na célula caminhável vizinha, que é aonde a pessoa quer chegar.
 */
function chaoAbaixoDe(ponto) {
  _raioClique.set(
    new THREE.Vector3(ponto.x, ponto.y - 0.05, ponto.z),
    _paraBaixo,
  );
  _raioClique.far = 8;
  _raioClique.firstHitOnly = true;
  const toque = _raioClique.intersectObject(colisor, true)[0];
  _raioClique.far = Infinity;
  if (!toque) return null;

  const chao = toque.point.clone();
  const recuo = new THREE.Vector3(
    jogador.posicao.x - chao.x,
    0,
    jogador.posicao.z - chao.z,
  );
  if (recuo.lengthSq() > 1e-6) chao.addScaledVector(recuo.normalize(), 0.3);
  return chao;
}

function configurarCliqueParaAndar() {
  // O clique-para-andar foi removido: o mesmo botão andando e atirando
  // confundia -- você mirava num adversário, clicava, e o personagem saía
  // caminhando até ele. Movimento é WASD.
  //
  // `alvoDoClique`, `chaoAbaixoDe` e a grade de navegação continuam no código
  // e testados; religar é voltar a atribuir `cameraJogo.aoClicar` aqui.
  jogador.aoChegar = () => marcador.esconder();
}

// ----------------------------------------------------------- conversa

function configurarInteracao() {
  addEventListener("keydown", (evento) => {
    if (!andando || evento.repeat || digitando) return;
    if (evento.code !== "KeyE" || conversando) return;
    if (npc.perto) iniciarConversa();
  });
}

function iniciarConversa() {
  conversando = true;
  el("aviso-interagir").hidden = true;
  atualizarDica();
  chat.abrir();
}

function encerrarConversa() {
  if (!conversando) return;
  conversando = false;
  chat.fechar();
  atualizarDica();
}

// -------------------------------------------------------------- modos

let orbitaSalva = null;
let nearOrbita = camera.near;

function entrarNoModoAndar() {
  andando = true;
  mostrarOlhar();
  const botao = el("alternar-modo");
  botao.setAttribute("aria-pressed", "true");
  botao.textContent = "Voltar para a órbita";
  el("controles").hidden = false;
  dicaPermitida = true;
  atualizarDica();
  elDica.querySelector('[data-modo="orbita"]').hidden = true;
  elDica.querySelector('[data-modo="andar"]').hidden = false;
  el("alternar-teto").hidden = true;
  npc.raiz.visible = true;

  orbitaSalva = {
    posicao: camera.position.clone(),
    alvo: controls.target.clone(),
  };
  // O telhado FICA no jogo. Escondê-lo servia à câmera de órbita, que olha o
  // prédio de fora; andando lá dentro ele é o que impede alguém de pular no
  // topo de uma parede e ler a planta inteira do escritório de uma vez.
  alternarTeto(false);
  controls.enabled = false;
  nearOrbita = camera.near;
  camera.near = 0.05;
  camera.updateProjectionMatrix();
  cameraJogo.ativar();
}

function sairDoModoAndar() {
  andando = false;
  el("aviso-ponteiro").hidden = true;
  encerrarConversa();
  jogador?.cancelarCaminho();
  jogador?.levantar();
  assentos.liberar(rede.meuId);
  marcador?.esconder();
  el("btn-sentar").hidden = true;
  const botao = el("alternar-modo");
  botao.setAttribute("aria-pressed", "false");
  botao.textContent = "Entrar com o personagem";
  elDica.querySelector('[data-modo="orbita"]').hidden = false;
  elDica.querySelector('[data-modo="andar"]').hidden = true;
  el("alternar-teto").hidden = false;
  // A órbita volta com o prédio aberto: é para ver o interior que ela serve, e
  // sair do jogo para encarar um telhado fechado seria um passo a mais sem
  // motivo. Dentro do jogo o telhado continua fechado.
  alternarTeto(true);
  el("aviso-interagir").hidden = true;

  cameraJogo.desativar();
  controls.enabled = true;
  controls.maxDistance = raioCena * 4;
  camera.near = nearOrbita;
  camera.updateProjectionMatrix();
  camera.position.copy(orbitaSalva.posicao);
  controls.target.copy(orbitaSalva.alvo);
  controls.update();
}

function configurarModo() {
  el("alternar-modo").addEventListener("click", () => {
    if (!jogador) return;
    andando ? sairDoModoAndar() : entrarNoModoAndar();
  });
}

// --------------------------------------------------------------- loop

function animar(agora) {
  requestAnimationFrame(animar);
  const dt = Math.min(relogio.getDelta(), 0.05);

  // O indicador de "falando" precisa da faixa local, que só o dono conhece;
  // os remotos já vêm com o próprio áudio pelos elementos <audio>.
  if (midia.detector) {
    tiles?.definirFalando(rede.meuId, midia.detector.amostrar());
  }

  if (espectando) {
    atualizarEspectador(dt);
  } else if (andando && jogador) {
    const congelado =
      conversando || digitando || painelChat?.digitando || abatido || modoPintura
      // Olhando de fora, o corpo fica onde está: o WASD é da câmera agora, e
      // sem isto a lagartixa sairia andando às cegas enquanto se olha a amiga.
      || olhando !== null
      // Presa pela rede. O servidor também recusa a posição, então um cliente
      // adulterado não ganha nada ignorando isto -- aqui é só para o corpo
      // parar de verdade na tela de quem foi pego.
      || performance.now() < presoPelaRedeAte;
    let entrada = congelado ? PARADO : lerEntrada();
    if (poderes) entrada = poderes.filtrarEntrada(entrada);
    vigiarTravamento(dt, entrada);
    // Arranque: pique curto. Mexe na velocidade do corpo, não numa flag nova,
    // para o clipe de andar acompanhar sozinho.
    if (jogador.escalar) {
      const emArranque = performance.now() < arranqueAte;
      // Pose e arranque se multiplicam: dá para disparar enrolada, só que o
      // pique parte de uma velocidade já reduzida.
      const k = (emArranque ? ARRANQUE_FATOR : 1) * (poderes?.fatorDaPose ?? 1);
      jogador.velCaminhada = CORPO_LAGARTIXA.velCaminhada * k;
      jogador.velCorrida = CORPO_LAGARTIXA.velCorrida * k;
    }
    jogador.atualizar(dt, entrada, camera);
    jogador.alvoDaCamera(_alvo);

    if (primeiraPessoa) {
      // Sem o ponteiro capturado só dá para olhar arrastando o botão direito;
      // o aviso diz como entrar no modo confortável.
      const aviso = el("aviso-ponteiro");
      aviso.hidden =
        cameraJogo.travada || conversando || digitando || painelChat?.digitando;
      if (!aviso.hidden) {
        if (!cameraJogo.capturaIndisponivel) {
          aviso.querySelector("kbd").textContent = "clique";
          aviso.querySelector("span").textContent =
            "para prender o mouse e olhar em volta";
        } else if (cameraJogo.emIframe) {
          // Dentro de um iframe o navegador recusa a captura, e não há o que
          // fazer pelo código: a página precisa estar na própria aba.
          aviso.querySelector("kbd").textContent = "direito";
          aviso.querySelector("span").textContent =
            "arraste para olhar — abra em uma aba própria para prender o mouse";
        } else {
          aviso.querySelector("kbd").textContent = "direito";
          aviso.querySelector("span").textContent =
            "arraste para olhar (o navegador recusou prender o mouse)";
        }
      }

      // O próprio corpo some: em primeira pessoa a câmera fica dentro da
      // cabeça e só se veria o interior da malha. Os outros continuam vendo
      // o personagem inteiro -- isso é só o avatar local.
      jogador.raiz.visible = false;
      // E o corpo passa a encarar para onde se olha, mesmo parado, senão os
      // outros veem alguém atirando de lado.
      if (!conversando) jogador.olhandoPara = cameraJogo.direcaoNoPlano;
      el("mira").hidden = false;
    }

    // Faro: contorno dos caçadores atravessando parede, mas SÓ imóvel e
    // escondida. É para decidir se dá para deixar passar, não para fugir com
    // visão de raio-X ligada o tempo todo.
    if (faro && poderes) {
      const imovel = poderes.escondida && !entrada.frente && !entrada.tras
        && !entrada.esquerda && !entrada.direita;
      faro.atualizar(
        [...remotos.mapa.values()].filter((r) => r && r.papel !== "lagartixa"),
        imovel, jogador.posicao, FARO_ALCANCE,
      );
    }

    rede.enviarEstado(
      jogador.posicao, jogador.olhandoPara, jogador.nomeAtual,
      poderes?.escondida ?? false,
      // A inclinação só interessa a quem assiste pelos olhos alheios, e o
      // servidor só a repassa a esses; mandar sempre é mais simples do que
      // condicionar o envio, e custa dois bytes.
      cameraJogo.pitch,
      // Escalando, o corpo não cabe num ângulo só; os outros precisam da
      // normal da superfície para desenhar a lagartixa deitada na parede.
      jogador.escalar ? jogador.cima : null,
      jogador.escalar ? jogador.frente : null,
    );

    // Em terceira pessoa (lagartixa) a cruz só aparece ao mirar.
    if (!primeiraPessoa) el("mira").hidden = !combate.mirando;

    const perto = npc.atualizar(dt, jogador.posicao);
    if (conversando) {
      npc.alvoDoRosto(_alvoNpc);
      cameraJogo.enquadrarConversa(dt, _alvoNpc, jogador.posicao);
      if (!perto) encerrarConversa();
    } else if (modoPintura) {
      // Alvo próprio: o da câmera de jogo fica 35 cm acima dos pés, o que num
      // bicho de 26 cm deixa o corpo pendurado na borda de baixo da tela.
      _alvoPincel.copy(jogador.posicao);
      _alvoPincel.y += CORPO_LAGARTIXA.altura * 0.4;
      cameraJogo.enquadrarPintura(dt, _alvoPincel, cameraJogo.distanciaPintura);
      el("aviso-interagir").hidden = true;
    } else if (olhando !== null) {
      atualizarOlhar(dt);
      el("aviso-interagir").hidden = true;
    } else if (primeiraPessoa) {
      cameraJogo.atualizarPrimeiraPessoa(dt, jogador.posicao);
      el("aviso-interagir").hidden = !perto || digitando || painelChat?.digitando;
      atualizarBotaoDeSentar();
    } else {
      if (combate.mirando) cameraJogo.enquadrarMira(dt, _alvo);
      else cameraJogo.atualizar(dt, _alvo);
      el("aviso-interagir").hidden = !perto || digitando || painelChat?.digitando;
      atualizarBotaoDeSentar();
    }
    balaoProprio?.atualizar(camera);
    marcador?.atualizar();

    // Poderes de quem caça: os efeitos rodam para os dois lados (a lagartixa
    // precisa ver a nuvem e o sensor), mas a lanterna e a barra só existem de
    // um lado.
    batidas?.atualizar(dt);
    redesVoando?.atualizar(dt, camera);
    sensores?.atualizar(dt);
    pegadas?.atualizar();
    nuvens?.atualizar(dt);
    if (lanterna) {
      lanterna.atualizar(dt, !escuridao?.escuro);
      atualizarBateria();
      // Andar cancela a conjuração do disjuntor -- o servidor já decide isso;
      // aqui só apagamos a barra para não ficar mentindo na tela.
      if (conjurandoAte && (entrada.frente || entrada.tras || entrada.esquerda || entrada.direita)) {
        conjurandoAte = 0;
      }
      atualizarConjuracao();
    }
    // A lista mostra a distância de cada amiga, que muda o tempo todo. Duas
    // vezes por segundo chega para ler e não repinta o painel a 60 Hz.
    _olharDesde += dt;
    if (_olharDesde > 0.5) { _olharDesde = 0; if (!el("olhar").hidden || podeOlhar()) mostrarOlhar(); }
  } else {
    controls.update();
  }

  // Fora do ramo de caminhada: rastros de tiros de OUTROS chegam mesmo com a
  // câmera em órbita, e sem isto ficariam acesos para sempre.
  sincronizarPoses();
  _refletirPoderes?.();
  _refletirCacador();
  // Os marcadores de interruptor são informação de lagartixa: o caçador não
  // precisa saber onde ela pode apagar a luz.
  interruptores?.atualizar(dt, Boolean(poderes) && andando, camera, jogador?.posicao);
  caudas?.atualizar(dt);
  pedras?.atualizar(dt);
  cuspeNaTela?.atualizar();
  escuridao?.atualizar();
  atualizarRecado();
  atualizarRelogio();
  explosoes?.atualizar(dt);
  combate?.atualizarProjeteis(dt);
  combate?.atualizarRastros();
  remotos?.atualizar(dt, camera);
  renderer.render(scene, camera);
  atualizarHud(agora);
}

carregar().catch((erro) => {
  console.error(erro);
  mostrarErro(
    `${erro.message}\n\nOs modelos vêm dos FBX. Se faltarem em public/models/, rode: npm run convert && npm run convert:personagem && npm run convert:npc`,
  );
});

if (import.meta.env.DEV) {
  window.__jogo = {
    palco, rede, naSala, lobby,
    // Getters, não valores: este objeto é montado na avaliação do módulo,
    // quando quase tudo ainda é null.
    midia, assentos,
    get remotos() { return remotos; },
    get combate() { return combate; },
    get poderes() { return poderes; },
    get souLagartixa() { return souLagartixa; },
    get abatido() { return abatido; },
    get grade() { return grade; },
    get marcador() { return marcador; },
    get explosoes() { return explosoes; },
    get assobios() { return assobios; },
    get caudas() { return caudas; },
    get interruptores() { return interruptores; },
    get pedras() { return pedras; },
    // Poderes de quem caça, para inspeção.
    get lanterna() { return lanterna; },
    get batidas() { return batidas; },
    get sensores() { return sensores; },
    get pegadas() { return pegadas; },
    get nuvens() { return nuvens; },
    get redesVoando() { return redesVoando; },
    get espectador() { return { espectando, modoEspectador, cacadorAssistido, caidas }; },
    THREE,
    get escritorio() { return escritorio; },
    get fase() { return { fase: faseAtual, ate: faseAte }; },
    get colisor() { return colisor; },
    get malha() { return malha; },
    get tiles() { return tiles; },
    get painelChat() { return painelChat; },
    get jogador() { return jogador; },
    get npc() { return npc; },
    get chat() { return chat; },
    get cameraJogo() { return cameraJogo; },
    get andando() { return andando; },
    get conversando() { return conversando; },
  };
}
