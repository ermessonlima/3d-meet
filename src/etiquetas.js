import * as THREE from "three";

/**
 * Texto flutuante no mundo 3D: nome sobre a cabeça e balão de fala.
 *
 * Desenhado num canvas e aplicado num plano, em vez de HTML posicionado por
 * projeção. Assim o texto é ocluído pela geometria como qualquer objeto --
 * um nome atrás de uma parede não vaza para a frente dela.
 */

/** Desenha `texto` num plano virado para a câmera. */
// A mesma pilha de fontes da interface. Nomes e balões flutuam no mundo 3D,
// mas são interface: em monoespaçada destoavam de todo o resto da tela.
const FAMILIA =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function criarEtiqueta(texto, cor, { tamanho = 22, fundo = null, peso = 500 } = {}) {
  // Desenha no dobro e reduz: o texto continua nítido de perto.
  const escala = 2;
  const fonte = `${peso} ${tamanho * escala}px ${FAMILIA}`;

  const regua = document.createElement("canvas").getContext("2d");
  regua.font = fonte;
  const largura = regua.measureText(texto).width;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(largura + 26 * escala);
  canvas.height = Math.ceil(tamanho * escala * 1.9);

  const ctx = canvas.getContext("2d");
  if (fundo) {
    ctx.fillStyle = fundo;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 9 * escala);
    ctx.fill();
  }
  ctx.font = fonte;
  ctx.fillStyle = cor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(texto, canvas.width / 2, canvas.height / 2);

  const textura = new THREE.CanvasTexture(canvas);
  textura.colorSpace = THREE.SRGBColorSpace;

  const altura = 0.17 * (tamanho / 22);
  const plano = new THREE.Mesh(
    new THREE.PlaneGeometry((canvas.width / canvas.height) * altura, altura),
    new THREE.MeshBasicMaterial({
      map: textura,
      transparent: true,
      depthWrite: false,
    }),
  );
  plano.renderOrder = 10;
  return plano;
}

export function descartarEtiqueta(plano) {
  if (!plano) return;
  plano.geometry.dispose();
  plano.material.map?.dispose();
  plano.material.dispose();
}

const DURACAO_BALAO = 6000;

/**
 * Balão de fala temporário preso a um objeto.
 *
 * Uma fala nova substitui a anterior em vez de empilhar: duas linhas
 * sobrepostas sobre a cabeça ficam ilegíveis, e a mensagem que importa é
 * sempre a última.
 */
export class Balao {
  constructor(anfitriao, altura = 2.42) {
    this.anfitriao = anfitriao;
    this.altura = altura;
    this.plano = null;
    this.ate = 0;
  }

  dizer(texto) {
    this.limpar();
    this.plano = criarEtiqueta(texto, "#e7ecf5", {
      tamanho: 15,
      peso: 400,
      fundo: "rgba(11,14,20,0.9)",
    });
    this.plano.position.set(0, this.altura, 0);
    this.anfitriao.add(this.plano);
    this.ate = performance.now() + DURACAO_BALAO;
  }

  limpar() {
    if (!this.plano) return;
    this.anfitriao.remove(this.plano);
    descartarEtiqueta(this.plano);
    this.plano = null;
  }

  atualizar(camera) {
    if (!this.plano) return;
    this.plano.quaternion.copy(camera.quaternion);
    if (performance.now() > this.ate) this.limpar();
  }
}
