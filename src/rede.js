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

// O mesmo teto do servidor (tools/multiplayer.js). Enviar acima disso derruba
// o quadro inteiro no `maxPayload` do ws, sem erro visível.
export const LIMITE_TEXTURA = 96 * 1024;

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
    this.aoTextura = () => {};
    this.aoFase = () => {};
    this.aoSala = () => {};
    this.aoEliminado = () => {};
    this.aoReposicionar = () => {};
    this.aoRecado = () => {};
    this.aoCauda = () => {};
    this.aoCuspe = () => {};
    this.aoCuspeVisto = () => {};
    this.aoEscuro = () => {};
    this.aoAssobio = () => {};
    // Poderes de quem caça. Vazios por padrão como todos os outros: quem joga
    // de lagartixa nunca chega a atribuir metade deles.
    this.aoBatida = () => {};
    this.aoBatidaSentida = () => {};
    this.aoSensor = () => {};
    this.aoSensorFora = () => {};
    this.aoSensorApitou = () => {};
    this.aoRede = () => {};
    this.aoPo = () => {};
    this.aoMarcas = () => {};
    this.aoPingando = () => {};
    this.aoDisjuntor = () => {};
    this.aoDisjuntorPronto = () => {};
    this.aoDisjuntorCancelado = () => {};
    this.aoLimparCampo = () => {};
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
          case "textura": this.aoTextura(msg.id, msg.dados); break;
          case "fase": this.aoFase(msg); break;
          case "sala": this.aoSala(msg); break;
          case "eliminado": this.aoEliminado(msg); break;
          case "reposicionar": this.aoReposicionar(msg); break;
          case "recado": this.aoRecado(msg.texto); break;
          case "assobio": this.aoAssobio(msg); break;
          case "cauda": this.aoCauda(msg); break;
          case "cuspe": this.aoCuspe(msg); break;
          case "cuspe-visto": this.aoCuspeVisto(msg); break;
          case "escuro": this.aoEscuro(msg); break;
          case "dano": this.aoDano(msg); break;
          case "reviver": this.aoReviver(msg); break;
          case "disparo": this.aoDisparo(msg); break;
          // ---- poderes de quem caça
          case "batida": this.aoBatida(msg); break;
          case "batida-sentida": this.aoBatidaSentida(msg); break;
          case "sensor": this.aoSensor(msg); break;
          case "sensor-fora": this.aoSensorFora(msg); break;
          case "sensor-apitou": this.aoSensorApitou(msg); break;
          case "rede": this.aoRede(msg); break;
          case "po": this.aoPo(msg); break;
          case "marcas": this.aoMarcas(msg); break;
          case "pingando": this.aoPingando(msg); break;
          case "disjuntor": this.aoDisjuntor(msg); break;
          case "disjuntor-pronto": this.aoDisjuntorPronto(msg); break;
          case "disjuntor-cancelado": this.aoDisjuntorCancelado(msg); break;
          case "limpar-campo": this.aoLimparCampo(msg); break;
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
  enviarEstado(posicao, yaw, anim, escondido = false, pitch = 0, cima = null, frente = null) {
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
      Math.round(pitch * 100) / 100,
      cima ? `${cima.x.toFixed(2)},${cima.y.toFixed(2)},${cima.z.toFixed(2)}` : "",
      frente ? `${frente.x.toFixed(2)},${frente.y.toFixed(2)},${frente.z.toFixed(2)}` : "",
    ];
    if (this._ultimoEstado && novo.every((v, i) => v === this._ultimoEstado[i])) {
      return;
    }

    this._ultimoEnvio = agora;
    this._ultimoEstado = novo;
    this.ws.send(
      JSON.stringify({
        tipo: "estado", p: novo.slice(0, 3), y: novo[3], a: anim, e: escondido,
        t: novo[6],
        // Só sobem se houver escalada em curso; o campo vazio economiza o
        // pacote de quem anda no chão, que é a maioria do tempo.
        ...(cima && cima.y < 0.999
          ? { c: [+cima.x.toFixed(2), +cima.y.toFixed(2), +cima.z.toFixed(2)],
              f: [+frente.x.toFixed(2), +frente.y.toFixed(2), +frente.z.toFixed(2)] }
          : {}),
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

  /**
   * Pede um poder ao servidor.
   *
   * Pedido, não fato: quem decide se vale (papel, fase, espera, alcance) e
   * quanto custa em assobio é o servidor.
   */
  /** Pede para voltar à posição de alguns segundos atrás. */
  destravar(motivo) {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "destravar", motivo }));
  }

  usarPoder(qual, extras = {}) {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "poder", qual, ...extras }));
  }

  iniciarRodada() {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "iniciar" }));
  }

  /** Corta o preparo e começa a caçada agora. */
  pularPreparo() {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "pular" }));
  }

  /** Recomeça a rodada do preparo, com todo mundo de pé e no nascimento. */
  reiniciarRodada() {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "reiniciar" }));
  }

  pintar(cor) {
    if (this.conectado) this.ws.send(JSON.stringify({ tipo: "pintar", cor }));
  }

  /**
   * Manda o atlas pintado à mão.
   *
   * Vai como PNG em data URL. É grande perto do resto do protocolo (dezenas de
   * KB contra dezenas de bytes), então só sai ao fim de uma pincelada, nunca
   * durante -- e o servidor recusa acima do teto dele.
   */
  pintarTextura(dataUrl) {
    if (!this.conectado || typeof dataUrl !== "string") return;
    if (dataUrl.length > LIMITE_TEXTURA) {
      console.warn("[rede] pintura grande demais, descartada:", dataUrl.length);
      return;
    }
    this.ws.send(JSON.stringify({ tipo: "textura", dados: dataUrl }));
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
