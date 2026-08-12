import * as THREE from "three";
import "./style.css";
import { criarPalco, enquadrar } from "./scene.js";
import { carregarEscritorio, carregarPersonagem } from "./carregarModelo.js";
import { construirColisor, encontrarNascimento } from "./colisor.js";
import { Jogador, criarEntrada } from "./jogador.js";
import { CameraTerceiraPessoa } from "./cameraTerceiraPessoa.js";
import { Npc, PERSONA, encontrarPontoParaNpc } from "./npc.js";
import { Chat } from "./chat.js";
import { Lobby } from "./lobby.js";
import { Rede } from "./rede.js";
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
import { PoderesDaLagartixa, PALETA, CORPO as CORPO_LAGARTIXA, pintarRemoto } from "./lagartixa.js";

montarIcones();

const palco = criarPalco(document.getElementById("palco"));
const { renderer, scene, camera, controls } = palco;

const el = (id) => document.getElementById(id);
const elCarregando = el("carregando");
const elErro = el("erro");
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
let poderes = null;      // só existe quando se joga de lagartixa
let souLagartixa = false;
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
  scene.add(colisor);
  nascimento = encontrarNascimento(colisor);

  mostrarEtapa("Mapeando o caminhável");
  await new Promise((r) => setTimeout(r, 0));
  grade = new GradeDeNavegacao(colisor);
  console.info("[navegação]", grade.construir());
  console.info("[assentos]", await assentos.carregar(), "lugares");

  cameraJogo = new CameraTerceiraPessoa(camera, renderer.domElement, colisor);
  marcador = new MarcadorDeDestino(scene);
  combate = new Combate(scene, camera, colisor, renderer.domElement);
  await combate.carregarArma().catch((e) =>
    console.warn("[combate] arma não carregou:", e.message),
  );
  remotos = new JogadoresRemotos(scene, renderer);

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

  const { modelo, clipes } = await carregarPersonagem(
    renderer,
    souLagartixa
      ? "/models/lagartixa.glb"
      : `/models/personagens/${pedido.perfil.personagem}.glb`,
  );

  jogador = new Jogador(
    modelo, clipes, colisor,
    souLagartixa ? CORPO_LAGARTIXA : {},
  );

  if (souLagartixa) {
    poderes = new PoderesDaLagartixa(jogador);
  } else {
    // A arma vira filha do osso da mão e acompanha a animação sozinha.
    combate.equipar(modelo);
  }
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
    if (remoto) pintarRemoto(remoto.raiz, cor, remoto.escondido);
  };

  rede.aoDisparo = ({ o, f }) => {
    combate.desenharRastro(
      new THREE.Vector3(o[0], o[1], o[2]),
      new THREE.Vector3(f[0], f[1], f[2]),
    );
  };

  rede.aoDano = ({ alvo, vida }) => {
    const perfil = naSala.get(alvo);
    if (perfil) perfil.vida = vida;
    if (alvo !== rede.meuId) return;

    combate.vida = vida;
    if (!souLagartixa) pintarVida();
    piscarDano();

    if (vida === 0) {
      abatido = true;
      el("abatido").hidden = false;
      jogador?.cancelarCaminho();
      poderes?.esconder(false);
    }
  };

  rede.aoReviver = ({ alvo, vida }) => {
    const perfil = naSala.get(alvo);
    if (perfil) perfil.vida = vida;
    if (alvo !== rede.meuId) return;

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

function configurarMidia() {
  const botoes = {
    microfone: el("btn-microfone"),
    camera: el("btn-camera"),
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
  cameraJogo.aoClicar = () => combate.puxarGatilho();
  cameraJogo.aoTocarDireito = () => combate.puxarGatilho();
  cameraJogo.aoMirar = (sim) => combate.definirMira(sim);
  // Todo disparo é anunciado, mesmo errando: o rastro é o que conta.
  combate.aoAtirar = (boca, fim, alvoId) => rede.atirar(alvoId, boca, fim);
  combate.aoAcertar = () => {};
  combate.ativar();

  if (souLagartixa) {
    el("paleta").hidden = false;
    montarPaleta();
  } else {
    el("vida").hidden = false;
    pintarVida();
  }
}

function montarPaleta() {
  const cores = el("paleta").querySelector(".cores");
  cores.replaceChildren();
  for (const tinta of PALETA) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "tinta";
    botao.style.setProperty("--c", tinta.cor);
    botao.dataset.cor = tinta.cor;
    botao.title = tinta.nome;
    botao.setAttribute("aria-pressed", String(tinta.cor === poderes.cor));
    botao.addEventListener("click", () => {
      poderes.pintar(tinta.cor);
      rede.pintar(tinta.cor);
      for (const outro of cores.children) {
        outro.setAttribute("aria-pressed", String(outro.dataset.cor === tinta.cor));
      }
    });
    cores.append(botao);
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
    if (!andando || conversando || digitando || !jogador) return;

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
    if (evento.code === "KeyC" && !evento.repeat && poderes && andando
        && !digitando && !painelChat?.digitando && !conversando) {
      poderes.esconder(!poderes.escondida);
    }
  });
}

function atualizarBotaoDeSentar() {
  const botao = el("btn-sentar");

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
  elDica.hidden = true;
  chat.abrir();
}

function encerrarConversa() {
  if (!conversando) return;
  conversando = false;
  chat.fechar();
  elDica.hidden = false;
}

// -------------------------------------------------------------- modos

let orbitaSalva = null;
let nearOrbita = camera.near;

function entrarNoModoAndar() {
  andando = true;
  const botao = el("alternar-modo");
  botao.setAttribute("aria-pressed", "true");
  botao.textContent = "Voltar para a órbita";
  el("controles").hidden = false;
  elDica.hidden = false;
  elDica.querySelector('[data-modo="orbita"]').hidden = true;
  elDica.querySelector('[data-modo="andar"]').hidden = false;
  el("alternar-teto").hidden = true;
  npc.raiz.visible = true;

  orbitaSalva = {
    posicao: camera.position.clone(),
    alvo: controls.target.clone(),
  };
  alternarTeto(true);
  controls.enabled = false;
  nearOrbita = camera.near;
  camera.near = 0.05;
  camera.updateProjectionMatrix();
  cameraJogo.ativar();
}

function sairDoModoAndar() {
  andando = false;
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

  if (andando && jogador) {
    const congelado =
      conversando || digitando || painelChat?.digitando || abatido;
    let entrada = congelado ? PARADO : lerEntrada();
    if (poderes) entrada = poderes.filtrarEntrada(entrada);
    jogador.atualizar(dt, entrada, camera);
    jogador.alvoDaCamera(_alvo);

    rede.enviarEstado(
      jogador.posicao, jogador.olhandoPara, jogador.nomeAtual,
      poderes?.escondida ?? false,
    );

    // A cruz de mira só aparece com o botão direito pressionado.
    el("mira").hidden = !combate.mirando;

    const perto = npc.atualizar(dt, jogador.posicao);
    if (conversando) {
      npc.alvoDoRosto(_alvoNpc);
      cameraJogo.enquadrarConversa(dt, _alvoNpc, jogador.posicao);
      if (!perto) encerrarConversa();
    } else {
      if (combate.mirando) cameraJogo.enquadrarMira(dt, _alvo);
      else cameraJogo.atualizar(dt, _alvo);
      el("aviso-interagir").hidden = !perto || digitando || painelChat?.digitando;
      atualizarBotaoDeSentar();
    }
    balaoProprio?.atualizar(camera);
    marcador?.atualizar();
  } else {
    controls.update();
  }

  // Fora do ramo de caminhada: rastros de tiros de OUTROS chegam mesmo com a
  // câmera em órbita, e sem isto ficariam acesos para sempre.
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
