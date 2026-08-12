import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Arma de brinquedo e tiro.
 *
 * ## Mira, e por que ela existe
 *
 * O clique esquerdo já é "vá até este ponto". Não dá para ele também atirar
 * sem uma das duas coisas virar acidente. A saída é o modo de mira: segure o
 * botão DIREITO e a câmera aproxima, aparece a cruz, e aí o esquerdo dispara.
 * Soltar o direito devolve o clique-para-andar. É a convenção de terceira
 * pessoa e não custa uma tecla nova.
 *
 * ## Detecção de acerto
 *
 * O tiro é hitscan: um raio da câmera pela cruz. Testa primeiro contra os
 * alvos e depois contra o cenário, e só vale se o alvo estiver mais perto que
 * a parede -- senão daria para atirar através das divisórias.
 *
 * Quem decide o acerto é o atirador, e o servidor só repassa. É o mesmo modelo
 * de confiança do resto do jogo: honesto entre amigos, trivial de burlar por
 * quem quiser. Autoridade de verdade exigiria a física no servidor.
 */

const ALCANCE = 40;
const CADENCIA_MS = 260;
const VIDA_MAXIMA = 3;

// Onde a arma fica na mão, em METROS de mundo. A conversão para o espaço local
// do osso é feita em `equipar`, e não é opcional -- ver o comentário lá.
const NA_MAO = {
  posicao: [0.03, 0.02, 0.12],
  rotacao: [0, Math.PI, 0],
  escala: 0.55,   // o rifle tem 1,04 m; isto o deixa em ~57 cm, tamanho de brinquedo
};

const DURACAO_CLARAO_MS = 70;
// Soltar o botão direito antes disto conta como toque, e dispara.
const TOQUE_MS = 260;

// Velocidade do dardo. Baixa o bastante para se ver voando (a graça do pedido),
// alta o bastante para não parecer que foi arremessado à mão.
const VELOCIDADE_PROJETIL = 34;
const RAIO_RASTRO = 0.022;
const SUMICO_RASTRO_MS = 260;

export class Combate {
  constructor(cena, camera, colisor, dom) {
    this.cena = cena;
    this.camera = camera;
    this.colisor = colisor;
    this.dom = dom;

    this.arma = null;
    this.mirando = false;
    this._miraDesde = 0;
    this.vida = VIDA_MAXIMA;
    this._ultimoTiro = 0;

    this.aoAcertar = () => {};
    this.aoAtirar = () => {};
    this.podeAtirar = () => false;
    /** Devolve os alvos do frame: [{id, objeto3d, raio, centroY}]. */
    this.listarAlvos = () => [];

    this._raio = new THREE.Raycaster();
    this._raio.far = ALCANCE;
    this._centro = new THREE.Vector2(0, 0);

  }

  async carregarArma() {
    const gltf = await new GLTFLoader().loadAsync("/models/arma.glb");
    this.arma = gltf.scene;
    this.arma.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        if (o.material.map) {
          o.material.map.magFilter = THREE.NearestFilter;
          o.material.map.needsUpdate = true;
        }
      }
    });
    return this.arma;
  }

  /**
   * Pendura a arma no osso da mão.
   *
   * O glTF exporta cada osso como um nó com o nome do FBX, então `Hand_R`
   * existe dentro do modelo. Pendurar ali faz a arma acompanhar a animação
   * sozinha -- sem isso seria preciso copiar a matriz da mão a cada quadro.
   */
  equipar(modelo, arma = this.arma) {
    if (!arma) return null;
    const mao = modelo.getObjectByName("Hand_R") ?? modelo.getObjectByName("hand_r");
    if (!mao) {
      console.warn("[combate] osso da mão não encontrado; arma não equipada");
      return null;
    }
    // O osso da mão herda a escala do armature, que na Synty é 0.01. Pendurar
    // a arma ali sem compensar a deixa 100x menor: o rifle de 1 m vira 9 mm e
    // some da tela. Não dá para chutar o fator -- medimos a escala real do
    // osso e dividimos, o que continua certo se o rig vier em outra convenção.
    modelo.updateMatrixWorld(true);
    const escalaOsso = mao.getWorldScale(new THREE.Vector3());
    const k = escalaOsso.x > 1e-6 ? 1 / escalaOsso.x : 1;

    // A posição também está nesse espaço encolhido, então vai pelo mesmo fator.
    arma.position.fromArray(NA_MAO.posicao).multiplyScalar(k);
    arma.rotation.fromArray(NA_MAO.rotacao);
    // Rolagem de 180° em torno do próprio cano: a malha vem com o +Y para
    // baixo, e sem isto a arma fica de cabeça para baixo na mão -- cano na
    // direção certa, mas empunhadura apontando para o teto.
    arma.rotateZ(Math.PI);
    arma.scale.setScalar(NA_MAO.escala * k);
    mao.add(arma);

    // Ponta do cano, para o rastro sair da arma e não do meio do peito.
    if (!this.boca) {
      this.boca = new THREE.Object3D();
      this.boca.name = "boca";
      arma.add(this.boca);
    }
    this.boca.position.set(0, 0, 0.95);  // em unidades locais da arma

    return arma;
  }

  /**
   * Lança um dardo que VOA da boca do cano até o ponto atingido, deixando
   * rastro.
   *
   * A mira continua sendo hitscan -- o ponto final é decidido no instante do
   * disparo, então acertar não depende de o dardo alcançar o alvo. O que viaja
   * é a imagem. Fazer o dano depender do voo mudaria a sensação de mira sem
   * ganho: a 34 m/s, dez metros levam 0,3 s.
   */
  dispararProjetil(de, ate, ondeClarear = de) {
    if (!this._voando) this._voando = [];
    if (!this._rastros) this._rastros = [];

    const distancia = Math.max(de.distanceTo(ate), 0.05);

    const dardo = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb03a }),
    );
    dardo.scale.z = 2.2;                   // alongado no sentido do voo
    dardo.position.copy(de);
    dardo.lookAt(ate);
    dardo.renderOrder = 7;
    this.cena.add(dardo);

    // O rastro cresce atrás do dardo, começando com comprimento zero.
    const geo = new THREE.CylinderGeometry(RAIO_RASTRO, RAIO_RASTRO, 1, 6, 1, true);
    geo.rotateX(Math.PI / 2);              // deita o cilindro no eixo Z
    const rastro = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    rastro.renderOrder = 6;
    this.cena.add(rastro);

    this._voando.push({
      dardo, rastro,
      de: de.clone(), ate: ate.clone(),
      t: 0,
      duracao: distancia / VELOCIDADE_PROJETIL,
    });

    this._clarao(ondeClarear);
  }

  /**
   * Clarão na boca do cano.
   *
   * O rastro sozinho não basta para QUEM ATIRA: ele sai na direção do olhar,
   * fica de ponta para a câmera e some atrás da mira. Quem vê rastro é o
   * adversário, cujo ângulo cruza o tiro. O clarão é o retorno de quem puxou
   * o gatilho -- uma bola brilhante que dura 70 ms na ponta da arma.
   */
  _clarao(em) {
    const malha = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xfff0b8,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    malha.position.copy(em);
    malha.renderOrder = 7;
    this.cena.add(malha);
    this._rastros.push({
      malha, ate: performance.now() + DURACAO_CLARAO_MS, clarao: true,
      sumico: DURACAO_CLARAO_MS,
    });
  }

  /** Move os dardos e faz o rastro crescer atrás deles. */
  atualizarProjeteis(dt) {
    if (!this._voando?.length) return;
    const meio = new THREE.Vector3();

    for (let i = this._voando.length - 1; i >= 0; i--) {
      const p = this._voando[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.duracao);

      const atual = p.de.clone().lerp(p.ate, k);
      p.dardo.position.copy(atual);

      // Rastro: da origem até onde o dardo está agora.
      const comprimento = Math.max(p.de.distanceTo(atual), 0.01);
      p.rastro.position.copy(meio.copy(p.de).add(atual).multiplyScalar(0.5));
      p.rastro.lookAt(atual);
      p.rastro.scale.z = comprimento;

      if (k >= 1) {
        // Chegou: o dardo some e o rastro fica apagando sozinho.
        this.cena.remove(p.dardo);
        p.dardo.geometry.dispose();
        p.dardo.material.dispose();
        this._rastros.push({
          malha: p.rastro,
          ate: performance.now() + SUMICO_RASTRO_MS,
          sumico: SUMICO_RASTRO_MS,
        });
        this._voando.splice(i, 1);
      }
    }
  }

  atualizarRastros() {
    if (!this._rastros?.length) return;
    const agora = performance.now();
    for (let i = this._rastros.length - 1; i >= 0; i--) {
      const r = this._rastros[i];
      const restante =
        (r.ate - agora) / (r.clarao ? DURACAO_CLARAO_MS : r.sumico);
      if (restante <= 0) {
        this.cena.remove(r.malha);
        r.malha.geometry.dispose();
        r.malha.material.dispose();
        this._rastros.splice(i, 1);
      } else if (r.clarao) {
        // O clarão encolhe enquanto apaga: some como faísca, não como bolha.
        r.malha.material.opacity = restante;
        r.malha.scale.setScalar(0.6 + restante * 0.7);
      } else {
        r.malha.material.opacity = 0.9 * restante;
      }
    }
  }

  /** Posição da boca do cano no mundo; a câmera é o recurso se não há arma. */
  posicaoDaBoca(destino) {
    if (this.boca) {
      this.boca.updateWorldMatrix(true, false);
      return destino.setFromMatrixPosition(this.boca.matrixWorld);
    }
    return destino.copy(this.camera.position);
  }

  /**
   * O combate NÃO escuta o mouse.
   *
   * Quem interpreta os gestos é a câmera, que é a dona da entrada; o main liga
   * os callbacks dela aqui. Duas classes ouvindo o mesmo canvas foi exatamente
   * o que quebrou o giro: o clique esquerdo disparava antes de o arrasto ser
   * reconhecido, e o botão direito mirava sem girar.
   */
  ativar() {
    this.mirando = false;
  }

  desativar() {
    this.mirando = false;
  }

  definirMira(sim) {
    this.mirando = Boolean(sim) && this.podeAtirar();
  }

  puxarGatilho() {
    if (!this.podeAtirar()) return null;
    return this.atirar(this.listarAlvos());
  }

  /**
   * Dispara. `alvos` é uma lista de {id, objeto3d, raio, centroY}.
   * Devolve o id acertado, ou null.
   */
  atirar(alvos = []) {
    const agora = performance.now();
    if (agora - this._ultimoTiro < CADENCIA_MS) return null;
    this._ultimoTiro = agora;

    this._raio.setFromCamera(this._centro, this.camera);
    this._raio.firstHitOnly = true;

    // Distância até a parede: nada além dela conta como acerto.
    const parede = this._raio.intersectObject(this.colisor, true)[0];
    const limite = parede ? parede.distance : ALCANCE;

    let melhor = null;
    const esfera = new THREE.Sphere();
    const ponto = new THREE.Vector3();

    for (const alvo of alvos) {
      esfera.center.copy(alvo.objeto3d.position);
      esfera.center.y += alvo.centroY;
      esfera.radius = alvo.raio;

      if (!this._raio.ray.intersectSphere(esfera, ponto)) continue;
      const d = ponto.distanceTo(this._raio.ray.origin);
      if (d > limite) continue;                      // atrás da parede
      if (!melhor || d < melhor.d) melhor = { id: alvo.id, d, ponto: ponto.clone() };
    }

    // Onde o tiro termina: no alvo, na parede, ou no fim do alcance.
    const fim = melhor
      ? melhor.ponto.clone()
      : parede
        ? parede.point.clone()
        : this._raio.ray.at(ALCANCE, new THREE.Vector3());

    // O dardo parte da LINHA DA MIRA, não da boca do cano.
    //
    // A mira é um raio que sai da câmera; a boca fica a ~1 m dessa linha,
    // porque a arma está na mão e a câmera está sobre o ombro. Lançar da boca
    // faz o dardo cruzar em diagonal até o alvo -- 3,7° a 16 m, e muito pior
    // de perto, onde ele visivelmente sai de lado em vez de ir na cruz.
    //
    // Projetamos a boca sobre o raio: o dardo nasce à mesma PROFUNDIDADE da
    // arma (então parece sair dali) e viaja exatamente sobre a cruz. O clarão
    // continua na boca de verdade, que é onde a arma está.
    const boca = this.posicaoDaBoca(new THREE.Vector3());
    const raio = this._raio.ray;
    const profundidade = Math.max(
      boca.clone().sub(raio.origin).dot(raio.direction),
      0.35,
    );
    const origem = raio.at(profundidade, new THREE.Vector3());

    this.dispararProjetil(origem, fim, boca);

    this.aoAtirar(boca, fim, melhor?.id ?? null);
    if (melhor) this.aoAcertar(melhor.id);
    return melhor?.id ?? null;
  }

  levarTiro() {
    this.vida = Math.max(0, this.vida - 1);
    return this.vida;
  }

  reviver() {
    this.vida = VIDA_MAXIMA;
  }

  get vidaMaxima() {
    return VIDA_MAXIMA;
  }
}
