/**
 * Malha WebRTC: áudio, vídeo e tela entre os jogadores da sala.
 *
 * O servidor só carrega os envelopes da negociação (oferta, resposta,
 * candidatos ICE). O áudio e o vídeo vão direto de navegador para navegador.
 *
 * ## Duas decisões que definem este arquivo
 *
 * **Quem liga para quem.** Cada par decide comparando os próprios ids: só o
 * lado com o id "menor" cria a oferta. Como os dois fazem a mesma comparação
 * e chegam ao mesmo resultado, nunca há duas ofertas cruzadas (glare) -- que
 * é a origem clássica de conexões que ficam presas em "connecting".
 *
 * **Transceptores fixos, criados antes da primeira oferta.** Reservamos três
 * canais (áudio, câmera, tela) já na abertura, mesmo vazios. Ligar a câmera
 * depois vira um `replaceTrack` no canal que já existe -- sem renegociar,
 * sem nova troca de SDP, sem risco de glare. A alternativa (adicionar faixas
 * conforme o usuário liga) obrigaria a renegociar toda vez, com todos.
 *
 * O preço é que a ordem dos canais é o contrato entre os dois lados: o `mid`
 * "0" é áudio, "1" é câmera, "2" é tela, e é assim que o lado que recebe sabe
 * se um vídeo que chegou é rosto ou tela compartilhada.
 */

const CANAIS = ["microfone", "camera", "tela"];

// STUN público descobre o IP externo e serve para a maioria das redes
// domésticas. NÃO cobre NAT simétrico (algumas redes corporativas e móveis):
// nesses casos a conexão precisa de um servidor TURN, que retransmite a mídia
// e tem custo de banda -- não há como embutir um aqui.
const ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

class Par {
  constructor(id, malha) {
    this.id = id;
    this.malha = malha;
    this.fechado = false;

    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.canais = {}; // microfone|camera|tela -> RTCRtpTransceiver
    this.faixas = { microfone: null, camera: null, tela: null };

    this.pc.addEventListener("icecandidate", (evento) => {
      if (evento.candidate) {
        malha.enviarSinal(id, { candidato: evento.candidate });
      }
    });

    this.pc.addEventListener("track", (evento) => {
      const canal = CANAIS[Number(evento.transceiver.mid)];
      if (!canal) return;

      // A faixa é guardada SEMPRE, mesmo nascendo muda -- e é o normal que
      // nasça: `ontrack` dispara na negociação, antes de qualquer mídia
      // fluir.
      //
      // Não usamos `muted` nem os eventos mute/unmute para inferir "ligado".
      // Eles não acompanham o `replaceTrack` do outro lado: quem liga a
      // câmera depois da negociação não gera evento nenhum aqui, e a faixa
      // ficaria descartada para sempre. Quem diz o que está ligado é a
      // mensagem `midia`, que o dono envia explicitamente.
      this.faixas[canal] = evento.track;
      malha.aoFaixa(id, canal, evento.track);
    });

    this.pc.addEventListener("connectionstatechange", () => {
      malha.aoEstado(id, this.pc.connectionState);
      if (this.pc.connectionState === "failed") {
        // Reiniciar o ICE é mais barato e menos disruptivo do que refazer a
        // conexão do zero quando a rede muda (trocar de Wi-Fi, por exemplo).
        if (malha.souOIniciador(id)) this.renegociar(true);
      }
    });
  }

  /** Reserva os três canais. Só o iniciador faz isso; o outro lado recebe. */
  prepararCanais() {
    this.canais.microfone = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    this.canais.camera = this.pc.addTransceiver("video", {
      direction: "sendrecv",
    });
    this.canais.tela = this.pc.addTransceiver("video", {
      direction: "sendrecv",
    });
  }

  /** Depois da negociação, associa os transceptores pelo mid acordado. */
  mapearCanais() {
    for (const transceptor of this.pc.getTransceivers()) {
      const canal = CANAIS[Number(transceptor.mid)];
      if (canal) this.canais[canal] = transceptor;
    }
  }

  async renegociar(reiniciarIce = false) {
    const oferta = await this.pc.createOffer({ iceRestart: reiniciarIce });
    await this.pc.setLocalDescription(oferta);
    this.malha.enviarSinal(this.id, { descricao: this.pc.localDescription });
  }

  /** Troca o que estamos enviando naquele canal. Não renegocia. */
  async enviar(canal, faixa) {
    const transceptor = this.canais[canal];
    if (!transceptor) return;
    try {
      await transceptor.sender.replaceTrack(faixa ?? null);
    } catch (erro) {
      console.warn("[webrtc] replaceTrack falhou em", canal, erro);
    }
  }

  fechar() {
    this.fechado = true;
    this.pc.close();
  }
}

export class MalhaWebRTC {
  /**
   * @param {string} meuId
   * @param {(para:string, dados:object) => void} enviarSinal
   */
  constructor(meuId, enviarSinal) {
    this.meuId = meuId;
    this.enviarSinal = enviarSinal;
    this.pares = new Map();
    this.locais = { microfone: null, camera: null, tela: null };

    // Callbacks de UI.
    this.aoFaixa = () => {};
    this.aoEstado = () => {};
  }

  /** O lado com o id lexicograficamente menor liga; o outro atende. */
  souOIniciador(id) {
    return this.meuId < id;
  }

  async conectar(id) {
    if (this.pares.has(id) || id === this.meuId) return;

    const par = new Par(id, this);
    this.pares.set(id, par);

    if (this.souOIniciador(id)) {
      par.prepararCanais();
      // Aplica o que já está ligado antes de ofertar, para a primeira
      // negociação já sair com as faixas certas.
      for (const canal of CANAIS) {
        if (this.locais[canal]) await par.enviar(canal, this.locais[canal]);
      }
      await par.renegociar();
    }
  }

  desconectar(id) {
    this.pares.get(id)?.fechar();
    this.pares.delete(id);
  }

  async receberSinal(de, dados) {
    let par = this.pares.get(de);
    if (!par) {
      // O outro lado ofertou antes de sabermos dele; aceitamos e seguimos.
      await this.conectar(de);
      par = this.pares.get(de);
      if (!par) return;
    }

    try {
      if (dados.descricao) {
        await par.pc.setRemoteDescription(dados.descricao);

        if (dados.descricao.type === "offer") {
          par.mapearCanais();

          // Forçar sendrecv antes de responder é o que mantém a promessa de
          // "negociar uma vez só".
          //
          // Sem isto, quem responde sem nenhuma faixa ligada (o caso normal:
          // entra na sala com câmera e microfone desligados) responde
          // `recvonly`. O transceptor fica travado em "só recebo", e ligar a
          // câmera depois não envia nada -- o `replaceTrack` funciona, mas não
          // há para onde mandar. O sintoma é cruel: sem erro, sem log, e o
          // outro lado simplesmente nunca vê a imagem.
          for (const canal of CANAIS) {
            const transceptor = par.canais[canal];
            if (transceptor) transceptor.direction = "sendrecv";
          }

          for (const canal of CANAIS) {
            if (this.locais[canal]) await par.enviar(canal, this.locais[canal]);
          }
          const resposta = await par.pc.createAnswer();
          await par.pc.setLocalDescription(resposta);
          this.enviarSinal(de, { descricao: par.pc.localDescription });
        } else {
          par.mapearCanais();
        }
      } else if (dados.candidato) {
        await par.pc.addIceCandidate(dados.candidato);
      }
    } catch (erro) {
      console.warn("[webrtc] sinal de", de, "falhou:", erro);
    }
  }

  /** Liga/desliga um canal em TODOS os pares de uma vez. */
  async definirFaixa(canal, faixa) {
    this.locais[canal] = faixa ?? null;
    await Promise.all(
      [...this.pares.values()].map((par) => par.enviar(canal, faixa ?? null)),
    );
  }

  fecharTudo() {
    for (const par of this.pares.values()) par.fechar();
    this.pares.clear();
  }
}
