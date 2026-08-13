import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Palco do lobby: o corpo escolhido, ao vivo, com os modelos do jogo.
 *
 * Retrato estático dizia o que a pessoa vai vestir; o modelo animado diz o que
 * ela vai SER. Trocar de papel deixa de ser marcar uma opção e vira ver a
 * lagartixa aparecer no lugar do segurança.
 *
 * É um renderizador próprio, separado do jogo: o palco do jogo carrega o
 * escritório inteiro (363 mil triângulos e uma BVH), e ninguém deveria esperar
 * por isso para escolher uma cor.
 */

const COR_LAGARTIXA = "#5f9e4a";
const NA_MAO = { posicao: [0.03, 0.02, 0.12], rotacao: [0, Math.PI, 0], escala: 0.55 };

const ENQUADRE = {
  pessoa: { alvo: [0, 0.96, 0], dist: 4.15, altura: 1.12 },
  lagartixa: { alvo: [0, 0.3, 0], dist: 2.95, altura: 0.72 },
};

function ajustarMateriais(raiz, anisotropia) {
  raiz.traverse((no) => {
    if (!no.isMesh) return;
    no.castShadow = true;
    no.receiveShadow = true;
    // Sem isto o corpo some ao girar: a caixa envolvente do glTF não cobre a
    // pose animada, e o culling corta o personagem inteiro.
    no.frustumCulled = false;
    for (const m of Array.isArray(no.material) ? no.material : [no.material]) {
      if (!m?.map) continue;
      m.map.magFilter = THREE.NearestFilter;
      m.map.minFilter = THREE.LinearMipmapLinearFilter;
      m.map.generateMipmaps = true;
      m.map.anisotropy = anisotropia;
      m.map.needsUpdate = true;
    }
  });
}

export async function montarLobbyCena(canvas, { personagem, papel } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
  const alvo = new THREE.Vector3().fromArray(ENQUADRE.pessoa.alvo);
  const alvoDesejado = alvo.clone();
  const enquadre = { ...ENQUADRE.pessoa };
  const enquadreDesejado = { ...ENQUADRE.pessoa };

  const hemi = new THREE.HemisphereLight(0xbcd3ff, 0x3a3a44, 0.8);
  scene.add(hemi);

  const sol = new THREE.DirectionalLight(0xfff3e0, 2.5);
  sol.position.set(2.4, 3.8, 3.0);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  sol.shadow.normalBias = 0.06;
  Object.assign(sol.shadow.camera, {
    left: -2.5, right: 2.5, top: 3, bottom: -1, near: 0.5, far: 12,
  });
  sol.shadow.camera.updateProjectionMatrix();
  scene.add(sol);

  // Contraluz na cor do jogo: separa a silhueta do fundo escuro do painel.
  const contra = new THREE.DirectionalLight(0x5b9dff, 1.6);
  contra.position.set(-2.8, 2.4, -2.6);
  scene.add(contra);

  // Acompanha a câmera, para o rosto nunca ficar chapado de sombra.
  const frontal = new THREE.DirectionalLight(0xdfe9ff, 0.4);
  scene.add(frontal);

  // Só recebe sombra: o chão em si é invisível, e o que se vê é o contato do
  // corpo com o piso -- sem ele o personagem parece flutuar.
  const chao = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.ShadowMaterial({ color: 0x05070c, opacity: 0.6 }),
  );
  chao.rotation.x = -Math.PI / 2;
  chao.receiveShadow = true;
  scene.add(chao);

  const anel = new THREE.Group();
  for (const [raio, esp, op] of [[0.62, 0.012, 0.5], [0.78, 0.006, 0.22]]) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(raio, raio + esp, 96),
      new THREE.MeshBasicMaterial({
        color: 0x5b9dff,
        transparent: true,
        opacity: op,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.004;
    anel.add(m);
  }
  scene.add(anel);

  const anisotropia = renderer.capabilities.getMaxAnisotropy();
  const loader = new GLTFLoader();
  const cache = new Map();
  const mixers = new Map();

  async function carregar(caminho, chave) {
    if (!cache.has(chave)) {
      const gltf = await loader.loadAsync(caminho);
      ajustarMateriais(gltf.scene, anisotropia);
      cache.set(chave, gltf);
    }
    return cache.get(chave);
  }

  const armaGltf = await carregar("/models/arma.glb", "arma");
  const rifle = armaGltf.scene;

  function equipar(corpo) {
    corpo.updateMatrixWorld(true);
    const mao = corpo.getObjectByName("Hand_R") ?? corpo.getObjectByName("hand_r");
    if (!mao) return;
    // O osso herda a escala 0.01 do armature Synty: sem compensar, o rifle de
    // 1 m vira 9 mm e desaparece na mão.
    const k = 1 / Math.max(mao.getWorldScale(new THREE.Vector3()).x, 1e-6);
    rifle.position.fromArray(NA_MAO.posicao).multiplyScalar(k);
    rifle.rotation.fromArray(NA_MAO.rotacao);
    rifle.rotateZ(Math.PI); // a malha vem com o +Y para baixo
    rifle.scale.setScalar(NA_MAO.escala * k);
    mao.add(rifle);
  }

  const suporte = new THREE.Group();
  scene.add(suporte);

  const bichoGltf = await carregar("/models/lagartixa.glb", "lagartixa");

  let atual = null;
  let papelAtual = papel ?? "pessoa";
  let personagemAtual = personagem ?? "Business_Male_01";
  let corLagartixa = COR_LAGARTIXA;

  function pintarBicho(corpo, cor) {
    corpo.traverse((no) => {
      if (!no.isMesh) return;
      no.receiveShadow = false;
      if (no.name.startsWith("olho")) return;
      for (const m of Array.isArray(no.material) ? no.material : [no.material]) {
        m?.color?.set(cor);
        // A pintura do jogo entra como textura; aqui é só cor chapada, e um
        // mapa herdado do cache tingiria tudo de branco.
        if (m) m.map = null;
      }
    });
  }

  async function mostrar() {
    const ehBicho = papelAtual === "lagartixa";
    const gltf = ehBicho
      ? bichoGltf
      : await carregar(`/models/personagens/${personagemAtual}.glb`, personagemAtual);

    if (atual) {
      mixers.delete(atual);
      suporte.remove(atual);
    }

    const corpo = gltf.scene;
    corpo.position.set(0, 0, 0);
    corpo.rotation.set(0, 0, 0);
    // A lagartixa tem 26 cm: no tamanho real ela seria um ponto no pedestal.
    corpo.scale.setScalar(ehBicho ? 2.3 : 1);
    if (ehBicho) pintarBicho(corpo, corLagartixa);
    suporte.add(corpo);
    atual = corpo;

    const parado = gltf.animations.find((a) => a.name === "Parado") ?? gltf.animations[0];
    if (parado) {
      const mx = new THREE.AnimationMixer(corpo);
      mx.clipAction(parado).play();
      mx.update(0.7); // sai da T-pose antes do primeiro quadro visível
      mixers.set(corpo, mx);
    }
    if (!ehBicho) equipar(corpo);

    // A lagartixa precisa de MUITO menos luz que os personagens.
    //
    // Eles têm textura, com albedo escuro e detalhe que aguenta a luz forte
    // deste palco. Ela é cor chapada: sob a mesma iluminação, um azul claro
    // como o `#6ea8fe` do destaque estourava para branco e a lagartixa
    // aparecia sempre da mesma cor, qualquer que fosse a escolhida.
    const brilho = ehBicho ? 0.42 : 1;
    hemi.intensity = 0.8 * brilho;
    sol.intensity = 2.5 * brilho;
    contra.intensity = 1.6 * brilho;
    frontal.intensity = 0.4 * brilho;
    scene.environmentIntensity = ehBicho ? 0.3 : 1;
    renderer.toneMappingExposure = ehBicho ? 0.9 : 1.08;

    Object.assign(enquadreDesejado, ehBicho ? ENQUADRE.lagartixa : ENQUADRE.pessoa);
    alvoDesejado.fromArray(enquadreDesejado.alvo);
    anel.scale.setScalar(ehBicho ? 0.72 : 1);
  }

  await mostrar();

  function medir() {
    const r = canvas.getBoundingClientRect();
    const l = Math.max(r.width, 1);
    const a = Math.max(r.height, 1);
    renderer.setSize(l, a, false);
    camera.aspect = l / a;
    camera.updateProjectionMatrix();
  }
  medir();
  new ResizeObserver(medir).observe(canvas);

  let vivo = true;
  const relogio = new THREE.Clock();
  (function laco() {
    if (!vivo) return;
    requestAnimationFrame(laco);
    const dt = Math.min(relogio.getDelta(), 0.05);
    const t = relogio.elapsedTime;
    for (const m of mixers.values()) m.update(dt);

    // Vaivém em vez de giro contínuo: mantém o rosto quase sempre à vista.
    suporte.rotation.y = Math.sin(t * 0.32) * 0.42;

    const k = Math.min(1, dt * 5);
    enquadre.dist += (enquadreDesejado.dist - enquadre.dist) * k;
    enquadre.altura += (enquadreDesejado.altura - enquadre.altura) * k;
    alvo.lerp(alvoDesejado, k);
    camera.position.set(Math.sin(t * 0.14) * 0.14, enquadre.altura, enquadre.dist);
    camera.lookAt(alvo);
    frontal.position.copy(camera.position);
    renderer.render(scene, camera);
  })();

  return {
    trocarPersonagem(id) {
      if (id === personagemAtual) return;
      personagemAtual = id;
      if (papelAtual === "pessoa") mostrar();
    },
    trocarPapel(p) {
      if (p === papelAtual) return;
      papelAtual = p;
      mostrar();
    },
    pintar(cor) {
      corLagartixa = cor;
      if (papelAtual === "lagartixa" && atual) pintarBicho(atual, cor);
    },
    /** Some quando o jogo começa: dois renderizadores WebGL vivos é desperdício. */
    encerrar() {
      vivo = false;
      renderer.dispose();
    },
  };
}
