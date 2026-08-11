/**
 * Captura local: câmera, microfone e tela.
 *
 * Tudo aqui exige **contexto seguro** -- `getUserMedia` e `getDisplayMedia`
 * simplesmente não existem fora de HTTPS ou localhost. Em produção sem TLS os
 * botões falham, e por isso `disponivel()` é checado antes de mostrá-los.
 *
 * As resoluções são propositalmente baixas. A sala é uma malha ponto a ponto:
 * cada participante envia o próprio vídeo para todos os outros. Com 6 pessoas
 * são 5 uploads simultâneos, e 720p ali entope a banda de subida de qualquer
 * conexão doméstica.
 */

const CAMERA = {
  video: {
    width: { ideal: 320 },
    height: { ideal: 240 },
    frameRate: { ideal: 20, max: 24 },
    facingMode: "user",
  },
};

const MICROFONE = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const TELA = {
  video: { frameRate: { ideal: 8, max: 12 }, displaySurface: "monitor" },
  audio: false, // compartilhar áudio do sistema volta como eco no alto-falante
};

export function disponivel() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function podeCompartilharTela() {
  return Boolean(navigator.mediaDevices?.getDisplayMedia);
}

/** Traduz os erros crus de permissão em algo que dá para mostrar na tela. */
function explicar(erro, oQue) {
  if (!disponivel()) {
    return `${oQue} exige HTTPS. Em http:// o navegador nem oferece a opção.`;
  }
  switch (erro?.name) {
    case "NotAllowedError":
      return `Permissão de ${oQue} negada. Libere no cadeado da barra de endereço.`;
    case "NotFoundError":
      return `Nenhum dispositivo de ${oQue} encontrado.`;
    case "NotReadableError":
      return `O ${oQue} está em uso por outro programa.`;
    default:
      return `Não foi possível ligar ${oQue}: ${erro?.message ?? erro}`;
  }
}

/**
 * Detecta se há voz na faixa, para acender o indicador de "falando".
 *
 * Usa o nível médio do sinal, não um VU meter preciso: só precisamos de um
 * booleano estável. O limiar e a soltura lenta evitam o indicador piscando a
 * cada pausa entre palavras.
 */
export class DetectorDeVoz {
  constructor(faixa) {
    this.contexto = new (window.AudioContext ?? window.webkitAudioContext)();
    this.analisador = this.contexto.createAnalyser();
    this.analisador.fftSize = 512;
    this.analisador.smoothingTimeConstant = 0.6;

    this.fonte = this.contexto.createMediaStreamSource(new MediaStream([faixa]));
    this.fonte.connect(this.analisador);

    this.dados = new Uint8Array(this.analisador.frequencyBinCount);
    this.falando = false;
    this._quietoDesde = 0;
  }

  amostrar() {
    this.analisador.getByteFrequencyData(this.dados);
    let soma = 0;
    for (const v of this.dados) soma += v;
    const media = soma / this.dados.length;

    const agora = performance.now();
    if (media > 12) {
      this.falando = true;
      this._quietoDesde = 0;
    } else if (this.falando) {
      // Segura por 400 ms: sem isso o indicador pisca entre as palavras.
      if (!this._quietoDesde) this._quietoDesde = agora;
      if (agora - this._quietoDesde > 400) this.falando = false;
    }
    return this.falando;
  }

  descartar() {
    this.fonte.disconnect();
    this.contexto.close();
  }
}

/**
 * Dono das faixas locais. Ligar/desligar troca a faixa nos pares já
 * conectados, sem refazer a negociação.
 */
export class MidiaLocal {
  constructor() {
    this.camera = null;      // MediaStreamTrack
    this.microfone = null;
    this.tela = null;
    this.detector = null;

    // Avisados quando algo muda, para a UI e o WebRTC reagirem.
    this.aoMudar = () => {};
  }

  get estado() {
    return {
      camera: Boolean(this.camera),
      microfone: Boolean(this.microfone),
      tela: Boolean(this.tela),
    };
  }

  async ligarCamera() {
    if (this.camera) return;
    try {
      const fluxo = await navigator.mediaDevices.getUserMedia(CAMERA);
      this.camera = fluxo.getVideoTracks()[0];
      this.camera.addEventListener("ended", () => this.desligarCamera());
      this.aoMudar("camera", this.camera);
    } catch (erro) {
      throw new Error(explicar(erro, "a câmera"));
    }
  }

  desligarCamera() {
    if (!this.camera) return;
    this.camera.stop();
    this.camera = null;
    this.aoMudar("camera", null);
  }

  async ligarMicrofone() {
    if (this.microfone) return;
    try {
      const fluxo = await navigator.mediaDevices.getUserMedia(MICROFONE);
      this.microfone = fluxo.getAudioTracks()[0];
      this.microfone.addEventListener("ended", () => this.desligarMicrofone());
      this.detector = new DetectorDeVoz(this.microfone);
      this.aoMudar("microfone", this.microfone);
    } catch (erro) {
      throw new Error(explicar(erro, "o microfone"));
    }
  }

  desligarMicrofone() {
    if (!this.microfone) return;
    this.microfone.stop();
    this.microfone = null;
    this.detector?.descartar();
    this.detector = null;
    this.aoMudar("microfone", null);
  }

  async ligarTela() {
    if (this.tela) return;
    try {
      const fluxo = await navigator.mediaDevices.getDisplayMedia(TELA);
      this.tela = fluxo.getVideoTracks()[0];
      // O navegador tem a própria barra de "parar compartilhamento"; quando o
      // usuário usa ela, a faixa termina e precisamos acompanhar.
      this.tela.addEventListener("ended", () => this.desligarTela());
      this.aoMudar("tela", this.tela);
    } catch (erro) {
      // Cancelar o seletor de janelas é NotAllowedError, mas não é um erro do
      // ponto de vista de quem clicou "cancelar".
      if (erro?.name === "NotAllowedError") return;
      throw new Error(explicar(erro, "o compartilhamento de tela"));
    }
  }

  desligarTela() {
    if (!this.tela) return;
    this.tela.stop();
    this.tela = null;
    this.aoMudar("tela", null);
  }

  desligarTudo() {
    this.desligarCamera();
    this.desligarMicrofone();
    this.desligarTela();
  }
}
