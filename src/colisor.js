import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";

// Sem esta troca o THREE.Raycaster testa os ~363 mil triangulos um a um e
// ignora a BVH -- rapido o bastante para passar despercebido na busca do ponto
// de nascimento (roda uma vez), mas impraticavel para a sonda da camera, que
// dispara varios raios por frame.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Telhado e forro ficam FORA do colisor principal e ganham o seu proprio
// (veja `construirCobertura`): quem procura chao lancando raio de cima para
// baixo -- a grade de navegacao e o sorteio de nascimento -- acharia a laje
// antes do piso.
const SEM_COLISAO = ["Roof", "Ceiling"];
const COBERTURA = ["Roof", "Ceiling"];

/**
 * Funde o cenario numa unica geometria e monta a BVH usada pela fisica.
 *
 * Uma BVH sobre as ~363 mil faces custa alguns centenas de ms para construir,
 * mas depois cada consulta de capsula toca so as folhas relevantes -- e o que
 * permite testar colisao contra o cenario inteiro a 60 fps sem simplificar a
 * malha nem desenhar caixas de colisao a mao.
 */
export function construirColisor(cenario) {
  return _fundir(cenario, (no) => !SEM_COLISAO.some((g) => no.name.startsWith(g)), "colisor");
}

/**
 * Colisor SÓ do telhado e do forro, separado do resto.
 *
 * Separado, e não fundido no colisor principal, porque a grade de navegação e
 * o sorteio do ponto de nascimento acham o chão lançando raios de CIMA para
 * baixo. Com o telhado no mesmo colisor, o primeiro toque de cada raio passa a
 * ser a laje -- e o jogo nasceria com todo mundo em pé sobre o telhado, com a
 * malha de caminhada desenhada por cima dele.
 *
 * São ~32 mil triângulos contra os ~360 mil do cenário, então a segunda BVH
 * sai barata, e a cápsula consulta as duas.
 */
export function construirCobertura(cenario) {
  const tem = [];
  cenario.traverse((no) => {
    if (no.isMesh && COBERTURA.some((g) => no.name.startsWith(g))) tem.push(no);
  });
  if (!tem.length) return null;
  return _fundir(cenario, (no) => COBERTURA.some((g) => no.name.startsWith(g)), "cobertura");
}

/**
 * Tampa gerada para os buracos do forro.
 *
 * A geometria de teto do pacote cobre só ~3/4 do piso do escritório: sobram
 * vãos, poços de escada e recortes por onde ainda dá para subir. Em vez de
 * modelar teto novo, esta função estende uma laje invisível sobre TODA coluna
 * onde a grade achou piso de escritório -- e só sobre elas, para não fechar o
 * céu da praça lá fora.
 *
 * A altura fica ENTRE o forro e o topo das paredes: abaixo do topo, senão não
 * serviria para nada; acima do forro, para não aparecer na frente dele.
 *
 * Um quadrado por coluna soa caro, mas são triângulos degenerados de dois em
 * dois num grid grosseiro -- e a BVH não se importa com quantidade, se importa
 * com espalhamento.
 */
export function construirTampa(grade, { altura, pisoMinimo = 3 } = {}) {
  const posicoes = [];
  const meio = grade.celula / 2;

  for (const [indice, alturas] of grade.niveis) {
    if (!alturas.some((y) => y >= pisoMinimo)) continue;
    // A grade indexa como `ix * nz + iz`; inverter isso espalharia a tampa
    // pelo lugar errado do mapa.
    const ix = Math.floor(indice / grade.nz);
    const iz = indice % grade.nz;
    const [x, z] = grade.paraMundo(ix, iz);
    const x0 = x - meio, x1 = x + meio;
    const z0 = z - meio, z1 = z + meio;
    // Dois triângulos virados para baixo; a cápsula é empurrada dos dois lados
    // de qualquer jeito, então a orientação só importa para depuração.
    posicoes.push(
      x0, altura, z0, x1, altura, z0, x1, altura, z1,
      x0, altura, z0, x1, altura, z1, x0, altura, z1,
    );
  }

  if (!posicoes.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(posicoes), 3));
  geo.boundsTree = new MeshBVH(geo);

  const malha = new THREE.Mesh(geo);
  malha.name = "tampa";
  malha.visible = false;
  malha.matrixAutoUpdate = false;
  return malha;
}

function _fundir(cenario, aceitar, nome) {
  const geometrias = [];

  cenario.updateMatrixWorld(true);
  cenario.traverse((no) => {
    if (!no.isMesh) return;
    if (!aceitar(no)) return;

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
  malha.name = nome;
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
