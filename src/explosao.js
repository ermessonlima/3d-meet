import * as THREE from "three";

/**
 * Explosão em pedaços, para quando alguém é atingido.
 *
 * São cubinhos com velocidade inicial aleatória, gravidade e desvanecimento --
 * nada de sistema de partículas com textura. Num cenário todo facetado como
 * este, estilhaço poligonal combina melhor do que uma nuvem borrada, e custa
 * uma geometria compartilhada mais N matrizes.
 *
 * A cor vem de quem explodiu: a lagartixa pintada de vermelho estoura em
 * vermelho. É o que faz o efeito parecer *daquele* personagem e não um efeito
 * genérico colado por cima.
 */

const GRAVIDADE = -14;
const GEOMETRIA = new THREE.BoxGeometry(1, 1, 1);

export class Explosoes {
  constructor(cena) {
    this.cena = cena;
    this.pedacos = [];
  }

  /**
   * @param {THREE.Vector3} posicao  pés de quem foi atingido
   * @param {string} cor
   * @param {number} escala  proporcional ao TAMANHO da vítima, não só ao
   *   dano: uma lagartixa de 10 cm não pode soltar estilhaço de meio metro,
   *   que foi como saiu na primeira versão -- pedaço maior que o bicho.
   */
  estourar(posicao, cor = "#ffd166", escala = 1) {
    // A contagem não acompanha a escala linearmente: um estouro pequeno com
    // 6 pedaços parece bug, não explosão.
    const quantidade = Math.round(8 + 10 * escala);
    const material = new THREE.MeshBasicMaterial({
      color: cor,
      transparent: true,
      opacity: 1,
    });

    for (let i = 0; i < quantidade; i++) {
      const tamanho = (0.03 + Math.random() * 0.05) * escala;
      const cubo = new THREE.Mesh(GEOMETRIA, material);
      cubo.scale.setScalar(tamanho);

      // Sai de dentro do corpo, não do chão sob os pés.
      cubo.position.set(
        posicao.x + (Math.random() - 0.5) * 0.12,
        posicao.y + 0.12 * escala + Math.random() * 0.12,
        posicao.z + (Math.random() - 0.5) * 0.12,
      );

      // Direção aleatória na esfera, com viés para cima: jogado para os lados
      // e para baixo o estilhaço some no piso antes de ser visto.
      const teta = Math.random() * Math.PI * 2;
      const alt = Math.random() * 0.9 + 0.15;
      const plano = Math.sqrt(Math.max(0, 1 - alt * alt));
      const forca = (2.6 + Math.random() * 2.8) * escala;

      this.pedacos.push({
        malha: cubo,
        vel: new THREE.Vector3(
          Math.cos(teta) * plano * forca,
          alt * forca,
          Math.sin(teta) * plano * forca,
        ),
        giro: new THREE.Vector3(
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
        ),
        vida: 0.75 + Math.random() * 0.45,
        idade: 0,
      });
      this.cena.add(cubo);
    }

    // Um clarão curto no centro dá o "estouro"; só os cubos leem como pipoca.
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.16 * escala, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xfff2c4,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    flash.position.set(posicao.x, posicao.y + 0.14 * escala, posicao.z);
    this.cena.add(flash);
    this.pedacos.push({
      malha: flash, vel: new THREE.Vector3(), giro: new THREE.Vector3(),
      vida: 0.16, idade: 0, flash: true, escala,
    });
  }

  atualizar(dt) {
    for (let i = this.pedacos.length - 1; i >= 0; i--) {
      const p = this.pedacos[i];
      p.idade += dt;
      const k = p.idade / p.vida;

      if (k >= 1) {
        this.cena.remove(p.malha);
        // A geometria dos cubos é compartilhada: descartar aqui quebraria os
        // próximos estouros. Só o flash tem geometria própria.
        if (p.flash) p.malha.geometry.dispose();
        p.malha.material.dispose();
        this.pedacos.splice(i, 1);
        continue;
      }

      if (p.flash) {
        p.malha.material.opacity = 0.95 * (1 - k);
        p.malha.scale.setScalar(1 + k * 1.8);
        continue;
      }

      p.vel.y += GRAVIDADE * dt;
      p.malha.position.addScaledVector(p.vel, dt);
      p.malha.rotation.x += p.giro.x * dt;
      p.malha.rotation.y += p.giro.y * dt;
      p.malha.rotation.z += p.giro.z * dt;
      // Só apaga no fim: sumir desde o começo tira o peso do estouro.
      p.malha.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    }
  }

  limpar() {
    for (const p of this.pedacos) {
      this.cena.remove(p.malha);
      if (p.flash) p.malha.geometry.dispose();
      p.malha.material.dispose();
    }
    this.pedacos.length = 0;
  }
}
