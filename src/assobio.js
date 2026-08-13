import * as THREE from "three";

/**
 * O assobio da lagartixa, em áudio espacial.
 *
 * O som é sintetizado aqui em vez de vir de um arquivo: são dois chiados de
 * 0,3 s, e um WAV disso custaria mais bytes de rede do que as vinte linhas que
 * o desenham. Também deixa o timbre ajustável sem voltar num editor de áudio.
 *
 * Espacial de verdade (`PositionalAudio`): o volume cai com a distância e o som
 * chega antes num ouvido do que no outro, então dá para virar a cabeça na
 * direção do chiado. É essa direção que transforma o assobio em pista de caça
 * em vez de um aviso genérico de "tem uma por perto".
 */

const DURACAO = 0.34;
// Perto do agudo de uma osga de verdade, e bem longe das frequências do resto
// do jogo -- passo, tiro e voz -- para não se confundir com nada.
const F_BASE = 2100;

/** Desenha o chiado numa faixa de áudio. */
function sintetizar(ctx) {
  const taxa = ctx.sampleRate;
  const total = Math.floor(taxa * DURACAO);
  const faixa = ctx.createBuffer(1, total, taxa);
  const dados = faixa.getChannelData(0);

  // Duas sílabas: "tchi-tchi". Uma só soa como bipe de aparelho.
  const silabas = [
    { inicio: 0.0, fim: 0.11 },
    { inicio: 0.17, fim: 0.30 },
  ];

  let fase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / taxa;
    const silaba = silabas.find((s) => t >= s.inicio && t < s.fim);
    if (!silaba) {
      dados[i] = 0;
      continue;
    }

    const k = (t - silaba.inicio) / (silaba.fim - silaba.inicio);
    // Cai de tom ao longo da sílaba, como um chiado de bicho.
    const freq = F_BASE * (1.25 - 0.4 * k);
    fase += (freq * 2 * Math.PI) / taxa;

    // Ataque rápido e queda suave: sem envelope, o corte seco vira um "click".
    const env = Math.min(1, k / 0.08) * Math.pow(1 - k, 1.6);
    // A terceira harmônica dá a aspereza; a senoide pura soa a flauta.
    dados[i] = env * 0.42 * (Math.sin(fase) + 0.35 * Math.sin(fase * 3));
  }
  return faixa;
}

export class Assobios {
  constructor(camera) {
    this.ouvinte = new THREE.AudioListener();
    camera.add(this.ouvinte);
    this.faixa = null;
    this.vozes = new Map();   // id -> PositionalAudio
  }

  /**
   * O navegador só deixa tocar som depois de um gesto do usuário, e o
   * contexto nasce suspenso. Chamar isto no clique de entrar na sala resolve;
   * chamado depois, não faz mal nenhum.
   */
  liberar() {
    const ctx = this.ouvinte.context;
    if (ctx.state === "suspended") ctx.resume();
    if (!this.faixa) this.faixa = sintetizar(ctx);
  }

  /** Prende uma voz ao objeto, para o som sair de onde o bicho está. */
  registrar(id, objeto) {
    this.liberar();
    if (this.vozes.has(id)) this.remover(id);

    const voz = new THREE.PositionalAudio(this.ouvinte);
    voz.setBuffer(this.faixa);
    // `refDistance` é onde o volume ainda é cheio; a partir daí cai. Com o
    // alcance de 14 m que o servidor usa para nem enviar o evento, isto deixa
    // o assobio quase inaudível na borda e forte a poucos metros.
    voz.setRefDistance(1.6);
    voz.setRolloffFactor(2.2);
    voz.setDistanceModel("exponential");
    objeto.add(voz);
    this.vozes.set(id, voz);
  }

  remover(id) {
    const voz = this.vozes.get(id);
    if (!voz) return;
    if (voz.isPlaying) voz.stop();
    voz.parent?.remove(voz);
    this.vozes.delete(id);
  }

  tocar(id) {
    const voz = this.vozes.get(id);
    if (!voz?.buffer) return;
    // Reiniciar em vez de ignorar: dois assobios seguidos são informação, e
    // engolir o segundo esconderia que a lagartixa se mexeu.
    if (voz.isPlaying) voz.stop();
    voz.play();
  }

  limpar() {
    for (const id of [...this.vozes.keys()]) this.remover(id);
  }
}
