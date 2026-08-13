import * as THREE from "three";

import { TelaDePintura, isolarMateriais, garantirUV } from "./pinturaLagartixa.js";

/**
 * Poderes da lagartixa: esconder e se pintar.
 *
 * O corpo em si é um `Jogador` comum, só com cápsula e velocidades de bicho
 * pequeno. O que muda é o que ela pode fazer.
 *
 * **Pintar** é desenhar num atlas de textura próprio (veja `pinturaLagartixa`).
 * Escolher uma cor chapada é só o caso simples: preencher o atlas inteiro. Por
 * cima disso dá para passar o pincel à mão, que é o que permite imitar um
 * padrão do cenário em vez de virar uma mancha lisa de cor única.
 *
 * **Esconder** achata o bicho no chão, trava o movimento e deixa o corpo
 * translúcido. A translucidez é o efeito de camuflagem: quanto mais parecida a
 * cor escolhida com o fundo, menos ela se destaca -- e é aí que pintar vira
 * decisão de jogo em vez de enfeite.
 */

/**
 * Poses de silhueta.
 *
 * Não são enfeite: o que denuncia a lagartixa de longe não é a cor, é o
 * CONTORNO. Um vulto com quatro patas e cauda salta aos olhos mesmo pintado da
 * cor exata do carpete. Cada pose troca esse contorno por outro que combina
 * com um tipo de canto do escritório.
 */
/**
 * O quanto cada pose atrasa o passo.
 *
 * Manter a silhueta andando tem que custar alguma coisa, senão não haveria
 * motivo para largá-la: rastejar deitada é mais lento do que correr solta, e
 * andar enrolada, mais ainda. É o que mantém a escolha viva em vez de existir
 * uma postura sempre melhor.
 */
export const VELOCIDADE_DA_POSE = {
  EmPe: 0.62,
  Deitada: 0.5,
  Encolhida: 0.38,
};

/**
 * Enquadramentos da câmera.
 *
 * Jogar rente ao chão num escritório cheio de móveis é difícil de enxergar: às
 * vezes o que falta é distância, às vezes é estar DENTRO do bicho. Em vez de
 * escolher um compromisso só, a pessoa escolhe.
 */
export const CAMERAS = [
  {
    id: "normal",
    rotulo: "Normal",
    dica: "Atrás e perto. O enquadramento padrão.",
    distancia: 1.7,
    alvo: 0.35,
    ombro: { lado: 0, altura: 0 },
  },
  {
    id: "afastada",
    rotulo: "Afastada",
    dica: "Mais longe e por cima do ombro: a lagartixa fica no canto e sobra cômodo à frente.",
    distancia: 3.2,
    alvo: 0.5,
    ombro: { lado: 0.55, altura: 0.35 },
  },
  {
    id: "primeira",
    rotulo: "Primeira pessoa",
    dica: "Pelos olhos dela, a 18 cm do chão. Enxerga pouco, mas enxerga o que ela enxerga.",
    primeiraPessoa: true,
    alturaDosOlhos: 0.18,
  },
];

export const POSES = [
  {
    nome: "EmPe",
    rotulo: "Em pé",
    icone: "pose-em-pe",
    dica: "Empinada: enxerga por cima dos móveis, mas é a silhueta mais visível",
  },
  {
    nome: "Deitada",
    rotulo: "Deitada",
    icone: "pose-deitada",
    dica: "Espichada e baixa: some em rodapés e emendas do carpete",
  },
  {
    nome: "Encolhida",
    rotulo: "Encolhida",
    icone: "pose-encolhida",
    dica: "Enrolada: vira mais um objeto no meio da tralha",
  },
];

export const PALETA = [
  { nome: "Verde", cor: "#5f9e4a" },
  { nome: "Bege", cor: "#c8b285" },
  { nome: "Cinza", cor: "#8b8f96" },
  { nome: "Azul", cor: "#5b7fb4" },
  { nome: "Vermelho", cor: "#b8574e" },
  { nome: "Roxo", cor: "#8a6bb1" },
];

// Medidas do bicho, usadas na cápsula de colisão e na câmera.
export const CORPO = {
  raio: 0.13,
  altura: 0.26,
  velCaminhada: 3.1,   // pequena, mas rápida: é a vantagem dela
  velCorrida: 5.4,
  avancoPorCiclo: 0.42, // o clipe "Andar" dela cobre pouco chão por ciclo
  impulsoPulo: 4.2,
  alvoCamera: 0.35,     // a câmera mira o corpo, não a cabeça de uma pessoa
  // Braço de câmera curto. Os 5 m que servem a uma pessoa de 1,8 m ao ar livre
  // viram um problema num bicho de 26 cm dentro de um cômodo de 2,8 m de
  // pé-direito e cheio de móveis: a 35 cm do chão, quase tudo fica entre a
  // lente e o bicho. Medindo o mesmo percurso, a lente passa 79% do tempo
  // obstruída a 2,2 m e 45% a 1,7 m. Subir o alvo não ajuda (volta a 77%):
  // aproxima a lente das tampas de mesa e do teto.
  distanciaCamera: 1.7,
};

const OPACIDADE_ESCONDIDA = 0.35;

export class PoderesDaLagartixa {
  constructor(jogador) {
    this.jogador = jogador;
    this.escondida = false;
    this.pose = null;
    this.cor = PALETA[0].cor;

    // A tela vem PRIMEIRO: ela clona os materiais (o GLB traz um só para as
    // 11 caixas) e é dessas cópias que a lista de opacidade abaixo precisa.
    // Coletar antes deixaria `esconder` mexendo nos materiais compartilhados,
    // apagando as outras lagartixas da sala junto.
    this.tela = new TelaDePintura(jogador.modelo);

    // Só os materiais do corpo mudam de cor; os olhos ficam pretos.
    this.materiais = [];
    jogador.modelo.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        // Transparência é preparada agora: ligar `transparent` depois obriga
        // o three a recompilar o shader, e isso engasga no meio do jogo.
        m.transparent = true;
        m.opacity = 1;
        if (!/olho/i.test(m.name)) this.materiais.push(m);
      }
    });

    this.pintar(this.cor);
  }

  /** Cor chapada: preenche o atlas inteiro, apagando o que foi pintado à mão. */
  pintar(cor) {
    this.cor = cor;
    this.tela.preencher(cor);
  }

  /** Multiplicador de velocidade da pose atual (1 quando não há pose). */
  get fatorDaPose() {
    return VELOCIDADE_DA_POSE[this.pose] ?? 1;
  }

  /** Uma pincelada no corpo, em coordenadas do mundo. */
  pincelar(ponto, cor, raio) {
    return this.tela.pincelar(ponto, cor, raio);
  }

  /**
   * Escolhe (ou desfaz) uma pose de silhueta.
   *
   * Pose e esconderijo são exclusivos: "Esconder" também é uma pose, e as duas
   * disputariam o mesmo `poseFixa`. Escolher uma postura, portanto, sai do
   * esconderijo -- o que é honesto, porque as duas coisas fazem trabalhos
   * diferentes: a pose muda o contorno, o esconderijo trava e deixa translúcido.
   */
  posar(nome) {
    const alvo = this.pose === nome ? null : nome;
    if (alvo) this.esconder(false);
    this.pose = alvo;
    this.jogador.poseFixa = alvo;
    return alvo;
  }

  esconder(sim) {
    if (this.escondida === sim) return;
    this.escondida = sim;
    if (sim) this.pose = null;

    for (const m of this.materiais) {
      m.opacity = sim ? OPACIDADE_ESCONDIDA : 1;
      m.depthWrite = !sim;
    }
    this.jogador.cancelarCaminho();
    // Pose fixa em vez de troca direta: a máquina de animação roda todo quadro
    // e devolveria "Parado" no frame seguinte.
    this.jogador.poseFixa = sim ? "Esconder" : null;
  }

  /** Entrada neutralizada enquanto escondida: mover revelaria de graça. */
  filtrarEntrada(entrada) {
    const mexeu =
      entrada.frente || entrada.tras || entrada.esquerda || entrada.direita ||
      entrada.pular;

    // Andar NÃO desfaz mais a pose: cada uma tem o seu par que caminha, então
    // a silhueta escolhida continua de pé enquanto o bicho se desloca. O preço
    // é a velocidade, que cai conforme a postura (veja `fatorDaPose`).

    if (!this.escondida) return entrada;
    if (mexeu) this.esconder(false);
    return this.escondida ? { ...entrada, frente: false, tras: false,
      esquerda: false, direita: false, pular: false } : entrada;
  }
}

/**
 * Conta-gotas: devolve a cor do cenário logo abaixo de um ponto.
 *
 * É a ferramenta que faz a camuflagem valer a pena -- em vez de adivinhar qual
 * das cores prontas chega perto do carpete, a lagartixa copia a cor exata do
 * chão em que está.
 *
 * O raio é lançado contra o cenário VISÍVEL, não contra o colisor: o colisor
 * teve todos os atributos menos `position` removidos para a BVH ficar leve, e
 * sem `uv` não há como saber que ponto do atlas foi atingido.
 */
export function corDoChao(cenario, ponto, THREE) {
  const raio = new THREE.Raycaster(
    new THREE.Vector3(ponto.x, ponto.y + 0.4, ponto.z),
    new THREE.Vector3(0, -1, 0),
    0,
    3,
  );
  const toque = raio.intersectObject(cenario, true)[0];
  return toque ? corNoToque(toque) : null;
}

/**
 * A cor da superfície num ponto atingido por um raio.
 *
 * Serve tanto ao conta-gotas do chão quanto ao do ateliê, que pode clicar em
 * qualquer coisa da cena.
 */
export function corNoToque(toque) {
  const textura = toque.object.material?.map;
  const imagem = textura?.image;
  if (!imagem) {
    // Material de cor chapada (vidro, cromo): a própria cor já serve.
    const c = toque.object.material?.color;
    return c ? `#${c.getHexString()}` : null;
  }

  if (!toque.uv) return null;
  const uv = toque.uv;
  // O atlas do escritório é 4096x4096 e as cores são swatches pequenos
  // encostados uns nos outros: errar o texel por pouco devolve uma cor que não
  // tem nada a ver com a superfície pisada.
  //
  // Em glTF as texturas vêm com `flipY = false`, ou seja, a origem do UV é o
  // canto SUPERIOR esquerdo -- a mesma do canvas. Inverter V aqui (o reflexo
  // natural, porque é o padrão do three.js fora do glTF) jogava a amostra para
  // o outro extremo da imagem.
  const y = textura.flipY ? 1 - uv.y : uv.y;
  const px = Math.min(imagem.width - 1, Math.max(0, Math.floor(uv.x * imagem.width)));
  const py = Math.min(imagem.height - 1, Math.max(0, Math.floor(y * imagem.height)));

  // Recorta só o pixel que interessa. Rasterizar o atlas inteiro custaria 64 MB
  // de canvas para ler quatro bytes.
  if (!corDoChao._ctx) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    corDoChao._ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = corDoChao._ctx;
  ctx.clearRect(0, 0, 1, 1);
  ctx.drawImage(imagem, px, py, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Aplica cor e transparência num avatar remoto de lagartixa. */
export function pintarRemoto(raiz, cor, escondida) {
  raiz.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || /olho/i.test(m.name)) continue;
      // Com atlas de pintura a cor MULTIPLICA a textura: aplicar a cor chapada
      // por cima tingiria o desenho inteiro. Quem tem textura já se pintou à
      // mão, e essa pintura manda.
      if (cor && !m.map) m.color.set(cor);
      m.transparent = true;
      m.opacity = escondida ? OPACIDADE_ESCONDIDA : 1;
      m.depthWrite = !escondida;
    }
  });
}
