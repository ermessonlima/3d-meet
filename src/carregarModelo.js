import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

const MODELO = "/models/office_demo.glb";
const DRACO = "/draco/";

/**
 * Carrega o .glb gerado por tools/fbx_to_glb.py.
 *
 * `aoProgredir` recebe 0..1, ou null quando o servidor nao manda
 * Content-Length e nao da para saber a fracao baixada.
 */
export async function carregarEscritorio(renderer, aoProgredir = () => {}) {
  // O caminho explicito e necessario: o padrao do DRACOLoader resolve via
  // import.meta.url e quebra em `vite dev`, onde o three vem pre-empacotado
  // de .vite/deps. Ver tools/copy-draco.js.
  const draco = new DRACOLoader().setDecoderPath(DRACO);
  const loader = new GLTFLoader().setDRACOLoader(draco);

  try {
    const gltf = await loader.loadAsync(MODELO, (evento) => {
      aoProgredir(evento.lengthComputable ? evento.loaded / evento.total : null);
    });

    const raiz = gltf.scene;
    ajustarMateriais(raiz, renderer.capabilities.getMaxAnisotropy());
    return raiz;
  } finally {
    draco.dispose();
  }
}

/**
 * Carrega o personagem gerado por tools/personagem_to_glb.py.
 *
 * Devolve `{ modelo, clipes }`. Os clipes sao "Parado", "Andar" e "Pular" --
 * animacoes autoradas no script, porque os FBX da Synty vem sem nenhuma.
 */
export async function carregarPersonagem(renderer, caminho) {
  const draco = new DRACOLoader().setDecoderPath(DRACO);
  const loader = new GLTFLoader().setDRACOLoader(draco);

  try {
    const gltf = await loader.loadAsync(caminho);
    ajustarMateriais(gltf.scene, renderer.capabilities.getMaxAnisotropy());

    gltf.scene.traverse((no) => {
      if (no.isMesh) {
        no.castShadow = true;
        no.receiveShadow = true;
        // A capsula de colisao ja mantem o personagem dentro do cenario; sem
        // isto ele some quando o centro do bounding box sai da vista, porque
        // o volume de um SkinnedMesh nao acompanha a pose.
        no.frustumCulled = false;
      }
    });

    return { modelo: gltf.scene, clipes: gltf.animations };
  } finally {
    draco.dispose();
  }
}

/**
 * Corrige o que nao sobrevive a viagem pelo glTF.
 */
function ajustarMateriais(raiz, anisotropiaMax) {
  raiz.traverse((no) => {
    if (!no.isMesh) return;

    no.receiveShadow = true;
    // Vidro que projeta sombra sai como um bloco preto, porque o shadow map
    // e binario e ignora alpha. Deixamos o vidro fora do mapa de sombras.
    no.castShadow = !materiaisDe(no).some((m) => m?.transparent);

    for (const material of materiaisDe(no)) {
      const mapa = material.map;
      if (mapa) {
        // A textura da Synty e um atlas de blocos de cor chapada. Com
        // filtro linear na ampliacao, as bordas entre blocos vizinhos se
        // misturam e aparecem listras de cor errada nos objetos. Nearest na
        // ampliacao mata isso; na reducao mantemos mipmap + anisotropia,
        // senao o cenario inteiro cintila quando a camera se afasta.
        mapa.magFilter = THREE.NearestFilter;
        mapa.minFilter = THREE.LinearMipmapLinearFilter;
        mapa.generateMipmaps = true;
        mapa.anisotropy = anisotropiaMax;
        mapa.needsUpdate = true;
      }

      // O vidro exportado como transparente nao deve bloquear a luz.
      if (material.transparent) {
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
      }
    }
  });
}

function materiaisDe(malha) {
  return Array.isArray(malha.material) ? malha.material : [malha.material];
}
