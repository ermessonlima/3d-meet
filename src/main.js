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
import {
  PoderesDaLagartixa,
  PALETA,
  CORPO as CORPO_LAGARTIXA,
  pintarRemoto,
  corDoChao,
  corNoToque,
  POSES,
} from "./lagartixa.js";

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
let explosoes = null;
let poderes = null;      // só existe quando se joga de lagartixa
let assobios = null;
let faseAtual = "espera";
let faseAte = 0;
let anfitriao = null;
let podeIniciar = false;
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
  scene.add(colisor);
  nascimento = encontrarNascimento(colisor);

  mostrarEtapa("Mapeando o caminhável");
  await new Promise((r) => setTimeout(r, 0));
  grade = new GradeDeNavegacao(colisor);
  console.info("[navegação]", grade.construir());
  console.info("[assentos]", await assentos.carregar(), "lugares");

  cameraJogo = new CameraTerceiraPessoa(camera, renderer.domElement, colisor);
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
  remotos.aoCriar = (remoto) => {
    if (remoto.papel !== "lagartixa") return;
    // A voz mora no avatar: é isso que faz o assobio vir da direção certa.
    assobios.registrar(remoto.id, remoto.raiz);
    // Um avatar que carregou durante o preparo já nasce escondido do caçador.
    if ((faseAtual === "preparo" || faseAtual === "espera") && !souLagartixa) {
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
    souLagartixa ? CORPO_LAGARTIXA : {},
  );

  if (souLagartixa) {
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

  rede.aoAssobio = (id) => assobios?.tocar(id);

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
      abatido = true;
      el("abatido").hidden = false;
      jogador?.cancelarCaminho();
      poderes?.esconder(false);
    }
  };

  rede.aoReviver = ({ alvo, vida }) => {
    const perfil = naSala.get(alvo);
    if (perfil) perfil.vida = vida;
    const remoto = remotos.mapa.get(alvo);
    if (remoto) remoto.raiz.visible = true;
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
  configurarInicio();
  aplicarFase();
  if (souLagartixa) {
    // A própria lagartixa ouve o próprio assobio: sem isso ela não tem como
    // saber que acabou de se entregar e que é hora de mudar de canto.
    assobios.registrar(rede.meuId, jogador.raiz);
    el("paleta").hidden = false;
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
    else painelChat?.avisoDoSistema("Nada embaixo para copiar a cor.");
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
  const caixa = el("paleta").querySelector(".poses");
  caixa.replaceChildren();

  const refletir = () => {
    for (const b of caixa.children) {
      b.setAttribute("aria-pressed", String(b.dataset.pose === poderes.pose));
    }
  };

  const aplicar = (nome) => {
    if (!poderes) return;
    poderes.posar(nome);
    refletir();
  };

  for (const pose of POSES) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "pose";
    botao.dataset.pose = pose.nome;
    botao.title = `${pose.rotulo} — ${pose.dica}`;
    botao.setAttribute("aria-label", pose.rotulo);
    botao.setAttribute("aria-pressed", "false");
    // `dataset` é DOMStringMap e não aceita atribuição em bloco; tem que ser
    // atributo a atributo.
    const marca = document.createElement("i");
    marca.dataset.icone = pose.icone;
    marca.dataset.tamanho = "15";
    botao.append(marca);
    botao.addEventListener("click", () => aplicar(pose.nome));
    caixa.append(botao);
  }
  montarIcones(caixa);

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
  // compara e só redesenha na mudança -- um `setInterval` cegamente repintando
  // os botões 4x por segundo custaria mais do que a checagem.
  _refletirPoses = refletir;
}

let _refletirPoses = null;
let _poseMostrada = null;

function sincronizarPoses() {
  if (!poderes || poderes.pose === _poseMostrada) return;
  _poseMostrada = poderes.pose;
  _refletirPoses?.();
}

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
function aplicarFase() {
  const caixa = el("rodada");
  caixa.hidden = false;
  caixa.dataset.fase = faseAtual;
  caixa.querySelector(".fase").textContent =
    faseAtual === "espera" ? rotuloDaEspera() : (ROTULO_FASE[faseAtual] ?? faseAtual);

  // O botão é só do anfitrião. Quem não é vê a frase dizendo de quem se espera
  // -- um botão desabilitado ali só faria a pessoa clicar sem entender.
  const botao = el("iniciar-rodada");
  const meu = faseAtual === "espera" && anfitriao === rede.meuId;
  botao.hidden = !meu;
  botao.disabled = !podeIniciar;
  botao.title = podeIniciar
    ? "Começar a rodada"
    : "Precisa de pelo menos uma lagartixa e um caçador";

  const escondendo = faseAtual === "preparo" || faseAtual === "espera";
  for (const remoto of remotos?.mapa.values() ?? []) {
    if (remoto?.papel !== "lagartixa") continue;
    remoto.raiz.visible = !(escondendo && !souLagartixa);
  }
}

function configurarInicio() {
  el("iniciar-rodada").addEventListener("click", () => rede.iniciarRodada());
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
    if (evento.code === "KeyC" && !evento.repeat && poderes && andando
        && !digitando && !painelChat?.digitando && !conversando) {
      poderes.esconder(!poderes.escondida);
    }
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
      conversando || digitando || painelChat?.digitando || abatido || modoPintura;
    let entrada = congelado ? PARADO : lerEntrada();
    if (poderes) entrada = poderes.filtrarEntrada(entrada);
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

    rede.enviarEstado(
      jogador.posicao, jogador.olhandoPara, jogador.nomeAtual,
      poderes?.escondida ?? false,
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
  } else {
    controls.update();
  }

  // Fora do ramo de caminhada: rastros de tiros de OUTROS chegam mesmo com a
  // câmera em órbita, e sem isto ficariam acesos para sempre.
  sincronizarPoses();
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
