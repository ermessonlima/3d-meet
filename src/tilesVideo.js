/**
 * Faixa de vídeos no topo e o palco de tela compartilhada.
 *
 * ## Quem manda no que aparece
 *
 * A faixa WebRTC é só o cano; quem decide o que mostrar é a mensagem `midia`
 * que o servidor retransmite quando alguém liga ou desliga um canal.
 *
 * Isso não é redundância. A primeira versão usava os eventos `mute`/`unmute`
 * da faixa recebida para inferir o estado, e ela falha em silêncio: o
 * `replaceTrack` do emissor **não** dispara esses eventos no receptor. Os
 * eventos aparecem na negociação inicial (a faixa nasce muda até a mídia
 * fluir) e nunca mais -- então desligar a câmera não desligava nada do outro
 * lado, e religar não trazia de volta.
 *
 * Guardamos toda faixa que chega e reavaliamos a exibição quando qualquer um
 * dos dois lados muda: faixa nova ou estado novo.
 *
 * O áudio fica num `<audio>` separado, nunca no `<video>`. É o que permite
 * esconder ou pausar o vídeo sem calar a pessoa.
 */

import { icone } from "./icones.js";

export class TilesVideo {
  constructor() {
    this.faixa = document.getElementById("tiles");
    this.palco = document.getElementById("tela-compartilhada");
    this.palcoVideo = this.palco.querySelector("video");
    this.palcoNome = this.palco.querySelector(".quem");
    this.tiles = new Map();
    this.telaDe = null;

    this.palco.querySelector(".fechar").addEventListener("click", () => {
      this._esconderPalco();
      // Fechar é escolha de quem assiste; marcamos para não reabrir sozinho
      // no próximo quadro que chegar.
      this.telaDispensada = this.telaDe;
      this.telaDe = null;
    });
    this.telaDispensada = null;
  }

  garantir(dados) {
    if (this.tiles.has(dados.id)) return this.tiles.get(dados.id);

    const raiz = document.createElement("figure");
    raiz.className = "tile";
    raiz.style.setProperty("--c", dados.cor ?? "#6ea8fe");

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // o som vem pelo <audio>; aqui daria eco

    const semVideo = document.createElement("div");
    semVideo.className = "sem-video";
    semVideo.textContent = (dados.nome ?? "?").slice(0, 1).toUpperCase();

    const legenda = document.createElement("figcaption");
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = dados.nome ?? "?";
    const icones = document.createElement("span");
    icones.className = "icones";
    legenda.append(nome, icones);

    const audio = document.createElement("audio");
    audio.autoplay = true;

    raiz.append(semVideo, video, legenda);
    this.faixa.append(raiz, audio);

    const tile = {
      raiz, video, audio, semVideo, icones,
      dados,
      faixas: { camera: null, microfone: null, tela: null },
      midia: dados.midia ?? { camera: false, microfone: false, tela: false },
    };
    this.tiles.set(dados.id, tile);
    this.faixa.hidden = false;
    this._reavaliar(dados.id);
    return tile;
  }

  remover(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.video.srcObject = null;
    tile.audio.srcObject = null;
    tile.raiz.remove();
    tile.audio.remove();
    this.tiles.delete(id);
    if (this.telaDe === id) this._esconderPalco();
    if (this.telaDispensada === id) this.telaDispensada = null;
    this.faixa.hidden = this.tiles.size === 0;
  }

  /** Uma faixa chegou (ou sumiu) pelo WebRTC. */
  definirFaixa(id, canal, faixa) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.faixas[canal] = faixa ?? null;
    this._reavaliar(id);
  }

  /** O dono avisou quais canais estão ligados. Esta é a fonte da verdade. */
  aplicarMidia(id, midia) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.midia = {
      camera: midia?.camera === true,
      microfone: midia?.microfone === true,
      tela: midia?.tela === true,
    };
    // Parar de compartilhar e recomeçar deve reabrir o palco para quem havia
    // fechado antes.
    if (!tile.midia.tela && this.telaDispensada === id) {
      this.telaDispensada = null;
    }
    this._reavaliar(id);
  }

  _reavaliar(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;

    const mostrarCamera = tile.midia.camera && tile.faixas.camera;
    tile.video.srcObject = mostrarCamera
      ? new MediaStream([tile.faixas.camera])
      : null;
    tile.raiz.classList.toggle("com-video", Boolean(mostrarCamera));

    // O áudio é ligado sempre que existir: se a pessoa desligou o microfone,
    // o emissor já parou de mandar, e manter o elemento pronto evita um
    // sobressalto de autoplay quando ela voltar a falar.
    const audio = tile.faixas.microfone;
    if (audio && tile.audio.srcObject?.getTracks()[0] !== audio) {
      tile.audio.srcObject = new MediaStream([audio]);
      tile.audio.play?.().catch(() => {});
    } else if (!audio) {
      tile.audio.srcObject = null;
    }

    // Ícones em SVG, não emoji: herdam a cor do CSS, têm traço consistente e
    // não mudam de desenho entre sistemas operacionais.
    const marcas = [];
    if (!tile.midia.microfone) marcas.push(icone("mic-off", { tamanho: 13 }));
    if (tile.midia.tela) marcas.push(icone("monitor", { tamanho: 13 }));
    tile.icones.replaceChildren(...marcas);

    if (tile.midia.tela && tile.faixas.tela && this.telaDispensada !== id) {
      this._mostrarPalco(id, tile);
    } else if (this.telaDe === id && !tile.midia.tela) {
      this._esconderPalco();
    }
  }

  _mostrarPalco(id, tile) {
    if (this.telaDe === id && !this.palco.hidden) return;
    this.telaDe = id;
    this.palcoVideo.srcObject = new MediaStream([tile.faixas.tela]);
    this.palcoNome.textContent = tile.dados.nome ?? "alguém";
    this.palco.hidden = false;
  }

  _esconderPalco() {
    this.palcoVideo.srcObject = null;
    this.palco.hidden = true;
    this.telaDe = null;
  }

  definirFalando(id, falando) {
    this.tiles.get(id)?.raiz.classList.toggle("falando", Boolean(falando));
  }

  limpar() {
    for (const id of [...this.tiles.keys()]) this.remover(id);
    this._esconderPalco();
  }
}
