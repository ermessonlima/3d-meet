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
    /**
     * Altura de degrau que o corpo sobe sozinho.
     *
     * A cápsula só sabe ser EMPURRADA para fora do que encosta nela. Numa
     * escada isso vira o pior dos dois mundos: o espelho do degrau empurra o
     * corpo para trás, ele escorrega de lado, e quem joga fica se sacudindo no
     * primeiro degrau sem subir nenhum. Não é um caso raro -- é toda escada,
     * todo batente e toda soleira do prédio.
     *
     * Uma pessoa sobe 45 cm sem pensar. A lagartixa recebe pouco porque ela
     * escala parede: para ela um degrau já é superfície, e um valor grande a
     * faria "pular" obstáculos que deveriam custar uma escalada.
     */
    this.alturaDoDegrau = opcoes.alturaDoDegrau ?? 0.45;
    this._degrauBase = this.alturaDoDegrau;
    this._raioDegrau = new THREE.Raycaster();
    this._raioDegrau.firstHitOnly = true;
    this._pDegrau = new THREE.Vector3();
    this._antesDoPasso = new THREE.Vector3();
    this._cimaInvertida = new THREE.Vector3();
    this._dDegrau = new THREE.Vector3();

    this.raiz = new THREE.Group();
    this.raiz.add(modelo);
    this.modelo = modelo;
    this.colisor = colisor;
    /**
     * Colisor extra do telhado, se houver.
     *
     * Vem separado porque o principal é usado para ACHAR CHÃO com raios de
     * cima para baixo, e a laje atrapalharia essa busca. Para a cápsula, os
     * dois são a mesma coisa: um monte de triângulo do qual sair.
     */
    this.coberturas = opcoes.coberturas ?? [];

    this.posicao = new THREE.Vector3();   // nos PES do personagem
    this.velocidade = new THREE.Vector3();
    this.noChao = false;
    this.olhandoPara = 0;

    /**
     * Escalada de lagartixa.
     *
     * Ligada, o "para baixo" do bicho deixa de ser o Y do mundo e passa a ser
     * `-cima`, que acompanha a superfície onde ele está grudado. A gravidade
     * então PRENDE contra a parede em vez de puxar para o chão -- que é o
     * mesmo truque que uma osga de verdade usa, só que com física em vez de
     * lamelas.
     */
    this.escalar = opcoes.escalar === true;
    this.cima = new THREE.Vector3(0, 1, 0);
    this.frente = new THREE.Vector3(0, 0, 1);
    /** true quando grudada em algo que não é o chão do mundo. */
    this.escalando = false;

    this._raioEscalada = new THREE.Raycaster();
    this._raioEscalada.firstHitOnly = true;
    this._normal = new THREE.Vector3();
    this._sonda = new THREE.Vector3();
    this._centro = new THREE.Vector3();
    this._base = new THREE.Matrix4();
    this._eixoX = new THREE.Vector3();
    /** Velocidade ao longo de `cima`; é a antiga `velocidade.y` generalizada. */
    this._velNormal = 0;

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

    // Tamanho de fábrica, para o bônus surpresa poder voltar ao normal.
    this._raioBase = this.raio;
    this._alturaBase = this.altura;
    this._velBase = { caminhada: this.velCaminhada, corrida: this.velCorrida };
    this.escala = 1;

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
    this._velNormal = 0;
    this.cima.set(0, 1, 0);
    this.escalando = false;
    this.frente.set(Math.sin(this.olhandoPara), 0, Math.cos(this.olhandoPara));
    // O primeiro passo depois de nascer ENCAIXA a frente, em vez de amortecer.
    //
    // Deduzir a frente de `olhandoPara` não bastava: nascendo, ele é 0 -- e a
    // câmera também nasce com yaw 0, onde o "para frente" dela é -Z. Os dois
    // zeros apontavam para lados opostos, então o bicho saía andando de costas
    // até o amortecimento dar a volta. Em vez de acertar o ângulo inicial no
    // chute (e errar de novo a cada renascimento, com a câmera onde estiver),
    // o primeiro quadro de marcha copia a direção do movimento inteira.
    this._encaixarFrente = true;
    this._sincronizar();
  }

  _sincronizar() {
    this.raiz.position.copy(this.posicao);

    if (!this.escalar) {
      this.raiz.rotation.y = this.olhandoPara;
      return;
    }

    // Escalando não dá para usar só o yaw: a barriga tem que encarar a
    // superfície. A base sai de (frente, cima) -- o modelo foi exportado com
    // +Y para cima e +Z para a frente, então os eixos entram direto.
    this._sonda.copy(this.frente);
    this._sonda.addScaledVector(this.cima, -this._sonda.dot(this.cima));
    if (this._sonda.lengthSq() < 1e-8) {
      // Frente paralela à normal (aconteceu de virar a quina): pega qualquer
      // direção do plano em vez de produzir uma base degenerada.
      this._sonda.set(this.cima.y, this.cima.z, this.cima.x)
        .addScaledVector(this.cima, -this.cima.dot(this._sonda));
    }
    this._sonda.normalize();
    this._eixoX.crossVectors(this.cima, this._sonda).normalize();
    this._base.makeBasis(this._eixoX, this.cima, this._sonda);
    this.raiz.quaternion.setFromRotationMatrix(this._base);
  }

  /**
   * Procura superfície para grudar e ajusta `cima` para a normal dela.
   *
   * A regra é a do bicho: gruda no que encosta. Sondas curtas saem do centro
   * da cápsula para onde o corpo anda, para os lados, e para trás-e-para-baixo
   * -- essa última é o que faz virar a quina de uma mesa e continuar por
   * baixo, em vez de andar até a beirada e despencar.
   */
  _buscarSuperficie(dt, querendoAndar) {
    const alcance = this.raio * 2.4 + 0.10;
    // Distância curta para AGARRAR algo novo: com alcance folgado, a lagartixa
    // grudaria numa parede antes mesmo de chegar perto dela.
    const agarrar = this.raio * 1.8;
    this._centro.copy(this.posicao).addScaledVector(this.cima, this.raio);

    const lado = this._reusar(6).crossVectors(this.cima, this.frente);
    if (lado.lengthSq() < 1e-8) lado.set(1, 0, 0);
    lado.normalize();

    // A ordem importa, e é ela que dá estabilidade:
    //
    // 1. Superfície PARA ONDE O BICHO ANDA. É o gesto deliberado de trocar de
    //    plano -- andar contra a parede é dizer "quero subir por ali". Sem
    //    esta prioridade a escalada nunca começa, porque de pé no chão o chão
    //    está sempre mais perto do que a parede à frente.
    // 2. A superfície ATUAL, logo abaixo dos pés. Mantê-la enquanto existir é
    //    o que impede o vaivém: sem isso, perto do rodapé a parede e o chão
    //    disputam a cada quadro e o bicho fica pulando entre os dois.
    // 3. Qualquer coisa ao redor -- inclusive para trás e para baixo, que é o
    //    que faz dobrar por baixo da quina de uma mesa em vez de despencar.
    let melhor = null;
    if (querendoAndar) {
      melhor = this._sondar(this._reusar(1).copy(this.frente), agarrar);
    }
    if (!melhor) {
      melhor = this._sondar(this._reusar(0).copy(this.cima).negate(), alcance);
    }
    if (!melhor) {
      const direcoes = [
        this._reusar(2).copy(this.frente).negate(),
        this._reusar(3).copy(lado),
        this._reusar(4).copy(lado).negate(),
        this._reusar(5).copy(this.frente).negate().addScaledVector(this.cima, -1).normalize(),
      ];
      for (const dir of direcoes) {
        const toque = this._sondar(dir, alcance);
        if (toque && (!melhor || toque.distance < melhor.distance)) melhor = toque;
      }
    }

    if (!melhor) {
      this._voltarAoMundo(dt);
      return;
    }

    this._normal.copy(melhor.face.normal)
      .transformDirection(melhor.object.matrixWorld)
      .normalize();
    // A normal exportada pode apontar para dentro da parede. A que interessa é
    // a virada para o bicho; a outra empurraria a gravidade para o concreto.
    this._sonda.copy(this._centro).sub(melhor.point);
    if (this._normal.dot(this._sonda) < 0) this._normal.negate();

    this.escalando = this._normal.y < 0.72;
    // Suave: virar 90 graus num quadro só daria um tranco na câmera.
    this.cima.lerp(this._normal, Math.min(1, dt * 9)).normalize();
  }

  _sondar(dir, alcance) {
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 1e-8) return null;
    this._raioEscalada.set(this._centro, dir);
    this._raioEscalada.near = 0;
    this._raioEscalada.far = alcance;
    const toque = this._raioEscalada.intersectObject(this.colisor, true)[0];
    return toque?.face ? toque : null;
  }

  /** Vetores reaproveitados: a sonda roda todo quadro e não pode alocar. */
  _reusar(i) {
    this._pool ??= Array.from({ length: 7 }, () => new THREE.Vector3());
    return this._pool[i];
  }

  _voltarAoMundo(dt) {
    this.escalando = false;
    if (this.cima.y > 0.9995) return;
    this._sonda.set(0, 1, 0);
    this.cima.lerp(this._sonda, Math.min(1, dt * 6)).normalize();
  }

  /** Solta da parede: volta a ser um bicho com gravidade normal. */
  _largarSuperficie() {
    this.escalando = false;
    this.cima.set(0, 1, 0);
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
    this._velNormal = 0;
    this.cima.set(0, 1, 0);
    this.escalando = false;
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

    // ---- procura superfície para grudar (só lagartixa)
    if (this.escalar) {
      const querendoAndar = Boolean(
        entrada.frente || entrada.tras || entrada.esquerda || entrada.direita,
      );
      this._buscarSuperficie(dt, querendoAndar);
    }

    // ---- direcao desejada, relativa a camera
    //
    // O eixo da frente é o da câmera achatado no plano da SUPERFÍCIE, não no
    // plano do chão. Grudada numa parede, empurrar "para frente" sobe por ela.
    this._direcao.set(0, 0, 0);
    const eixoZ = new THREE.Vector3();

    if (this.escalar) {
      // A base sai da DIREITA da câmera, não da frente dela.
      //
      // Projetar a frente da câmera no plano da parede degenera justamente
      // quando se olha de frente para ela -- que é o momento em que se quer
      // subir. O que sobrava do vetor era o resto da inclinação, apontando
      // para BAIXO: segurar "para frente" empurrava o bicho contra o chão.
      // A direita da câmera continua paralela à parede nessa situação, então
      // dá uma base estável, e "para frente" vira "para cima na parede".
      this._sonda.set(1, 0, 0).applyQuaternion(camera.quaternion);
      this._sonda.addScaledVector(this.cima, -this._sonda.dot(this.cima));
      if (this._sonda.lengthSq() < 1e-6) this._sonda.set(1, 0, 0);
      this._sonda.normalize();
      eixoZ.crossVectors(this.cima, this._sonda).normalize();
    } else {
      camera.getWorldDirection(eixoZ);
      eixoZ.y = 0;
      eixoZ.normalize();
    }

    const eixoX = new THREE.Vector3().crossVectors(eixoZ, this.cima).negate();

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
    //
    // A gravidade age ao longo de `-cima`, não do Y do mundo. No chão os dois
    // são a mesma coisa; numa parede, é o que segura o bicho colado.
    this._velNormal += GRAVIDADE * dt;
    if (entrada.pular && this.noChao) {
      this._velNormal = this.impulsoPulo;
      this.noChao = false;
      // Pular numa parede é SOLTAR-SE dela: o impulso sai perpendicular à
      // superfície e o corpo volta a cair para o chão do mundo.
      if (this.escalando) this._largarSuperficie();
      this._trocarPara("Pular", 0.08);
    }

    this.posicao.addScaledVector(this._direcao, velocidade * dt * (andando ? 1 : 0));
    this.posicao.addScaledVector(this.cima, this._velNormal * dt);
    this.velocidade.copy(this.cima).multiplyScalar(this._velNormal);

    // Onde o corpo estava ANTES de a colisão empurrá-lo: é a diferença entre
    // isto e o depois que diz se ele progrediu ou bateu em alguma coisa.
    this._antesDoPasso.copy(this.posicao);
    const passoPretendido = velocidade * dt * (andando ? 1 : 0);
    this._resolverColisao(dt);
    if (andando) this._subirDegrau(passoPretendido);

    // ---- vira o corpo para a direcao do movimento
    if (andando) {
      // O personagem foi exportado olhando para +Z, entao atan2(x, z) alinha
      // direto, sem offset (ver orientar_para_z_positivo no script Python).
      const alvo = Math.atan2(this._direcao.x, this._direcao.z);
      let d = alvo - this.olhandoPara;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const giro = this._encaixarFrente ? 1 : Math.min(1, dt * 14);
      this.olhandoPara += d * giro;

      // Escalando, o giro não cabe num ângulo só: a frente é um vetor no plano
      // da superfície. Ele é suavizado para o corpo não estalar de direção ao
      // virar a esquina de uma quina.
      if (this.escalar) {
        this.frente.lerp(this._direcao, giro);
        this.frente.addScaledVector(this.cima, -this.frente.dot(this.cima));
        if (this.frente.lengthSq() < 1e-8) this.frente.set(0, 0, 1);
        this.frente.normalize();
      }
      this._encaixarFrente = false;
    }

    this._sincronizar();
    this._animar(dt, andando, velocidade);
  }

  _animar(dt, andando, velocidade) {
    if (this.poseFixa) {
      // Andando, usa o par que caminha da MESMA pose, se existir. Sem ele o
      // corpo desliza pelo chão com as patas paradas -- e a pose deixaria de
      // ser uma escolha para virar um defeito visível.
      const emMarcha = andando && this.noChao && this.acoes[`${this.poseFixa}Andar`];
      const alvo = emMarcha ? `${this.poseFixa}Andar` : this.poseFixa;
      this._trocarPara(alvo, 0.22);
      if (emMarcha) {
        // Casa o ciclo com o deslocamento, como no "Andar" normal, senão o pé
        // patina em quem anda devagar.
        this.acoes[alvo].timeScale = velocidade / this.avancoPorCiclo;
      }
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
  /**
   * Muda o tamanho do corpo -- e do que ele ocupa no mundo.
   *
   * O bônus surpresa não podia ser só a malha crescendo: encolhida, ela
   * precisa CABER onde não cabia, e crescida precisa deixar de caber. Isso é
   * a cápsula, não o desenho. A velocidade acompanha porque é a outra metade
   * da troca -- pequena se esconde melhor e corre pior, grande o contrário.
   */
  redimensionar(escala) {
    this.escala = escala;
    this.raio = this._raioBase * escala;
    this.altura = this._alturaBase * escala;
    this.capsula.start.set(0, this.raio, 0);
    this.capsula.end.set(0, Math.max(this.altura - this.raio, this.raio), 0);
    // Menor anda menos, maior anda mais -- mas não na proporção do tamanho,
    // que deixaria a grande rápida demais para um escritório fechado.
    const k = 1 + (escala - 1) * 0.6;
    this.velCaminhada = this._velBase.caminhada * k;
    this.velCorrida = this._velBase.corrida * k;
    this.modelo.scale.setScalar(escala);
    // Subir um degrau de gente encolhida seria teleporte; o degrau acompanha.
    this.alturaDoDegrau = (this._degrauBase ?? this.alturaDoDegrau) * escala;
  }

  /**
   * Sobe degraus curtos em vez de esbarrar neles.
   *
   * A cápsula só sabe ser EMPURRADA para fora do que encosta nela. Numa
   * escada isso vira o pior dos dois mundos: o espelho do degrau empurra o
   * corpo para trás, ele escorrega de lado, e quem joga se sacode no primeiro
   * degrau sem subir nenhum.
   *
   * A detecção é toda com sonda PARA BAIXO, e isso não é detalhe: a primeira
   * versão mirava o espelho do degrau com um raio horizontal e nunca acertava
   * nada. As faces do cenário são de um lado só, e a do espelho olha para
   * dentro do degrau -- o raio a atravessava como se não existisse. Faces de
   * chão olham para cima, que é a direção de onde este raio vem, e são as
   * mesmas que o resto do jogo já usa para achar piso.
   *
   * O gatilho é não ter PROGREDIDO: se o passo pretendido saiu quase todo,
   * não há degrau nenhum e não há o que fazer. É isso que impede o corpo de
   * flutuar para cima de coisas enquanto anda em campo aberto.
   */
  _subirDegrau(passoPretendido) {
    if (!this.noChao || this.alturaDoDegrau <= 0) return;
    if (passoPretendido <= 1e-4) return;

    // Quanto do passo sobreviveu à colisão, medido no plano da superfície.
    this._dDegrau.copy(this.posicao).sub(this._antesDoPasso);
    this._dDegrau.addScaledVector(this.cima, -this._dDegrau.dot(this.cima));
    if (this._dDegrau.length() > passoPretendido * 0.5) return;   // andou: sem degrau

    this._dDegrau.copy(this._direcao);
    this._dDegrau.addScaledVector(this.cima, -this._dDegrau.dot(this.cima));
    if (this._dDegrau.lengthSq() < 1e-6) return;
    this._dDegrau.normalize();

    // De cima do ponto logo à frente, olhando para baixo: onde está o piso?
    this._pDegrau.copy(this.posicao)
      .addScaledVector(this._dDegrau, this.raio + 0.15)
      .addScaledVector(this.cima, this.alturaDoDegrau + 0.15);
    this._raioDegrau.set(this._pDegrau, this._cimaInvertida.copy(this.cima).negate());
    this._raioDegrau.near = 0;
    this._raioDegrau.far = this.alturaDoDegrau + 0.3;
    const topo = this._raioDegrau.intersectObject(this.colisor, true)[0];
    if (!topo?.face) return;

    // Só sobe em superfície que dá para pisar: uma rampa quase vertical
    // devolveria o corpo para dentro dela no quadro seguinte.
    const normal = topo.face.normal.clone()
      .transformDirection(topo.object.matrixWorld);
    if (normal.dot(this.cima) < 0.5) return;

    const subida = this._pDegrau.copy(topo.point).sub(this.posicao).dot(this.cima);
    if (subida <= 0.02 || subida > this.alturaDoDegrau) return;

    // Sobe só a altura, sem avançar: quem avança é a caminhada do próximo
    // quadro, agora que o degrau deixou de estar no caminho.
    this.posicao.addScaledVector(this.cima, subida + 0.02);
    this._velNormal = 0;
  }

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

    const empurrar = {
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
    };

    bvh.shapecast(empurrar);
    // O telhado entra na mesma conta: sem ele, basta pular de cima de um móvel
    // para chegar ao topo das paredes e ver a planta inteira do escritório --
    // que numa caçada de esconde-esconde é o mesmo que ver todo mundo.
    for (const extra of this.coberturas) extra.geometry.boundsTree.shapecast(empurrar);

    this._delta.copy(this._seg.start).sub(this._antes);

    // Queda daquele frame como referencia: se a correcao vertical foi maior,
    // o que interrompeu a queda foi o chao, e nao um roçar em parede.
    // Projetado em `cima`, e não no Y do mundo: numa parede, "pousar" é ser
    // empurrado na direção da normal dela.
    const queda = Math.abs(dt * this._velNormal);
    this.noChao = this._delta.dot(this.cima) > Math.max(queda * 0.25, 1e-4);

    this.posicao.add(this._delta);

    if (this.noChao) {
      this.velocidade.set(0, 0, 0);
      this._velNormal = 0;
    } else if (this._delta.lengthSq() > 1e-10) {
      // Bateu em algo que nao e chao: remove so a componente da velocidade
      // que entrava na parede, preservando o deslize ao longo dela.
      this._delta.normalize();
      this.velocidade.addScaledVector(this._delta, -this._delta.dot(this.velocidade));
    }
  }

  /**
   * Ponto que a camera deve mirar: o peito, nao os pes.
   *
   * O afastamento sai ao longo de `cima`, e nao do Y do mundo. Grudada numa
   * parede, somar no Y deixava o ponto de mira DENTRO dela -- a sonda da
   * camera batia no concreto, o braço colapsava e a tela virava um bloco
   * marrom. Ao longo da normal, o alvo cai no ar livre do cômodo.
   */
  alvoDaCamera(destino) {
    return destino.copy(this.posicao).addScaledVector(this.cima, this.alvoCamera ?? 1.25);
  }
}

/** Teclado -> objeto de entrada, com WASD e setas. */
export function criarEntrada() {
  const teclas = new Set();
  const estado = {
    frente: false, tras: false, esquerda: false, direita: false,
    correndo: false, pular: false, agachado: false,
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
    // Agachar é SEGURAR, não alternar: quem se abaixa para olhar embaixo de
    // uma mesa quer levantar no instante em que vê -- e uma alternância deixa
    // a pessoa andando agachada pelo escritório sem perceber.
    estado.agachado = teclas.has("ControlLeft") || teclas.has("ControlRight");
    return estado;
  };
}
