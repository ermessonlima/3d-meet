import * as THREE from "three";

/**
 * Câmera de espectador: voa pela cena, sem corpo e sem colisão.
 *
 * Atravessa parede de propósito. Quem está aqui já saiu da rodada, então não
 * há nada a proteger -- e uma câmera de espectador que emperra em batente de
 * porta é pior do que inútil para acompanhar uma caçada que corre pelo
 * escritório inteiro.
 *
 * O controle é o de sempre em editor 3D: WASD anda no plano da visão, Espaço e
 * Shift sobem e descem, e o mouse olha em volta -- com o ponteiro preso quando
 * o navegador deixa, arrastando quando não deixa.
 */

const VEL_BASE = 4.2;      // m/s
const VEL_RAPIDA = 11;     // segurando Ctrl
const SENSIBILIDADE = 0.0028;
const PITCH_MAX = Math.PI / 2 - 0.02;

export class CameraLivre {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.ativa = false;

    this.yaw = 0;
    this.pitch = 0;
    this.posicao = new THREE.Vector3();
    this.teclas = new Set();
    this.travada = false;

    this._arrastando = false;
    this._dir = new THREE.Vector3();
    this._lado = new THREE.Vector3();
    this._acima = new THREE.Vector3(0, 1, 0);

    this._aoDescer = this._aoDescer.bind(this);
    this._aoSubir = this._aoSubir.bind(this);
    this._aoMover = this._aoMover.bind(this);
    this._aoTecla = this._aoTecla.bind(this);
    this._aoSoltar = this._aoSoltar.bind(this);
    this._aoMudarCaptura = this._aoMudarCaptura.bind(this);
    this._semMenu = (e) => e.preventDefault();
  }

  /** Começa de onde a câmera do jogo estava, para não haver salto. */
  assumir(de = this.camera) {
    this.olhouComMouse = false;
    this.posicao.copy(de.position);
    const alvo = new THREE.Vector3();
    de.getWorldDirection(alvo);
    this.yaw = Math.atan2(-alvo.x, -alvo.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(alvo.y, -1, 1));
  }

  ativar() {
    if (this.ativa) return;
    this.ativa = true;
    this.dom.addEventListener("pointerdown", this._aoDescer);
    addEventListener("pointerup", this._aoSubir);
    addEventListener("pointermove", this._aoMover);
    addEventListener("keydown", this._aoTecla);
    addEventListener("keyup", this._aoSoltar);
    this.dom.addEventListener("contextmenu", this._semMenu);
    document.addEventListener("pointerlockchange", this._aoMudarCaptura);
  }

  desativar() {
    if (!this.ativa) return;
    this.ativa = false;
    this.teclas.clear();
    this._arrastando = false;
    this.dom.removeEventListener("pointerdown", this._aoDescer);
    removeEventListener("pointerup", this._aoSubir);
    removeEventListener("pointermove", this._aoMover);
    removeEventListener("keydown", this._aoTecla);
    removeEventListener("keyup", this._aoSoltar);
    this.dom.removeEventListener("contextmenu", this._semMenu);
    document.removeEventListener("pointerlockchange", this._aoMudarCaptura);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  _aoDescer(evento) {
    if (evento.target !== this.dom) return;
    if (evento.button === 0 && !this.travada) {
      // Tenta prender o ponteiro; se o navegador recusar, o arrasto abaixo
      // continua servindo.
      this.dom.requestPointerLock?.();
    }
    this._arrastando = true;
  }

  _aoSubir() {
    this._arrastando = false;
  }

  _aoMudarCaptura() {
    this.travada = document.pointerLockElement === this.dom;
  }

  _aoMover(evento) {
    if (!this.ativa || (!this.travada && !this._arrastando)) return;
    this.yaw -= evento.movementX * SENSIBILIDADE;
    this.pitch -= evento.movementY * SENSIBILIDADE;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch));
    // Quem pegou o mouse quer olhar para onde quer. Quem só usa o teclado, na
    // câmera de amiga, quer dar a volta nela sem perdê-la de vista -- é isto
    // que separa os dois casos.
    this.olhouComMouse = true;
  }

  _aoTecla(evento) {
    if (!this.ativa) return;
    // Enquanto se digita no chat, W e S são letras, não movimento.
    const alvo = evento.target;
    if (alvo instanceof HTMLInputElement || alvo instanceof HTMLTextAreaElement) return;
    this.teclas.add(evento.code);
  }

  _aoSoltar(evento) {
    this.teclas.delete(evento.code);
  }

  atualizar(dt) {
    if (!this.ativa) return;

    const cp = Math.cos(this.pitch);
    this._dir.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this._lado.crossVectors(this._dir, this._acima).normalize();

    const vel = this.teclas.has("ControlLeft") || this.teclas.has("ControlRight")
      ? VEL_RAPIDA
      : VEL_BASE;
    const passo = vel * dt;

    if (this.teclas.has("KeyW")) this.posicao.addScaledVector(this._dir, passo);
    if (this.teclas.has("KeyS")) this.posicao.addScaledVector(this._dir, -passo);
    if (this.teclas.has("KeyD")) this.posicao.addScaledVector(this._lado, passo);
    if (this.teclas.has("KeyA")) this.posicao.addScaledVector(this._lado, -passo);
    if (this.teclas.has("Space")) this.posicao.y += passo;
    if (this.teclas.has("ShiftLeft") || this.teclas.has("ShiftRight")) {
      this.posicao.y -= passo;
    }

    // Coleira: a lagartixa VIVA não sai de perto do próprio corpo.
    //
    // Quem já foi achada voa pelo prédio inteiro sem custo -- não há mais nada
    // a proteger. Viva é outra coisa: sem limite, a câmera livre seria um
    // drone de reconhecimento, e olhar em volta viraria saber onde cada
    // caçador está. Com a coleira ela continua servindo para o que foi pedida
    // (conferir o próprio esconderijo, olhar o cômodo do lado) e para
    // acompanhar as amigas -- que têm câmera própria, sem coleira, porque ali
    // o alvo é uma aliada e não o mapa.
    if (this.coleira) {
      const { centro, raio } = this.coleira;
      const fora = this.posicao.distanceTo(centro);
      if (fora > raio) {
        this.posicao.sub(centro).multiplyScalar(raio / fora).add(centro);
      }
    }

    this.camera.position.copy(this.posicao);
    this.camera.lookAt(this.posicao.clone().add(this._dir));
  }

  /**
   * Vira a lente para um ponto, sem tirar o controle de quem voa.
   *
   * A câmera de amiga usa isto para manter a lagartixa no quadro enquanto se
   * dá a volta nela: só o WASD move, e o alvo continua no meio da tela. Assim
   * que alguém mexe o mouse, `olhouComMouse` desliga a mira -- reenquadrar
   * volta a ligá-la.
   */
  mirarEm(ponto, dt) {
    if (this.olhouComMouse) return;
    _mira.subVectors(ponto, this.posicao);
    if (_mira.lengthSq() < 1e-6) return;
    _mira.normalize();

    const yawAlvo = Math.atan2(-_mira.x, -_mira.z);
    const pitchAlvo = Math.asin(THREE.MathUtils.clamp(_mira.y, -1, 1));
    let d = yawAlvo - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    // Amortecido, não instantâneo: colado no alvo a lente estala a cada passo
    // lateral, e o enjoo é imediato.
    const k = Math.min(1, dt * 9);
    this.yaw += d * k;
    this.pitch += (pitchAlvo - this.pitch) * k;
    this.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, this.pitch));

    const cp = Math.cos(this.pitch);
    this._dir.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.camera.lookAt(this.posicao.clone().add(this._dir));
  }
}

const _mira = new THREE.Vector3();
