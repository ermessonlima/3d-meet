import * as THREE from "three";

/**
 * Assentos do cenário: sofás, bancos e poltronas.
 *
 * As posições vêm de `public/models/assentos.json`, extraído do FBX durante a
 * conversão. Não dá para descobrir isso em runtime: o cenário é fundido por
 * material, então "um sofá" deixa de existir como objeto -- some o nome e some
 * a transformação individual. Quem sabe onde eles estão é o Blender, antes da
 * fusão.
 */

const CAMINHO = "/models/assentos.json";

// Distância para o botão de sentar aparecer.
const ALCANCE = 2.2;

/**
 * Quanto o personagem fica À FRENTE do centro do assento.
 *
 * A raiz do personagem são os PÉS. Na animação de sentar, o quadril recua
 * 0.22 m em relação a ela -- é assim que o bumbum cai sobre a almofada com os
 * pés no chão. Somando a profundidade do encosto, 0.34 m põe o quadril sobre a
 * almofada em vez de dentro do estofado.
 */
const RECUO = 0.34;

export class Assentos {
  constructor() {
    this.lista = [];
    this.ocupados = new Map(); // índice do assento -> id do jogador
  }

  async carregar() {
    try {
      const resposta = await fetch(CAMINHO);
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const bruto = await resposta.json();

      this.lista = bruto.map((a, i) => {
        const frente = new THREE.Vector3(...a.frente).setY(0).normalize();
        const centro = new THREE.Vector3(...a.posicao);
        return {
          indice: i,
          nome: a.nome,
          centro,
          frente,
          // Onde os pés ficam, e para onde o corpo olha.
          ponto: centro.clone().addScaledVector(frente, RECUO),
          angulo: Math.atan2(frente.x, frente.z),
        };
      });
    } catch (erro) {
      // Sem assentos o jogo continua inteiro; só o botão de sentar some.
      console.warn("[assentos] não foi possível carregar:", erro.message);
      this.lista = [];
    }
    return this.lista.length;
  }

  /** Assento livre mais próximo dentro do alcance, ou null. */
  maisProximo(posicao, meuId) {
    let melhor = null;
    for (const assento of this.lista) {
      const dono = this.ocupados.get(assento.indice);
      if (dono && dono !== meuId) continue;

      const d = assento.ponto.distanceTo(posicao);
      if (d <= ALCANCE && (!melhor || d < melhor.d)) melhor = { assento, d };
    }
    return melhor?.assento ?? null;
  }

  ocupar(indice, id) {
    this.ocupados.set(indice, id);
  }

  liberar(id) {
    for (const [indice, dono] of this.ocupados) {
      if (dono === id) this.ocupados.delete(indice);
    }
  }

  por(indice) {
    return this.lista[indice] ?? null;
  }
}
