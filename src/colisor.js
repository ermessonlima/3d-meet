import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";

// Sem esta troca o THREE.Raycaster testa os ~363 mil triangulos um a um e
// ignora a BVH -- rapido o bastante para passar despercebido na busca do ponto
// de nascimento (roda uma vez), mas impraticavel para a sonda da camera, que
// dispara varios raios por frame.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Grupos que NAO entram na colisao. O telhado e o forro sao removiveis pelo
// botao "Ver interior"; se colidissem, o jogador bateria num teto invisivel
// justamente no modo em que ele foi escondido.
const SEM_COLISAO = ["Roof", "Ceiling"];

/**
 * Funde o cenario numa unica geometria e monta a BVH usada pela fisica.
 *
 * Uma BVH sobre as ~363 mil faces custa alguns centenas de ms para construir,
 * mas depois cada consulta de capsula toca so as folhas relevantes -- e o que
 * permite testar colisao contra o cenario inteiro a 60 fps sem simplificar a
 * malha nem desenhar caixas de colisao a mao.
 */
export function construirColisor(cenario) {
  const geometrias = [];

  cenario.updateMatrixWorld(true);
  cenario.traverse((no) => {
    if (!no.isMesh) return;
    if (SEM_COLISAO.some((g) => no.name.startsWith(g))) return;

    // So a posicao interessa: normal/uv sao peso morto na BVH, e atributos
    // diferentes entre malhas fariam o mergeGeometries falhar.
    const geo = no.geometry.clone().toNonIndexed();
    for (const nome of Object.keys(geo.attributes)) {
      if (nome !== "position") geo.deleteAttribute(nome);
    }
    geo.applyMatrix4(no.matrixWorld);
    geometrias.push(geo);
  });

  if (!geometrias.length) throw new Error("nenhuma malha para colidir");

  const fundida = mergeGeometries(geometrias, false);
  for (const g of geometrias) g.dispose();

  fundida.boundsTree = new MeshBVH(fundida);

  const malha = new THREE.Mesh(fundida);
  malha.name = "colisor";
  malha.visible = false;
  malha.matrixAutoUpdate = false;

  return malha;
}

const _raio = new THREE.Raycaster();
const _baixo = new THREE.Vector3(0, -1, 0);

/**
 * Procura um ponto de nascimento com chao firme e espaco livre acima.
 *
 * Nascer no centro geometrico da cena cairia dentro de uma parede ou em cima
 * de uma mesa. Varremos uma grade, medimos o pe-direito de cada candidato e
 * ficamos com o que tiver mais folga, desempatando pela proximidade do centro.
 */
export function encontrarNascimento(colisor, alturaJogador = 1.8) {
  const caixa = new THREE.Box3().setFromObject(colisor);
  const centro = caixa.getCenter(new THREE.Vector3());
  _raio.firstHitOnly = true;

  let melhor = null;

  const PASSOS = 14;
  for (let ix = 0; ix <= PASSOS; ix++) {
    for (let iz = 0; iz <= PASSOS; iz++) {
      const x = THREE.MathUtils.lerp(caixa.min.x, caixa.max.x, ix / PASSOS);
      const z = THREE.MathUtils.lerp(caixa.min.z, caixa.max.z, iz / PASSOS);

      _raio.set(new THREE.Vector3(x, caixa.max.y + 1, z), _baixo);
      const chao = _raio.intersectObject(colisor, true)[0];
      if (!chao) continue;

      // Pe-direito: distancia ate a proxima superficie acima do chao.
      const acima = new THREE.Vector3(x, chao.point.y + 0.05, z);
      _raio.set(acima, new THREE.Vector3(0, 1, 0));
      const teto = _raio.intersectObject(colisor, true)[0];
      const folga = teto ? teto.distance : Infinity;
      if (folga < alturaJogador + 0.3) continue;

      const dist = Math.hypot(x - centro.x, z - centro.z);
      // Prefere folga generosa, mas perto do centro do predio.
      const nota = Math.min(folga, 6) * 10 - dist;
      if (!melhor || nota > melhor.nota) {
        melhor = { nota, ponto: new THREE.Vector3(x, chao.point.y + 0.02, z) };
      }
    }
  }

  if (!melhor) {
    console.warn("nenhum ponto de nascimento valido; usando o centro da cena");
    return new THREE.Vector3(centro.x, caixa.max.y, centro.z);
  }
  return melhor.ponto;
}
