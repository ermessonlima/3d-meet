import * as THREE from "three";

import { carregarPersonagem } from "./carregarModelo.js";
import { Balao, criarEtiqueta, descartarEtiqueta } from "./etiquetas.js";
import { pintarRemoto } from "./lagartixa.js";
import {
  isolarMateriais,
  garantirUV,
  aplicarPinturaRemota,
  limparPinturaRemota,
} from "./pinturaLagartixa.js";

// A lagartixa tem um modelo só; os humanos, um por personagem escolhido.
const CAMINHO = (dados) =>
  dados.papel === "lagartixa"
    ? "/models/lagartixa.glb"
    : `/models/personagens/${dados.personagem}.glb`;

// O servidor manda estado a 15 Hz, mas a tela roda a 60. Sem interpolação os
// avatares andariam aos saltos. Atrasamos a exibição em um intervalo de
// pacote e desenhamos SEMPRE entre dois estados já recebidos -- é melhor
// mostrar 66 ms no passado e suave do que extrapolar e errar.
const ATRASO_MS = 90;

/** Um avatar de outro jogador. */
class Remoto {
  constructor(dados, modelo, clipes) {
    this.id = dados.id;
    this.nome = dados.nome;
    this.cor = dados.cor;
    this.papel = dados.papel ?? "pessoa";
    this.escondido = false;

    this.raiz = new THREE.Group();
    this.raiz.add(modelo);

    this.mixer = new THREE.AnimationMixer(modelo);
    this.acoes = {};
    for (const clipe of clipes) {
      const acao = this.mixer.clipAction(clipe);
      if (clipe.name === "Pular") {
        acao.setLoop(THREE.LoopRepeat);
      }
      this.acoes[clipe.name] = acao;
    }
    this.animAtual = null;
    this._trocarAnim("Parado");

    this.buffer = [];  // {t, p:Vector3, yaw}
    if (this.papel === "lagartixa") {
      // Cada lagartixa precisa dos próprios materiais: o `clone` de avatares
      // reaproveita as instâncias do GLB, e sem isolar a cor de uma valeria
      // para todas.
      isolarMateriais(this.raiz);
      garantirUV(this.raiz);
      pintarRemoto(this.raiz, dados.pintura ?? "#5f9e4a", false);
      if (dados.textura) this.pintarTextura(dados.textura);
    }
    // Lagartixa NÃO tem etiqueta. Um nome flutuando sobre o bicho anula a
    // camuflagem inteira: não adianta pintar do tom exato do carpete se um
    // rótulo legível aponta para o esconderijo.
    this.etiqueta =
      this.papel === "lagartixa" ? null : criarEtiqueta(this.nome, this.cor);
    if (this.etiqueta) {
      this.etiqueta.position.set(0, 2.05, 0);
      this.raiz.add(this.etiqueta);
    }

    // Pelo mesmo motivo, a lagartixa não estoura balão de fala no mundo: o que
    // ela escrever aparece só no chat lateral.
    this.balao =
      this.papel === "lagartixa" ? null : new Balao(this.raiz, 2.42);
  }

  _trocarAnim(nome) {
    const proxima = this.acoes[nome];
    if (!proxima || this.animAtual === proxima) return;
    proxima.enabled = true;
    proxima.setEffectiveWeight(1);
    proxima.play();
    if (this.animAtual) this.animAtual.crossFadeTo(proxima, 0.15, false);
    this.animAtual = proxima;
  }

  receber(estado, agora) {
    if (this.papel === "lagartixa" && estado.e !== this.escondido) {
      this.escondido = Boolean(estado.e);
      pintarRemoto(this.raiz, null, this.escondido);
    }
    this.buffer.push({
      t: agora,
      p: new THREE.Vector3(estado.p[0], estado.p[1], estado.p[2]),
      yaw: estado.y,
      anim: estado.a,
    });
    // Dois estados bastam para interpolar; guardamos alguns a mais como folga
    // para engasgo de rede.
    while (this.buffer.length > 8) this.buffer.shift();
  }

  dizer(texto) {
    this.balao?.dizer(texto);
  }

  limparTextura() {
    limparPinturaRemota(this.raiz);
  }

  pintarTextura(dataUrl) {
    aplicarPinturaRemota(this.raiz, dataUrl).catch((erro) =>
      console.error("[remotos] pintura inválida de", this.nome, erro),
    );
  }

  atualizar(dt, agora, camera) {
    this.mixer.update(dt);

    const alvo = agora - ATRASO_MS;
    const b = this.buffer;

    // Acha o par de estados que cerca o instante que queremos mostrar.
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > alvo) i--;

    if (!b.length) {
      // ainda não chegou nada
    } else if (b.length === 1 || i === 0) {
      // Sem duas amostras cercando o instante alvo, salta para a mais recente.
      //
      // `i === 0` significa que TUDO no buffer é mais novo que o alvo, ou
      // seja, estamos atrasados em relação ao fluxo. Acontece ao voltar de uma
      // aba em segundo plano: o navegador congela os timers, as mensagens se
      // acumulam e chegam todas juntas. Sem este ramo, a condição `i > 0`
      // falhava e o avatar simplesmente não era posicionado -- ficava parado
      // na origem do mundo, com a animação inicial.
      const ultimo = b[b.length - 1];
      this.raiz.position.copy(ultimo.p);
      this.raiz.rotation.y = ultimo.yaw;
      this._trocarAnim(ultimo.anim);
    } else {
      const a = b[i - 1];
      const c = b[i];
      const span = c.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (alvo - a.t) / span)) : 1;
      this.raiz.position.lerpVectors(a.p, c.p, k);
      this.raiz.rotation.y = anguloInterpolado(a.yaw, c.yaw, k);
      this._trocarAnim(c.anim);
    }

    // As etiquetas são planos; sem isto ficariam de lado conforme a câmera gira.
    this.etiqueta?.quaternion.copy(camera.quaternion);
    this.balao?.atualizar(camera);
  }

  descartar() {
    if (this.etiqueta) descartarEtiqueta(this.etiqueta);
    this.balao?.limpar();
  }
}

/** Interpola ângulos pelo caminho curto, para não girar 350° em vez de -10°. */
function anguloInterpolado(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Gerencia os avatares dos outros jogadores.
 *
 * Os GLBs são carregados sob demanda e reaproveitados: seis personagens somam
 * 16 MB, e baixar todos na entrada seria pagar por corpos que talvez ninguém
 * use na sala.
 */
export class JogadoresRemotos {
  constructor(cena, renderer) {
    this.cena = cena;
    this.renderer = renderer;
    this.mapa = new Map();
    this._cache = new Map();
    /** Chamado quando um avatar termina de carregar e entra na cena. */
    this.aoCriar = () => {};
    this.aoRemover = () => {};
  }

  async _carregar(dados) {
    const chave = dados.papel === "lagartixa" ? "lagartixa" : dados.personagem;
    if (!this._cache.has(chave)) {
      this._cache.set(chave, carregarPersonagem(this.renderer, CAMINHO(dados)));
    }
    const { modelo, clipes } = await this._cache.get(chave);
    // Cada avatar precisa da própria hierarquia de ossos; compartilhar o
    // modelo faria todos assumirem a mesma pose.
    //
    // O módulo exporta `clone` solto -- não existe um objeto SkeletonUtils
    // para desestruturar, e tentar isso dá `undefined` silenciosamente.
    const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
    return { modelo: clone(modelo), clipes };
  }

  async adicionar(dados) {
    if (this.mapa.has(dados.id)) return;
    // Marca o lugar antes do await: duas mensagens seguidas do mesmo jogador
    // criariam dois avatares.
    this.mapa.set(dados.id, null);

    try {
      const { modelo, clipes } = await this._carregar(dados);
      if (!this.mapa.has(dados.id)) return; // saiu enquanto carregava

      const remoto = new Remoto(dados, modelo, clipes);
      this.mapa.set(dados.id, remoto);
      this.cena.add(remoto.raiz);
      this.aoCriar(remoto);
    } catch (erro) {
      // Sem o catch, a falha vira uma rejeição não tratada e o lugar reservado
      // fica como null para sempre -- o jogador some da cena sem explicação.
      console.error("[remotos] falha ao criar avatar de", dados.nome, erro);
      this.mapa.delete(dados.id);
      this._cache.delete(dados.papel === "lagartixa" ? "lagartixa" : dados.personagem);
    }
  }

  remover(id) {
    const remoto = this.mapa.get(id);
    if (remoto) {
      this.aoRemover(id);
      this.cena.remove(remoto.raiz);
      remoto.descartar();
    }
    this.mapa.delete(id);
  }

  receberEstados(lista, meuId) {
    const agora = performance.now();
    for (const estado of lista) {
      if (estado.id === meuId) continue;
      this.mapa.get(estado.id)?.receber(estado, agora);
    }
  }

  falar(id, texto) {
    this.mapa.get(id)?.dizer(texto);
  }

  atualizar(dt, camera) {
    const agora = performance.now();
    for (const remoto of this.mapa.values()) {
      remoto?.atualizar(dt, agora, camera);
    }
  }

  limpar() {
    for (const id of [...this.mapa.keys()]) this.remover(id);
  }
}
