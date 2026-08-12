import * as THREE from "three";

const PITCH_MIN = -0.30;   // olhando de baixo para cima
const PITCH_MAX = 1.15;    // quase de cima
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

    this.yaw = 0;
    this.pitch = 0.35;
    this.distancia = 5.0;      // o que o usuario pediu na roda do mouse
    this.distanciaAtual = 5.0; // o que a colisao permite agora

    this.ativa = false;
    this._esquerdoPreso = false;
    this._direitoPreso = false;
    this._moveu = false;
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
  }

  ativar() {
    this.ativa = true;
    this.dom.addEventListener("pointerdown", this._aoDescer);
    addEventListener("pointerup", this._aoSubir);
    addEventListener("pointermove", this._aoMover);
    this.dom.addEventListener("wheel", this._aoRolar, { passive: false });
    // Sem isto o botão direito abre o menu do navegador no meio do tiroteio.
    this.dom.addEventListener("contextmenu", this._semMenu);
  }

  desativar() {
    this.ativa = false;
    this._esquerdoPreso = false;
    this._direitoPreso = false;
    this._moveu = false;
    // `aoClicar` NÃO é zerado aqui: quem registrou o callback foi o main, uma
    // vez só. Limpá-lo faria o clique parar de funcionar ao sair e voltar do
    // modo andar.
    this.dom.removeEventListener("pointerdown", this._aoDescer);
    removeEventListener("pointerup", this._aoSubir);
    removeEventListener("pointermove", this._aoMover);
    this.dom.removeEventListener("wheel", this._aoRolar);
    this.dom.removeEventListener("contextmenu", this._semMenu);
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
  _aoDescer(evento) {
    if (evento.button === 0) {
      this._esquerdoPreso = true;
      this._moveu = false;
      this._inicioX = evento.clientX;
      this._inicioY = evento.clientY;
    } else if (evento.button === 2) {
      this._direitoPreso = true;
      this._direitoDesde = performance.now();
      this._moveu = false;
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
      if (era && !this._moveu && this.ativa) this.aoClicar(evento);
      return;
    }

    if (evento.button === 2) {
      const foiToque =
        this._direitoPreso &&
        performance.now() - this._direitoDesde < TOQUE_MS &&
        !this._moveu;
      this._direitoPreso = false;
      this.aoMirar(false);
      if (foiToque && this.ativa) this.aoTocarDireito();
    }
  }

  _aoMover(evento) {
    if (!this.ativa) return;
    if (!this._esquerdoPreso && !this._direitoPreso) return;

    // O limiar de arrasto vale para o esquerdo, que também é gatilho: sem ele,
    // o tremor da mão ao clicar viraria giro. Com o direito segurado a pessoa
    // está mirando, e ali qualquer movimento tem que virar giro na hora --
    // esperar 5 px daria sensação de mira travada.
    if (!this._moveu) {
      const andou = Math.hypot(
        evento.clientX - this._inicioX,
        evento.clientY - this._inicioY,
      );
      if (!this._direitoPreso && andou < ARRASTO_MIN) return;
      this._moveu = true;
    }

    const sens = 0.0032;
    this.yaw -= evento.movementX * sens;
    this.pitch += evento.movementY * sens;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch));
  }

  _aoRolar(evento) {
    if (!this.ativa) return;
    evento.preventDefault();
    this.distancia += evento.deltaY * 0.0022;
    this.distancia = Math.max(DIST_MIN, Math.min(DIST_MAX, this.distancia));
  }

  /** Aponta a camera para `alvo` respeitando as paredes entre os dois. */
  atualizar(dt, alvo) {
    const cp = Math.cos(this.pitch);
    this._dir.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ).normalize();

    const permitida = this._sondar(alvo, this.distancia);

    // Encolher e urgente -- qualquer atraso deixa a parede aparecer entre a
    // lente e o personagem. Esticar de volta pode ser suave, e o movimento
    // fica bem menos nervoso ao passar por batentes de porta.
    if (permitida < this.distanciaAtual) {
      this.distanciaAtual = permitida;
    } else {
      const k = 1 - Math.exp(-4.5 * dt);
      this.distanciaAtual += (permitida - this.distanciaAtual) * k;
    }

    this.camera.position.copy(alvo).addScaledVector(this._dir, this.distanciaAtual);
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
    }

    return Math.max(livre, DIST_MIN * 0.35);
  }
}
