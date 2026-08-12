import * as THREE from "three";

/**
 * Poderes da lagartixa: esconder e se pintar.
 *
 * O corpo em si é um `Jogador` comum, só com cápsula e velocidades de bicho
 * pequeno. O que muda é o que ela pode fazer.
 *
 * **Pintar** é literalmente trocar a cor do material. O modelo foi feito com
 * um material único de cor chapada exatamente para isso -- num personagem com
 * atlas de textura, "mudar de cor" exigiria repintar regiões de UV.
 *
 * **Esconder** achata o bicho no chão, trava o movimento e deixa o corpo
 * translúcido. A translucidez é o efeito de camuflagem: quanto mais parecida a
 * cor escolhida com o fundo, menos ela se destaca -- e é aí que pintar vira
 * decisão de jogo em vez de enfeite.
 */

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
};

const OPACIDADE_ESCONDIDA = 0.35;

export class PoderesDaLagartixa {
  constructor(jogador) {
    this.jogador = jogador;
    this.escondida = false;
    this.cor = PALETA[0].cor;

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

  pintar(cor) {
    this.cor = cor;
    for (const m of this.materiais) m.color.set(cor);
  }

  esconder(sim) {
    if (this.escondida === sim) return;
    this.escondida = sim;

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
    if (!this.escondida) return entrada;
    const mexeu =
      entrada.frente || entrada.tras || entrada.esquerda || entrada.direita ||
      entrada.pular;
    if (mexeu) this.esconder(false);
    return this.escondida ? { ...entrada, frente: false, tras: false,
      esquerda: false, direita: false, pular: false } : entrada;
  }
}

/** Aplica cor e transparência num avatar remoto de lagartixa. */
export function pintarRemoto(raiz, cor, escondida) {
  raiz.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || /olho/i.test(m.name)) continue;
      if (cor) m.color.set(cor);
      m.transparent = true;
      m.opacity = escondida ? OPACIDADE_ESCONDIDA : 1;
      m.depthWrite = !escondida;
    }
  });
}
