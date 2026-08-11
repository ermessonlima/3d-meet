import * as THREE from "three";

/**
 * Anel no chão marcando para onde o personagem foi mandado.
 *
 * Existe por causa da latência de percepção: entre o clique e o personagem
 * começar a virar passam alguns quadros, e sem retorno imediato a pessoa
 * clica de novo achando que não pegou.
 *
 * O anel pulsa uma vez ao aparecer e depois fica parado até a chegada. Some
 * sozinho quando o caminho termina.
 */
export class MarcadorDeDestino {
  constructor(cena) {
    const geometria = new THREE.RingGeometry(0.16, 0.24, 40);
    // Deitado no chão: a geometria nasce em pé, no plano XY.
    geometria.rotateX(-Math.PI / 2);

    this.malha = new THREE.Mesh(
      geometria,
      new THREE.MeshBasicMaterial({
        color: 0x5b9dff,
        transparent: true,
        opacity: 0,
        // Sem escrever no z-buffer e desenhando por último, o anel não some
        // dentro do piso por causa do z-fighting em chão irregular.
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.malha.renderOrder = 5;
    this.malha.visible = false;
    cena.add(this.malha);

    this.ate = 0;
    this.nascidoEm = 0;
  }

  mostrar(ponto) {
    // 4 cm acima do piso: encostado, o anel entra na geometria em rampas.
    this.malha.position.set(ponto.x, ponto.y + 0.04, ponto.z);
    this.malha.visible = true;
    this.nascidoEm = performance.now();
  }

  esconder() {
    this.malha.visible = false;
  }

  atualizar() {
    if (!this.malha.visible) return;

    const idade = (performance.now() - this.nascidoEm) / 1000;

    // Pulso de 0.45 s na entrada, depois estabiliza.
    const pulso = Math.min(1, idade / 0.45);
    const escala = 1 + (1 - pulso) * 1.6;
    this.malha.scale.setScalar(escala);
    this.malha.material.opacity = 0.25 + 0.55 * pulso;
  }
}
