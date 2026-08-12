import * as THREE from "three";

const GRAVIDADE = -26;
const VEL_CAMINHADA = 2.4;
const VEL_CORRIDA = 4.6;
// Com GRAVIDADE = -26, isto da ~0.94 m de altura: alto o bastante para subir
// numa mesa (0.75 m), baixo o bastante para nao parecer que flutua.
const IMPULSO_PULO = 7.0;

// Medidas padrão (pessoa). A lagartixa passa as dela no construtor: uma
// cápsula de 1,8 m num bicho de 10 cm o faria flutuar e travar em cada porta.
const RAIO = 0.3;
const ALTURA = 1.8;

// O clipe "Andar" cobre uma passada completa (dois passos) em 1 s. Casando a
// velocidade do clipe com a do deslocamento, o pe para de patinar no chao.
const AVANCO_POR_CICLO = 1.5;

/**
 * Jogador com capsula, gravidade e colisao contra a BVH do cenario.
 */
export class Jogador {
  constructor(modelo, clipes, colisor, opcoes = {}) {
    this.raio = opcoes.raio ?? RAIO;
    this.altura = opcoes.altura ?? ALTURA;
    this.velCaminhada = opcoes.velCaminhada ?? VEL_CAMINHADA;
    this.velCorrida = opcoes.velCorrida ?? VEL_CORRIDA;
    this.avancoPorCiclo = opcoes.avancoPorCiclo ?? AVANCO_POR_CICLO;
    this.impulsoPulo = opcoes.impulsoPulo ?? IMPULSO_PULO;

    this.raiz = new THREE.Group();
    this.raiz.add(modelo);
    this.modelo = modelo;
    this.colisor = colisor;

    this.posicao = new THREE.Vector3();   // nos PES do personagem
    this.velocidade = new THREE.Vector3();
    this.noChao = false;
    this.olhandoPara = 0;

    this.sentado = false;

    // Quando definida, a máquina de animação para de decidir e mantém esta
    // pose. Sem isso, `_animar` reescreve "Parado" a cada quadro e qualquer
    // pose imposta de fora (esconder, por exemplo) dura um frame só.
    this.poseFixa = null;

    // Caminho do clicar-e-andar. Vazio = sob controle do teclado.
    this.caminho = null;
    this.passoAtual = 0;
    this.aoChegar = () => {};

    // Capsula em espaco local, medida a partir dos pes.
    this.capsula = new THREE.Line3(
      new THREE.Vector3(0, this.raio, 0),
      new THREE.Vector3(0, Math.max(this.altura - this.raio, this.raio), 0),
    );

    this.mixer = new THREE.AnimationMixer(modelo);
    this.acoes = {};
    for (const clipe of clipes) {
      const acao = this.mixer.clipAction(clipe);
      if (clipe.name === "Pular") {
        acao.setLoop(THREE.LoopOnce);
        acao.clampWhenFinished = true;
      }
      this.acoes[clipe.name] = acao;
    }
    this.atual = null;
    this._trocarPara("Parado", 0);

    // Reaproveitados a cada frame para nao alocar dentro do loop.
    this._caixa = new THREE.Box3();
    this._seg = new THREE.Line3();
    this._tri = new THREE.Vector3();
    this._cap = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._antes = new THREE.Vector3();
    this._direcao = new THREE.Vector3();
  }

  nascerEm(ponto) {
    this.posicao.copy(ponto);
    this.velocidade.set(0, 0, 0);
    this._sincronizar();
  }

  _sincronizar() {
    this.raiz.position.copy(this.posicao);
    this.raiz.rotation.y = this.olhandoPara;
  }

  _trocarPara(nome, mistura = 0.16) {
    const proxima = this.acoes[nome];
    if (!proxima || this.atual === proxima) return;

    if (nome === "Pular") {
      proxima.reset();
    }
    proxima.enabled = true;
    proxima.setEffectiveWeight(1);
    proxima.play();

    if (this.atual && mistura > 0) {
      this.atual.crossFadeTo(proxima, mistura, false);
    } else if (this.atual) {
      this.atual.stop();
    }
    this.atual = proxima;
    this.nomeAtual = nome;
  }

  /**
   * Senta num ponto, encarando `angulo`.
   *
   * Encaixa o corpo no lugar em vez de deixar a física resolver: a cápsula
   * pararia encostada no sofá, não em cima dele, e a pose sentada ficaria
   * flutuando ao lado do móvel.
   */
  sentar(ponto, angulo) {
    this.cancelarCaminho();
    this.sentado = true;
    this.posicao.copy(ponto);
    this.olhandoPara = angulo;
    this.velocidade.set(0, 0, 0);
    this._sincronizar();
    this._trocarPara("Sentar", 0.35);
  }

  levantar() {
    if (!this.sentado) return;
    this.sentado = false;

    // Quando definida, a máquina de animação para de decidir e mantém esta
    // pose. Sem isso, `_animar` reescreve "Parado" a cada quadro e qualquer
    // pose imposta de fora (esconder, por exemplo) dura um frame só.
    this.poseFixa = null;
    this._trocarPara("Parado", 0.3);
  }

  /** Começa a seguir um caminho (lista de pontos do módulo de navegação). */
  seguirCaminho(pontos) {
    if (!pontos?.length) return;
    this.caminho = pontos;
    this.passoAtual = 0;
    this._melhorDistancia = Infinity;
    this._progrediuEm = performance.now();
  }

  cancelarCaminho() {
    this.caminho = null;
  }

  get seguindoCaminho() {
    return Boolean(this.caminho);
  }

  /**
   * Direção para o próximo ponto do caminho.
   *
   * A chegada é medida só no plano: comparar a altura também faria o
   * personagem "não chegar" num degrau, porque o pé fica alguns centímetros
   * acima ou abaixo do ponto amostrado na grade.
   */
  _avancarPasso() {
    this.passoAtual += 1;
    this._melhorDistancia = Infinity;
    this._progrediuEm = performance.now();
  }

  _direcaoDoCaminho(destino) {
    while (this.caminho && this.passoAtual < this.caminho.length) {
      const alvo = this.caminho[this.passoAtual];
      const dx = alvo.x - this.posicao.x;
      const dz = alvo.z - this.posicao.z;
      const distancia = Math.hypot(dx, dz);

      // Tolerância maior nos pontos intermediários: exigir precisão em cada um
      // faz o personagem parar e recomeçar a cada canto.
      const ultimo = this.passoAtual === this.caminho.length - 1;
      if (distancia < (ultimo ? 0.22 : 0.45)) {
        this._avancarPasso();
        continue;
      }

      // Travou? Desiste deste ponto.
      //
      // A grade de navegação não encolhe as áreas caminháveis pelo raio do
      // corpo (encolher fecharia as portas), então um trajeto pode passar
      // rente demais a um móvel e a cápsula não caber. Sem esta saída, o
      // personagem fica empurrando a mobília com a animação de andar rodando
      // para sempre -- foi exatamente o que aconteceu no primeiro teste.
      const agora = performance.now();
      if (distancia < this._melhorDistancia - 0.04) {
        this._melhorDistancia = distancia;
        this._progrediuEm = agora;
      } else if (agora - this._progrediuEm > 900) {
        this._avancarPasso();
        continue;
      }

      destino.set(dx / distancia, 0, dz / distancia);
      return true;
    }

    this.caminho = null;
    this.aoChegar();
    return false;
  }

  /**
   * @param {number} dt      segundos desde o frame anterior
   * @param {object} entrada {frente, tras, esquerda, direita, correndo, pular}
   * @param {THREE.Camera} camera  define para onde é "para frente"
   */
  atualizar(dt, entrada, camera) {
    // Sentado, o corpo fica onde foi encaixado: nada de gravidade nem de
    // colisão. Deixar a física rodando faria a cápsula escorregar do sofá,
    // porque o ponto de apoio está no estofado, não sob os pés.
    if (this.sentado) {
      // Qualquer tecla de movimento levanta -- é o gesto natural de sair.
      if (entrada.frente || entrada.tras || entrada.esquerda || entrada.direita
          || entrada.pular) {
        this.levantar();
      } else {
        this.mixer.update(dt);
        return;
      }
    }

    // ---- direcao desejada, relativa a camera
    this._direcao.set(0, 0, 0);
    const eixoZ = new THREE.Vector3();
    camera.getWorldDirection(eixoZ);
    eixoZ.y = 0;
    eixoZ.normalize();
    const eixoX = new THREE.Vector3().crossVectors(eixoZ, new THREE.Vector3(0, 1, 0)).negate();

    if (entrada.frente) this._direcao.add(eixoZ);
    if (entrada.tras) this._direcao.sub(eixoZ);
    if (entrada.esquerda) this._direcao.add(eixoX);
    if (entrada.direita) this._direcao.sub(eixoX);

    let andando = this._direcao.lengthSq() > 1e-6;
    if (andando) {
      this._direcao.normalize();
      // Qualquer tecla de movimento assume o controle: quem pegou o teclado
      // não quer que o boneco continue indo para onde clicou antes.
      this.cancelarCaminho();
    } else if (this.caminho) {
      andando = this._direcaoDoCaminho(this._direcao);
    }

    const velocidade = entrada.correndo ? this.velCorrida : this.velCaminhada;

    // ---- integra
    this.velocidade.y += GRAVIDADE * dt;
    if (entrada.pular && this.noChao) {
      this.velocidade.y = this.impulsoPulo;
      this.noChao = false;
      this._trocarPara("Pular", 0.08);
    }

    this.posicao.addScaledVector(this._direcao, velocidade * dt * (andando ? 1 : 0));
    this.posicao.y += this.velocidade.y * dt;

    this._resolverColisao(dt);

    // ---- vira o corpo para a direcao do movimento
    if (andando) {
      // O personagem foi exportado olhando para +Z, entao atan2(x, z) alinha
      // direto, sem offset (ver orientar_para_z_positivo no script Python).
      const alvo = Math.atan2(this._direcao.x, this._direcao.z);
      let d = alvo - this.olhandoPara;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.olhandoPara += d * Math.min(1, dt * 14);
    }

    this._sincronizar();
    this._animar(dt, andando, velocidade);
  }

  _animar(dt, andando, velocidade) {
    if (this.poseFixa) {
      this._trocarPara(this.poseFixa, 0.28);
      this.mixer.update(dt);
      return;
    }
    if (!this.noChao) {
      this._trocarPara("Pular", 0.1);
    } else if (andando) {
      this._trocarPara("Andar");
      this.acoes.Andar.timeScale = velocidade / this.avancoPorCiclo;
    } else {
      this._trocarPara("Parado");
    }
    this.mixer.update(dt);
  }

  /**
   * Empurra a capsula para fora de cada triangulo que ela penetrou.
   *
   * O deslocamento total resultante diz tambem se o jogador esta no chao: se a
   * correcao apontou para cima mais do que a queda daquele frame, ele pousou.
   */
  _resolverColisao(dt) {
    const bvh = this.colisor.geometry.boundsTree;

    this._seg.copy(this.capsula);
    this._seg.start.add(this.posicao);
    this._seg.end.add(this.posicao);
    this._antes.copy(this._seg.start);

    this._caixa.makeEmpty();
    this._caixa.expandByPoint(this._seg.start);
    this._caixa.expandByPoint(this._seg.end);
    this._caixa.min.addScalar(-this.raio);
    this._caixa.max.addScalar(this.raio);

    bvh.shapecast({
      intersectsBounds: (caixa) => caixa.intersectsBox(this._caixa),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(this._seg, this._tri, this._cap);
        if (dist < this.raio) {
          const profundidade = this.raio - dist;
          const direcao = this._cap.sub(this._tri).normalize();
          this._seg.start.addScaledVector(direcao, profundidade);
          this._seg.end.addScaledVector(direcao, profundidade);
        }
      },
    });

    this._delta.copy(this._seg.start).sub(this._antes);

    // Queda daquele frame como referencia: se a correcao vertical foi maior,
    // o que interrompeu a queda foi o chao, e nao um roçar em parede.
    const queda = Math.abs(dt * this.velocidade.y);
    this.noChao = this._delta.y > Math.max(queda * 0.25, 1e-4);

    this.posicao.add(this._delta);

    if (this.noChao) {
      this.velocidade.set(0, 0, 0);
    } else if (this._delta.lengthSq() > 1e-10) {
      // Bateu em algo que nao e chao: remove so a componente da velocidade
      // que entrava na parede, preservando o deslize ao longo dela.
      this._delta.normalize();
      this.velocidade.addScaledVector(this._delta, -this._delta.dot(this.velocidade));
    }
  }

  /** Ponto que a camera deve mirar: o peito, nao os pes. */
  alvoDaCamera(destino) {
    return destino.copy(this.posicao).addScaledVector(new THREE.Vector3(0, 1, 0), this.alvoCamera ?? 1.25);
  }
}

/** Teclado -> objeto de entrada, com WASD e setas. */
export function criarEntrada() {
  const teclas = new Set();
  const estado = {
    frente: false, tras: false, esquerda: false, direita: false,
    correndo: false, pular: false,
  };

  const mapa = {
    KeyW: "frente", ArrowUp: "frente",
    KeyS: "tras", ArrowDown: "tras",
    KeyA: "esquerda", ArrowLeft: "esquerda",
    KeyD: "direita", ArrowRight: "direita",
  };

  addEventListener("keydown", (e) => {
    if (e.code === "Space") e.preventDefault();
    teclas.add(e.code);
  });
  addEventListener("keyup", (e) => teclas.delete(e.code));
  // Sem isto, sair da aba com uma tecla apertada deixa o boneco andando sozinho.
  addEventListener("blur", () => teclas.clear());

  return function ler() {
    for (const k of Object.keys(estado)) estado[k] = false;
    for (const [codigo, acao] of Object.entries(mapa)) {
      if (teclas.has(codigo)) estado[acao] = true;
    }
    estado.correndo = teclas.has("ShiftLeft") || teclas.has("ShiftRight");
    estado.pular = teclas.has("Space");
    return estado;
  };
}
