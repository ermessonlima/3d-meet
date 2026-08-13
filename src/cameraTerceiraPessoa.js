import * as THREE from "three";

const PITCH_MIN = -0.30;   // olhando de baixo para cima
const PITCH_MAX = 1.15;    // quase de cima
// Quanto a lente pode recuar por segundo ao encontrar obstáculo.
const VEL_ENCOLHER = 18;
const DIST_MIN = 1.4;
const DIST_MAX = 8.0;

// Folga entre a camera e a parede em que ela encostou. Sem isso o plano de
// corte proximo entra na geometria e a parede "abre" na frente da lente.
const MARGEM = 0.22;
// Raio da sonda: em vez de um raio unico do alvo ate a camera, disparamos
// tambem quatro raios deslocados. Um raio so passa entre o batente e a parede
// em quinas estreitas, e a camera atravessa.
const RAIO_SONDA = 0.3;

// Abaixo disto o gesto ainda conta como clique. Cinco pixels absorvem o tremor
// natural da mão sem engolir arrastos curtos de câmera.
const ARRASTO_MIN = 5;

// Altura dos olhos num personagem de 1,79 m.
const ALTURA_OLHOS = 1.62;

const FOV_NORMAL = 50;

// Soltar o botão direito antes disto, sem ter arrastado, conta como toque.
const TOQUE_MS = 260;

/**
 * Camera de terceira pessoa com braco telescopico (spring arm).
 *
 * Nao usa OrbitControls de proposito. O OrbitControls recalcula o raio a
 * partir da posicao real da camera a cada update; se puxassemos a camera para
 * perto ao encostar numa parede, ele leria essa distancia encurtada como o
 * novo zoom do usuario e a camera nunca mais voltaria para tras.
 */
export class CameraTerceiraPessoa {
  constructor(camera, dom, colisor) {
    this.camera = camera;
    this.dom = dom;
    this.colisor = colisor;
    /** Colisores de teto; veja `construirCobertura` e `construirTampa`. */
    this.coberturas = [];

    this.yaw = 0;
    this.pitch = 0.35;
    this.distancia = 5.0;      // o que o usuario pediu na roda do mouse
    this.distanciaAtual = 5.0; // o que a colisao permite agora

    this.ativa = false;
    /** Em primeira pessoa o esquerdo é só gatilho; quem olha é o ponteiro. */
    this.primeiraPessoa = false;
    /**
     * No ateliê o esquerdo é pincel, não câmera: girar a cena no meio de um
     * traço tiraria a tinta do lugar onde a pessoa estava mirando.
     */
    this.pincelando = false;
    this.distanciaPintura = 0.62;
    /** Altura dos olhos em primeira pessoa; sobrescrita por quem tem outro corpo. */
    this.alturaDosOlhos = ALTURA_OLHOS;
    /**
     * Deslocamento lateral e vertical do alvo, em metros.
     *
     * É o que tira o personagem do centro exato da tela e o joga para um canto,
     * deixando o cômodo à frente ocupar o resto -- o enquadramento "por cima do
     * ombro".
     */
    this.ombro = { lado: 0, altura: 0 };
    /** Fica true depois de falhas seguidas ao capturar o ponteiro. */
    this.capturaIndisponivel = false;
    this._falhasDeCaptura = 0;
    this._tentativaPendente = false;
    /** Dentro de iframe a captura é bloqueada sem allow="pointer-lock". */
    this.emIframe = (() => {
      try { return window.self !== window.top; } catch { return true; }
    })();
    this._esquerdoPreso = false;
    this._direitoPreso = false;
    // Uma flag de "arrastou" POR BOTÃO. Compartilhar uma só entre os dois foi
    // um bug real: segurando o direito para olhar, o movimento marcava
    // "arrastou", e o clique esquerdo era descartado como arrasto -- não dava
    // para atirar enquanto se virava a câmera.
    this._moveuEsquerdo = false;
    this._moveuDireito = false;
    this._inicioX = 0;
    this._inicioY = 0;
    this._direitoDesde = 0;

    /** Clique esquerdo sem arrasto. */
    this.aoClicar = () => {};
    /** Botão direito pressionado (true) ou solto (false). */
    this.aoMirar = () => {};
    /** Toque curto no botão direito -- mirar e atirar no mesmo gesto. */
    this.aoTocarDireito = () => {};

    this._raio = new THREE.Raycaster();
    this._raio.firstHitOnly = true;
    this._dir = new THREE.Vector3();
    this._direita = new THREE.Vector3();
    this._cima = new THREE.Vector3();
    this._origem = new THREE.Vector3();
    this._desejada = new THREE.Vector3();

    this._aoMover = this._aoMover.bind(this);
    this._aoDescer = this._aoDescer.bind(this);
    this._aoSubir = this._aoSubir.bind(this);
    this._aoRolar = this._aoRolar.bind(this);
    this._semMenu = (e) => e.preventDefault();
    this._aoErroDeCaptura = () => this._falhouCaptura();
    this._aoMudarCaptura = this._aoMudarCaptura.bind(this);
  }

  ativar() {
    this.ativa = true;
    this.dom.addEventListener("pointerdown", this._aoDescer);
    addEventListener("pointerup", this._aoSubir);
    addEventListener("pointermove", this._aoMover);
    this.dom.addEventListener("wheel", this._aoRolar, { passive: false });
    // Sem isto o botão direito abre o menu do navegador no meio do tiroteio.
    this.dom.addEventListener("contextmenu", this._semMenu);
    document.addEventListener("pointerlockerror", this._aoErroDeCaptura);
    document.addEventListener("pointerlockchange", this._aoMudarCaptura);
  }

  desativar() {
    this.ativa = false;
    this._esquerdoPreso = false;
    this._direitoPreso = false;
    this._moveuEsquerdo = false;
    this._moveuDireito = false;
    // NÃO se zera aqui: `aoClicar` (registrado uma vez pelo main),
    // `primeiraPessoa` (decidido pelo papel escolhido no lobby) nem
    // `capturaIndisponivel` (fato sobre o navegador). Zerar qualquer um deles
    // quebra a volta da órbita para o modo andar -- o clique pararia de
    // funcionar, ou o FPS viraria terceira pessoa.
    this.dom.removeEventListener("pointerdown", this._aoDescer);
    removeEventListener("pointerup", this._aoSubir);
    removeEventListener("pointermove", this._aoMover);
    this.dom.removeEventListener("wheel", this._aoRolar);
    this.dom.removeEventListener("contextmenu", this._semMenu);
    document.removeEventListener("pointerlockerror", this._aoErroDeCaptura);
    document.removeEventListener("pointerlockchange", this._aoMudarCaptura);
    clearTimeout(this._conferirCaptura);
    if (this.travada) document.exitPointerLock();
  }

  /**
   * O botão esquerdo faz duas coisas, e elas se separam pelo movimento.
   *
   * Arrastar gira a câmera; clicar sem arrastar é uma ordem de movimento para
   * aquele ponto do chão. Guardamos onde o clique começou e comparamos na
   * soltura: até ARRASTO_MIN pixels ainda é clique.
   *
   * Foi por isso que a captura de ponteiro saiu. Ela era boa para olhar em
   * volta, mas some com o cursor -- e sem cursor não há como mirar um ponto no
   * chão. As duas coisas não cabem no mesmo botão.
   */
  /**
   * A câmera é a dona do mouse.
   *
   * Antes o combate registrava os próprios listeners no mesmo canvas, e as
   * duas coisas se atropelavam: girar dependia do botão ESQUERDO, então
   * segurar o direito para mirar deixava a câmera travada; e o esquerdo
   * disparava no `pointerdown`, então começar um arrasto para girar soltava
   * um tiro.
   *
   * Agora a câmera interpreta os gestos e avisa por callback:
   *
   *   esquerdo arrastando .... gira
   *   esquerdo sem arrastar .. aoClicar (gatilho)
   *   direito pressionado .... aoMirar(true) -- e girar continua funcionando
   *   direito solto rápido ... aoTocarDireito (mirar e atirar num gesto só)
   */
  get travada() {
    return document.pointerLockElement === this.dom;
  }

  /**
   * Pede a captura do ponteiro (mouse livre, jeito de FPS).
   *
   * Só faz sentido em primeira pessoa. Pode ser recusada -- dentro de um
   * iframe sem `allow="pointer-lock"` o navegador nega com SecurityError, e no
   * Chrome recente a recusa chega como Promise rejeitada. Engolimos a falha
   * porque existe o caminho alternativo: arrastar com o botão DIREITO.
   */
  capturarPonteiro() {
    if (this.travada || this.capturaIndisponivel) return;
    if (!this.dom.requestPointerLock) {
      this.capturaIndisponivel = true;   // navegador sem a API
      return;
    }

    // Uma tentativa por vez. Sem esta marca, a MESMA falha era contada três
    // vezes -- a promessa rejeitada, o evento `pointerlockerror` e o relógio
    // de conferência disparam todos juntos -- e o limite de duas falhas era
    // estourado logo na primeira tentativa.
    this._tentativaPendente = true;

    try {
      const pedido = this.dom.requestPointerLock();
      // NÃO inferir sucesso pelo retorno: Firefox e Safari devolvem
      // `undefined` e travam o mouse assim mesmo. Quem diz se funcionou é o
      // `pointerlockchange`, conferido logo abaixo pelo relógio.
      if (pedido && typeof pedido.catch === "function") {
        pedido.catch(() => this._falhouCaptura());
      }
    } catch {
      this._falhouCaptura();
      return;
    }

    clearTimeout(this._conferirCaptura);
    this._conferirCaptura = setTimeout(() => {
      if (!this.travada) this._falhouCaptura();
    }, 350);
  }

  /**
   * Uma tentativa falhou. Só desiste depois de DUAS seguidas.
   *
   * Desistir na primeira era errado: depois de o usuário apertar Esc, o
   * navegador impõe cerca de um segundo de carência antes de aceitar uma nova
   * captura. Clicar rápido demais nessa janela é falha temporária, e marcar
   * "indisponível" ali matava o mouse preso pelo resto da sessão.
   */
  _falhouCaptura() {
    if (!this._tentativaPendente) return;   // já contabilizada
    this._tentativaPendente = false;
    clearTimeout(this._conferirCaptura);
    this._falhasDeCaptura += 1;
    if (this._falhasDeCaptura >= 2) this.capturaIndisponivel = true;
  }

  _aoMudarCaptura() {
    if (this.travada) {
      // Funcionou: zera o histórico de falhas e reabilita o caminho normal.
      clearTimeout(this._conferirCaptura);
      this._falhasDeCaptura = 0;
    this._tentativaPendente = false;
      this.capturaIndisponivel = false;
    }
  }

  _aoDescer(evento) {
    if (evento.button === 0) {
      // Em primeira pessoa, o primeiro clique captura o mouse em vez de
      // atirar: sem isso a pessoa dispara sem querer só para poder olhar.
      if (this.primeiraPessoa && !this.travada && !this.capturaIndisponivel) {
        this.capturarPonteiro();
        this._esquerdoPreso = false;
        return;
      }

      // Em primeira pessoa o esquerdo dispara ao PRESSIONAR. Ele não gira a
      // câmera, então não existe arrasto para diferenciar -- e esperar a
      // soltura era o que fazia o tiro se perder quando a outra mão estava
      // girando a câmera com o direito.
      if (this.primeiraPessoa) {
        this._esquerdoPreso = true;
        if (this.ativa) this.aoClicar(evento);
        return;
      }

      this._esquerdoPreso = true;
      this._moveuEsquerdo = false;
      this._inicioX = evento.clientX;
      this._inicioY = evento.clientY;
      // Pintando, o esquerdo já foi tratado por quem desenha; marcar como
      // "arrastou" impede que a soltura vire um clique de jogo.
      if (this.pincelando) this._moveuEsquerdo = true;
    } else if (evento.button === 2) {
      this._direitoPreso = true;
      this._direitoDesde = performance.now();
      this._moveuDireito = false;
      this._inicioX = evento.clientX;
      this._inicioY = evento.clientY;
      evento.preventDefault();
      this.aoMirar(true);
    }
  }

  _aoSubir(evento) {
    if (!evento) return;

    if (evento.button === 0) {
      const era = this._esquerdoPreso;
      this._esquerdoPreso = false;
      // Na primeira pessoa já disparou no `pointerdown`.
      if (era && !this.primeiraPessoa && !this._moveuEsquerdo && this.ativa) {
        this.aoClicar(evento);
      }
      return;
    }

    if (evento.button === 2) {
      const foiToque =
        this._direitoPreso &&
        performance.now() - this._direitoDesde < TOQUE_MS &&
        !this._moveuDireito;
      this._direitoPreso = false;
      this.aoMirar(false);
      if (foiToque && this.ativa) this.aoTocarDireito();
    }
  }

  _aoMover(evento) {
    if (!this.ativa) return;

    // Quem pode girar a câmera:
    //   ponteiro capturado ..... sempre (FPS de verdade)
    //   direito segurado ....... sim, é o alternativo quando a captura falha
    //   esquerdo arrastando .... SÓ em terceira pessoa
    //
    // O esquerdo é o gatilho. Deixá-lo girar em primeira pessoa faz a mira
    // escorregar a cada tiro, que é o que estava estranho.
    const podeGirar =
      this._direitoPreso ||
      (!this.pincelando && (this.travada ||
        (!this.primeiraPessoa && this._esquerdoPreso)));
    if (!podeGirar) return;

    // Com o ponteiro capturado o cursor não anda, então não há arrasto a
    // medir: todo movimento é olhar.
    if (!this.travada) {
      const andou = Math.hypot(
        evento.clientX - this._inicioX,
        evento.clientY - this._inicioY,
      );
      if (this._direitoPreso) {
        this._moveuDireito = true;      // cancela o "toque" de disparo
      } else {
        if (andou < ARRASTO_MIN) return; // ainda pode virar clique
        this._moveuEsquerdo = true;
      }
    }

    const sens = 0.0032;
    this.yaw -= evento.movementX * sens;
    this.pitch += evento.movementY * sens;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch));
  }

  _aoRolar(evento) {
    if (!this.ativa) return;
    evento.preventDefault();
    if (this.pincelando) {
      // No ateliê a faixa é outra: o bicho tem 26 cm, e o mínimo de 1,4 m que
      // serve para uma pessoa deixaria o corpo do tamanho de uma unha.
      this.distanciaPintura += evento.deltaY * 0.0006;
      this.distanciaPintura = Math.max(0.22, Math.min(1.6, this.distanciaPintura));
      return;
    }
    this.distancia += evento.deltaY * 0.0022;
    this.distancia = Math.max(DIST_MIN, Math.min(DIST_MAX, this.distancia));
  }

  /**
   * Primeira pessoa: a câmera É o olho do personagem.
   *
   * Existe porque em terceira pessoa a linha de tiro nunca coincide com a
   * linha de visão -- a arma está na mão, a câmera está sobre o ombro, e todo
   * disparo sai em diagonal até o alvo. Dá para compensar por projeção, mas o
   * resultado continua estranho de perto. Aqui o problema não existe: a mira
   * sai do olho, e a arma é um viewmodel colado na câmera.
   *
   * Sem braço telescópico e sem sonda de parede: não há nada entre a lente e
   * o personagem para colidir.
   */
  atualizarPrimeiraPessoa(dt, pes) {
    // Campo de visão fixo. O botão direito não aproxima: o zoom deslocava a
    // imagem inteira a cada toque, e como ele também é atalho de tiro, isso
    // acontecia justamente na hora de mirar.
    if (this.camera.fov !== FOV_NORMAL) {
      this.camera.fov = FOV_NORMAL;
      this.camera.updateProjectionMatrix();
    }

    const cp = Math.cos(this.pitch);
    this._dir.set(
      -Math.sin(this.yaw) * cp,
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    ).normalize();

    // A altura dos olhos vem de fora: 1,62 m é a de uma pessoa, e numa
    // lagartixa de 26 cm a câmera ficaria cinco corpos acima da cabeça dela.
    this.camera.position.set(pes.x, pes.y + (this.alturaDosOlhos ?? ALTURA_OLHOS), pes.z);
    this.camera.lookAt(
      this._origem.copy(this.camera.position).addScaledVector(this._dir, 10),
    );
    this.distanciaAtual = 0;
  }

  /** Direção para onde a câmera aponta no plano, para o corpo acompanhar. */
  get direcaoNoPlano() {
    return Math.atan2(-Math.sin(this.yaw), -Math.cos(this.yaw));
  }

  /** Aponta a camera para `alvo` respeitando as paredes entre os dois. */
  /**
   * O menor valor que a sonda deu nos últimos quadros.
   *
   * Cinco raios contra geometria de escritório dão respostas instáveis: basta
   * a quina de uma cadeira entrar e sair do caminho de UM deles para a
   * distância permitida saltar de 2,2 m para 0,5 m e voltar, várias vezes por
   * segundo. Encolher é instantâneo de propósito (senão a parede aparece na
   * frente do personagem), então cada leitura solta virava um tranco.
   *
   * Guardando o mínimo de uma janela curta, um quadro "livre" isolado não
   * estica a câmera de volta -- ela só volta a abrir quando o caminho fica
   * livre de verdade, por alguns quadros seguidos. É conservador na direção
   * certa: no pior caso a lente fica mais perto do que precisava.
   */
  _menorRecente(valor) {
    this._janela ??= [];
    this._janela.push(valor);
    if (this._janela.length > 8) this._janela.shift();
    let menor = Infinity;
    for (const v of this._janela) menor = Math.min(menor, v);
    return menor;
  }

  /**
   * Alvo amortecido, usado no lugar do ponto cru do jogador.
   *
   * A cápsula treme no lugar por natureza: a gravidade a empurra contra o
   * chão todo quadro e a colisão a devolve, o que dá um vaivém de milímetros.
   * Isso passava despercebido até a sonda da câmera começar a raspar no teto
   * -- aí um milímetro de origem decide se um dos cinco raios pega a quina ou
   * não, e a distância permitida saltava de 4 m para 2,8 m e voltava, várias
   * vezes por segundo. Amortecer a ORIGEM mata o salto na fonte, em vez de
   * remendar o resultado.
   */
  _suavizarAlvo(dt, alvo) {
    if (!this._alvoSuave) {
      this._alvoSuave = alvo.clone();
    } else {
      const k = 1 - Math.exp(-22 * dt);
      // Longe demais é troca de lugar (nascer, sentar, trocar de câmera), e aí
      // seguir suavemente faria a lente atravessar meio escritório.
      if (this._alvoSuave.distanceToSquared(alvo) > 4) this._alvoSuave.copy(alvo);
      else this._alvoSuave.lerp(alvo, k);
    }
    return this._alvoSuave;
  }

  atualizar(dt, alvoCru) {
    const alvo = this._suavizarAlvo(dt, alvoCru);
    const cp = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).normalize();

    const permitida = this._menorRecente(this._sondar(alvo, this.distancia));

    // Encolher é urgente, mas não instantâneo.
    //
    // Instantâneo, um obstáculo que entra no caminho tirava 1,7 m da lente num
    // único quadro -- e é isso que se sente como tranco. Limitado a 18 m/s, o
    // mesmo recuo leva uns 90 ms: rápido demais para a parede chegar a aparecer
    // na frente do personagem, devagar o bastante para ler como movimento em
    // vez de corte. Esticar de volta segue mais lento ainda, senão o vaivém ao
    // passar por um batente de porta fica nervoso.
    if (permitida < this.distanciaAtual) {
      this.distanciaAtual = Math.max(permitida, this.distanciaAtual - VEL_ENCOLHER * dt);
    } else {
      const k = 1 - Math.exp(-4.5 * dt);
      this.distanciaAtual += (permitida - this.distanciaAtual) * k;
    }

    this.camera.position.copy(alvo).addScaledVector(this._dir, this.distanciaAtual);
    if (this.ombro.lado || this.ombro.altura) {
      // Move a LENTE, não o alvo: mover o alvo faria a câmera girar em volta de
      // um ponto ao lado do bicho, e ele descreveria um arco ao virar.
      this._direita.set(this._dir.z, 0, -this._dir.x).normalize();
      this.camera.position.addScaledVector(this._direita, this.ombro.lado);
      this.camera.position.y += this.ombro.altura;
    }
    this.camera.lookAt(alvo);
  }

  /**
   * Enquadramento de pintura: bem perto do bicho, sem sondar parede.
   *
   * O limite normal de 1,4 m existe para não enfiar a lente dentro de um
   * personagem de 1,8 m -- numa lagartixa de 26 cm ele deixa o corpo do
   * tamanho de uma unha, e não dá para pintar o que não se enxerga. A colisão
   * também sai de cena: aqui ninguém anda, e a câmera encostar na parede é
   * menos ruim do que ela pular para trás no meio de um traço.
   */
  enquadrarPintura(dt, alvo, distancia) {
    const cp = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).normalize();
    this.distanciaAtual = distancia;
    this.camera.position.copy(alvo).addScaledVector(this._dir, distancia);
    this.camera.lookAt(alvo);
  }

  /**
   * Enquadramento de mira: câmera sobre o ombro, olhando para o MUNDO.
   *
   * O enquadramento normal aponta a câmera para o próprio jogador, e é por
   * isso que ele não serve para atirar: a cruz no centro da tela cai nas
   * costas do personagem, e o raio de tiro sai da lente em direção a ele --
   * nunca ao alvo. Aqui a câmera se desloca para o ombro e passa a olhar ao
   * LONGO da direção de visão, não para o corpo. Só então a cruz significa
   * alguma coisa.
   */
  enquadrarMira(dt, alvo) {
    const cp = Math.cos(this.pitch);
    // `_dir` aponta da câmera para a frente do mundo (o oposto do modo normal,
    // onde ele aponta do alvo para a câmera).
    this._dir.set(
      -Math.sin(this.yaw) * cp,
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    ).normalize();

    this._direita.set(-this._dir.z, 0, this._dir.x).normalize();

    // Ombro direito, um pouco acima: o corpo ocupa o canto do quadro e a linha
    // de tiro fica limpa.
    this._desejada.copy(alvo)
      .addScaledVector(this._direita, 0.42)
      .addScaledVector(this._dir, -1.5);
    this._desejada.y += 0.28;

    const k = 1 - Math.exp(-14 * dt);
    this.camera.position.lerp(this._desejada, k);
    this.camera.lookAt(
      this._origem.copy(this.camera.position).addScaledVector(this._dir, 20),
    );
    this.distanciaAtual = 1.5;
  }

  /**
   * Enquadramento de conversa: o rosto do NPC de frente, o jogador de costas
   * na borda do quadro.
   *
   * A camera vai para o lado do eixo NPC-jogador em vez de ficar sobre ele --
   * exatamente em cima da linha, o jogador taparia o NPC. Continua passando
   * pela sonda de parede, senao o enquadramento entraria dentro do movel mais
   * proximo em salas apertadas.
   */
  enquadrarConversa(dt, alvoNpc, posicaoJogador) {
    const eixo = this._origem
      .subVectors(posicaoJogador, alvoNpc)
      .setY(0)
      .normalize();

    // Gira ~38 graus em torno de Y para sair da linha reta.
    const a = 0.66;
    const cos = Math.cos(a);
    const sen = Math.sin(a);
    this._dir.set(
      eixo.x * cos - eixo.z * sen,
      0.16,
      eixo.x * sen + eixo.z * cos,
    ).normalize();

    const desejada = 2.3;
    const permitida = Math.max(this._sondar(alvoNpc, desejada), 0.9);

    // Aproxima o alvo em vez de saltar: a troca de modo fica com cara de corte
    // de camera suave em vez de teleporte.
    this._desejada.copy(alvoNpc).addScaledVector(this._dir, permitida);
    const k = 1 - Math.exp(-6 * dt);
    this.camera.position.lerp(this._desejada, k);
    this.camera.lookAt(alvoNpc);

    // Mantem yaw/pitch coerentes com onde a camera parou, para nao dar um
    // salto quando a conversa terminar e o braco normal reassumir.
    this.yaw = Math.atan2(this._dir.x, this._dir.z);
    this.distanciaAtual = permitida;
  }

  /**
   * Distancia livre entre o alvo e a camera desejada.
   *
   * Dispara o raio central mais quatro deslocados na secao do braco, e fica
   * com o menor. E uma aproximacao barata de um spherecast: sem os laterais, a
   * camera entra por frestas de quina e por batentes estreitos.
   */
  _sondar(alvo, desejada) {
    this._direita.set(this._dir.z, 0, -this._dir.x);
    if (this._direita.lengthSq() < 1e-8) this._direita.set(1, 0, 0);
    this._direita.normalize();
    this._cima.crossVectors(this._direita, this._dir).normalize();

    let livre = desejada;
    const alcance = desejada + MARGEM;

    for (let i = 0; i < 5; i++) {
      this._origem.copy(alvo);
      if (i === 1) this._origem.addScaledVector(this._direita, RAIO_SONDA);
      else if (i === 2) this._origem.addScaledVector(this._direita, -RAIO_SONDA);
      else if (i === 3) this._origem.addScaledVector(this._cima, RAIO_SONDA);
      else if (i === 4) this._origem.addScaledVector(this._cima, -RAIO_SONDA);

      this._raio.set(this._origem, this._dir);
      this._raio.near = 0;
      this._raio.far = alcance;

      const toque = this._raio.intersectObject(this.colisor, true)[0];
      if (toque) livre = Math.min(livre, toque.distance - MARGEM);
      // O telhado mora num colisor à parte e precisa entrar aqui também: sem
      // isto a lente sobe pela laje e a câmera olha o escritório de cima, que
      // é exatamente o que fechar o telhado foi feito para impedir.
      for (const extra of this.coberturas) {
        const teto = this._raio.intersectObject(extra, true)[0];
        if (teto) livre = Math.min(livre, teto.distance - MARGEM);
      }
    }

    return Math.max(livre, DIST_MIN * 0.35);
  }
}
