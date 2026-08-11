import * as THREE from "three";

import { carregarPersonagem } from "./carregarModelo.js";
import { Balao, criarEtiqueta, descartarEtiqueta } from "./etiquetas.js";

const CAMINHO = (personagem) => `/models/personagens/${personagem}.glb`;

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
    this.etiqueta = criarEtiqueta(this.nome, this.cor);
    this.etiqueta.position.set(0, 2.05, 0);
    this.raiz.add(this.etiqueta);

    this.balao = new Balao(this.raiz);
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
    this.balao.dizer(texto);
  }

  atualizar(dt, agora, camera) {
    this.mixer.update(dt);

    const alvo = agora - ATRASO_MS;
    const b = this.buffer;

    // Acha o par de estados que cerca o instante que queremos mostrar.
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > alvo) i--;

    if (b.length === 1) {
      this.raiz.position.copy(b[0].p);
      this.raiz.rotation.y = b[0].yaw;
      this._trocarAnim(b[0].anim);
    } else if (i > 0) {
      const a = b[i - 1];
      const c = b[i];
      const span = c.t - a.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (alvo - a.t) / span)) : 1;
      this.raiz.position.lerpVectors(a.p, c.p, k);
      this.raiz.rotation.y = anguloInterpolado(a.yaw, c.yaw, k);
      this._trocarAnim(c.anim);
    }

    // As etiquetas são planos; sem isto ficariam de lado conforme a câmera gira.
    this.etiqueta.quaternion.copy(camera.quaternion);
    this.balao.atualizar(camera);
  }

  descartar() {
    descartarEtiqueta(this.etiqueta);
    this.balao.limpar();
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
  }

  async _carregar(personagem) {
    if (!this._cache.has(personagem)) {
      this._cache.set(
        personagem,
        carregarPersonagem(this.renderer, CAMINHO(personagem)),
      );
    }
    const { modelo, clipes } = await this._cache.get(personagem);
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
      const { modelo, clipes } = await this._carregar(dados.personagem);
      if (!this.mapa.has(dados.id)) return; // saiu enquanto carregava

      const remoto = new Remoto(dados, modelo, clipes);
      this.mapa.set(dados.id, remoto);
      this.cena.add(remoto.raiz);
    } catch (erro) {
      // Sem o catch, a falha vira uma rejeição não tratada e o lugar reservado
      // fica como null para sempre -- o jogador some da cena sem explicação.
      console.error("[remotos] falha ao criar avatar de", dados.nome, erro);
      this.mapa.delete(dados.id);
      this._cache.delete(dados.personagem);
    }
  }

  remover(id) {
    const remoto = this.mapa.get(id);
    if (remoto) {
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
