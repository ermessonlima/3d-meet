/**
 * Cliente WebSocket do multiplayer.
 *
 * Só transporte: recebe eventos e os repassa por callbacks. Nada de three.js
 * aqui, para a camada de rede poder ser testada e depurada sem cena montada.
 */

const HZ_ENVIO = 15; // casa com o tick do servidor; mais que isso é desperdício

function urlDoServidor() {
  const protocolo = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocolo}//${location.host}/ws`;
}

export class Rede {
  constructor() {
    this.ws = null;
    this.meuId = null;
    this.sala = null;
    this.conectado = false;

    this._ultimoEnvio = 0;
    this._ultimoEstado = null;

    // Preenchidos por quem usa.
    this.aoEntrar = () => {};
    this.aoErro = () => {};
    this.aoJogadorEntrar = () => {};
    this.aoJogadorSair = () => {};
    this.aoEstados = () => {};
    this.aoFala = () => {};
    this.aoSinal = () => {};
    this.aoMidia = () => {};
    this.aoPintar = () => {};
    this.aoDano = () => {};
    this.aoReviver = () => {};
    this.aoDisparo = () => {};
    this.aoDesconectar = () => {};
  }

  /**
   * Abre a conexão e pede sala. `pedido` é {tipo:'criar'|'entrar', ...}.
   * Resolve quando o servidor confirma, rejeita com a mensagem dele.
   */
  conectar(pedido) {
    return new Promise((resolve, reject) => {
      let resolvido = false;
      const ws = new WebSocket(urlDoServidor());
      this.ws = ws;

      ws.addEventListener("open", () => ws.send(JSON.stringify(pedido)));

      ws.addEventListener("message", (evento) => {
        let msg;
        try {
          msg = JSON.parse(evento.data);
        } catch {
          return;
        }

        switch (msg.tipo) {
          case "bemvindo":
            this.meuId = msg.id;
            this.sala = { codigo: msg.codigo, nome: msg.nomeSala };
            this.conectado = true;
            resolvido = true;
            this.aoEntrar(msg);
            resolve(msg);
            break;

          case "erro":
            // Antes do "bemvindo" o erro é a resposta ao pedido de sala; depois
            // é um aviso durante a partida e não deve derrubar a promessa.
            if (!resolvido) {
              resolvido = true;
              reject(new Error(msg.mensagem));
              ws.close();
            } else {
              this.aoErro(msg.mensagem);
            }
            break;

          case "entrou": this.aoJogadorEntrar(msg.jogador); break;
          case "saiu": this.aoJogadorSair(msg.id); break;
          case "estados": this.aoEstados(msg.lista); break;
          case "fala": this.aoFala(msg); break;
          case "sinal": this.aoSinal(msg.de, msg.dados); break;
          case "midia": this.aoMidia(msg.id, msg.midia); break;
          case "pintar": this.aoPintar(msg.id, msg.cor); break;
          case "dano": this.aoDano(msg); break;
          case "reviver": this.aoReviver(msg); break;
          case "disparo": this.aoDisparo(msg); break;
        }
      });

      ws.addEventListener("close", () => {
        this.conectado = false;
        if (!resolvido) {
          resolvido = true;
          reject(new Error("não foi possível falar com o servidor"));
        } else {
          this.aoDesconectar();
        }
      });

      ws.addEventListener("error", () => {
        // O 'close' vem logo em seguida e carrega a rejeição; aqui só evitamos
        // o erro não tratado no console.
      });
    });
  }

  /**
   * Manda a própria posição, no máximo HZ_ENVIO vezes por segundo.
   *
   * Só envia quando algo mudou de verdade: parado em pé, um jogador não gasta
   * banda nenhuma, e o servidor mantém o último estado conhecido.
   */
  enviarEstado(posicao, yaw, anim, escondido = false) {
    if (!this.conectado || this.ws.readyState !== WebSocket.OPEN) return;

    const agora = performance.now();
    if (agora - this._ultimoEnvio < 1000 / HZ_ENVIO) return;

    const novo = [
      Math.round(posicao.x * 100) / 100,
      Math.round(posicao.y * 100) / 100,
      Math.round(posicao.z * 100) / 100,
      Math.round(yaw * 100) / 100,
      anim,
      escondido,
    ];
    if (this._ultimoEstado && novo.every((v, i) => v === this._ultimoEstado[i])) {
      return;
    }

    this._ultimoEnvio = agora;
    this._ultimoEstado = novo;
    this.ws.send(
      JSON.stringify({
        tipo: "estado", p: novo.slice(0, 3), y: novo[3], a: anim, e: escondido,
      }),
    );
  }

  falar(texto) {
    if (!this.conectado) return;
    this.ws.send(JSON.stringify({ tipo: "fala", texto }));
  }

  /** Envelope de negociação WebRTC para UM par. O servidor só repassa. */
  enviarSinal(para, dados) {
    if (!this.conectado) return;
    this.ws.send(JSON.stringify({ tipo: "sinal", para, dados }));
  }

  /** Avisa a sala de quais canais estão ligados, para os ícones dos outros. */
  enviarMidia(estado) {
    if (!this.conectado) return;
    this.ws.send(JSON.stringify({ tipo: "midia", ...estado }));
  }

  pintar(cor) {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "pintar", cor }));
  }

  atirar(alvo, origem, fim) {
    if (!this.conectado) return;
    const v = (p) => [
      Math.round(p.x * 100) / 100,
      Math.round(p.y * 100) / 100,
      Math.round(p.z * 100) / 100,
    ];
    this.ws.send(JSON.stringify({
      tipo: "tiro", alvo: alvo ?? null, o: v(origem), f: v(fim),
    }));
  }

  desconectar() {
    this.conectado = false;
    this.ws?.close();
  }
}
