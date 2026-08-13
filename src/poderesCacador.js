import * as THREE from "three";

/**
 * Os poderes de quem caça, do lado do navegador.
 *
 * Mesma divisão de trabalho dos poderes da lagartixa: aqui só se pede e se
 * desenha; quem decide se valeu é o servidor. A diferença é o que cada um
 * mostra -- e mostrar é metade do projeto destes poderes, porque quase todos
 * dão INFORMAÇÃO em vez de dano, e informação que não se vê não existe.
 *
 * A exceção é a lanterna, que não passa pelo servidor: é luz na tela de quem
 * a segura, e mais nada. Ela mora aqui do mesmo jeito porque é onde alguém vai
 * procurá-la.
 */

// ------------------------------------------------------------ lanterna

const BATERIA_MS = 22_000;        // ligada, do cheio ao vazio
const RECARGA_MS = 30_000;        // do vazio ao cheio, com a luz do prédio acesa

/**
 * Cone de luz preso à câmera, com bateria.
 *
 * É o contrapeso do `escuro` da lagartixa: apagar as luzes era vantagem pura,
 * sem resposta possível durante quarenta segundos. Com a lanterna vira troca,
 * e a troca é dos dois lados -- o cone ilumina, mas também ANUNCIA para onde
 * quem caça está olhando. A lagartixa vê o facho varrer a parede antes de ele
 * chegar nela.
 *
 * A bateria só recarrega com a luz do prédio acesa, então gastá-la no escuro é
 * uma decisão com consequência: quem queima tudo no primeiro apagão fica sem
 * nada no segundo.
 */
export class Lanterna {
  constructor(camera) {
    this.camera = camera;
    this.ligada = false;
    this.carga = 1;

    this.luz = new THREE.SpotLight(0xfff0c4, 0, 26, Math.PI / 9, 0.45, 1.1);
    // Presa à câmera, e o alvo um metro à frente dela: assim o facho segue o
    // olhar sem uma linha de código por quadro.
    this.luz.position.set(0, 0, 0);
    this.alvo = new THREE.Object3D();
    this.alvo.position.set(0, 0, -1);
    camera.add(this.luz, this.alvo);
    this.luz.target = this.alvo;
  }

  alternar() {
    if (!this.ligada && this.carga <= 0.02) return false;
    this.ligada = !this.ligada;
    return true;
  }

  desligar() {
    this.ligada = false;
  }

  atualizar(dt, luzDoPredioAcesa) {
    if (this.ligada) {
      this.carga -= (dt * 1000) / BATERIA_MS;
      if (this.carga <= 0) {
        this.carga = 0;
        this.ligada = false;
      }
    } else if (luzDoPredioAcesa) {
      this.carga = Math.min(1, this.carga + (dt * 1000) / RECARGA_MS);
    }

    // A intensidade acompanha a carga no finalzinho: a lanterna morre piscando
    // e enfraquecendo, e não de uma vez -- dá para perceber que vai acabar.
    const fraca = Math.min(1, this.carga / 0.15);
    const alvo = this.ligada ? 26 * (0.45 + fraca * 0.55) : 0;
    this.luz.intensity += (alvo - this.luz.intensity) * Math.min(1, dt * 12);
  }

  limpar() {
    this.luz.parent?.remove(this.luz);
    this.alvo.parent?.remove(this.alvo);
  }
}

// ------------------------------------------------------------ batida

/**
 * O estrondo na parede: um anel que se abre e some.
 *
 * A batida não revela ninguém, então o único jeito de saber que ela aconteceu
 * é vê-la e ouvi-la. O anel cresce até o alcance real do poder -- quem assiste
 * consegue ler, pelo tamanho, se estava dentro ou fora.
 */
export class Batidas {
  constructor(cena) {
    this.cena = cena;
    this.vivas = [];
    this.geometria = new THREE.RingGeometry(0.9, 1, 40);
  }

  estourar(ponto, alcance = 8) {
    const anel = new THREE.Mesh(
      this.geometria,
      new THREE.MeshBasicMaterial({
        color: 0xff9f43,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    anel.position.copy(ponto);
    anel.position.y += 0.05;
    anel.rotation.x = -Math.PI / 2;
    this.cena.add(anel);
    this.vivas.push({ anel, t: 0, alcance });
  }

  atualizar(dt) {
    for (let i = this.vivas.length - 1; i >= 0; i--) {
      const v = this.vivas[i];
      v.t += dt;
      const k = v.t / 0.75;
      if (k >= 1) {
        this.cena.remove(v.anel);
        v.anel.material.dispose();
        this.vivas.splice(i, 1);
        continue;
      }
      v.anel.scale.setScalar(0.4 + k * v.alcance);
      v.anel.material.opacity = 0.85 * (1 - k) ** 2;
    }
  }

  limpar() {
    for (const v of this.vivas) {
      this.cena.remove(v.anel);
      v.anel.material.dispose();
    }
    this.vivas.length = 0;
  }
}

// ------------------------------------------------------------ sensores

/**
 * Os sensores largados no chão.
 *
 * Visíveis para todo mundo, de propósito: um sensor invisível é uma armadilha
 * sem resposta. À vista, ele NEGA a área -- que é para o que ele serve --, e a
 * lagartixa ainda pode dar a volta.
 *
 * Ele resolve um buraco estrutural do esconde-esconde: quem caça limpa uma
 * sala, sai, e a lagartixa volta para trás dela. Sem nada que segure o
 * terreno, varrer o prédio é trabalho que se desfaz sozinho.
 */
export class Sensores {
  constructor(cena) {
    this.cena = cena;
    this.postos = new Map();
  }

  largar(id, ponto, meu) {
    if (this.postos.has(id)) this.recolher(id);

    const grupo = new THREE.Group();
    const corpo = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 0.22, 10),
      new THREE.MeshStandardMaterial({ color: 0x39445a, roughness: 0.6 }),
    );
    corpo.position.y = 0.11;

    const olho = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0x6ea8fe,
        emissive: 0x6ea8fe,
        // Aceso por dentro: no escuro, que é quando ele mais importa, o corpo
        // cinza some e o que se procura é o ponto azul.
        emissiveIntensity: 1.1,
        roughness: 0.3,
      }),
    );
    olho.position.y = 0.24;

    grupo.add(corpo, olho);
    grupo.position.copy(ponto);
    grupo.userData.olho = olho;
    this.cena.add(grupo);

    // O anel de alcance só aparece para quem largou: é a informação de quem
    // está posicionando, e desenhá-lo para a lagartixa entregaria o raio exato.
    let anel = null;
    if (meu) {
      anel = new THREE.Mesh(
        new THREE.RingGeometry(5.9, 6, 48),
        new THREE.MeshBasicMaterial({
          color: 0x6ea8fe,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      anel.rotation.x = -Math.PI / 2;
      anel.position.copy(ponto);
      anel.position.y += 0.03;
      this.cena.add(anel);
    }

    this.postos.set(id, { grupo, anel, apitoAte: 0, t: 0 });
  }

  apitar(id) {
    const posto = this.postos.get(id);
    if (posto) posto.apitoAte = performance.now() + 1200;
  }

  recolher(id) {
    const posto = this.postos.get(id);
    if (!posto) return;
    this.cena.remove(posto.grupo);
    if (posto.anel) this.cena.remove(posto.anel);
    this.postos.delete(id);
  }

  atualizar(dt) {
    const agora = performance.now();
    for (const posto of this.postos.values()) {
      posto.t += dt;
      const olho = posto.grupo.userData.olho;
      const apitando = agora < posto.apitoAte;
      // Parado, pulsa devagar como um piloto; disparado, pisca depressa e
      // muda de cor. Os dois estados precisam ser lidos de longe e de relance.
      olho.material.color.setHex(apitando ? 0xff5f5f : 0x6ea8fe);
      olho.material.emissive.setHex(apitando ? 0xff5f5f : 0x6ea8fe);
      olho.material.emissiveIntensity = apitando
        ? 1.6 + Math.sin(posto.t * 26) * 0.8
        : 0.7 + Math.sin(posto.t * 2.4) * 0.3;
      if (posto.anel) {
        posto.anel.material.opacity = apitando
          ? 0.34 + Math.sin(posto.t * 20) * 0.16
          : 0.18;
      }
    }
  }

  limpar() {
    for (const id of [...this.postos.keys()]) this.recolher(id);
  }
}

// ------------------------------------------------------------ pegadas

const MARCA_MS = 7_000;

/**
 * As pegadas: onde uma lagartixa passou.
 *
 * Duas fontes desenham no mesmo lugar porque são a mesma ideia. O pó revela
 * quem atravessa a nuvem; a tinta, quem levou um tiro e escapou. A cor separa
 * as duas, e é ela que diz se vale seguir o rastro ou se ele é só passagem.
 *
 * O servidor só manda a marca quando a lagartixa ANDA. Congelar continua
 * apagando o rastro -- é o que impede que o pó vire uma sentença.
 */
export class Pegadas {
  constructor(cena) {
    this.cena = cena;
    this.marcas = [];
    this.geometria = new THREE.CircleGeometry(0.09, 8);
  }

  pisar(ponto, tipo = "po") {
    const tinta = tipo === "tinta";
    const marca = new THREE.Mesh(
      this.geometria,
      new THREE.MeshBasicMaterial({
        color: tinta ? 0xff5f8a : 0xd8c2ff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        // Atravessa geometria: a pegada fica no chão, e o chão é justamente o
        // que a esconderia por um fio de diferença de altura.
        depthTest: false,
      }),
    );
    marca.renderOrder = 997;
    marca.position.set(ponto[0], ponto[1] + 0.03, ponto[2]);
    marca.rotation.x = -Math.PI / 2;
    this.cena.add(marca);
    this.marcas.push({ marca, nasceu: performance.now(), tinta });
    // Um teto: numa perseguição longa o rastro renderiza centenas de discos.
    if (this.marcas.length > 160) {
      const velha = this.marcas.shift();
      this.cena.remove(velha.marca);
      velha.marca.material.dispose();
    }
  }

  atualizar() {
    const agora = performance.now();
    for (let i = this.marcas.length - 1; i >= 0; i--) {
      const m = this.marcas[i];
      const k = (agora - m.nasceu) / MARCA_MS;
      if (k >= 1) {
        this.cena.remove(m.marca);
        m.marca.material.dispose();
        this.marcas.splice(i, 1);
        continue;
      }
      // Some devagar e só acelera no fim: o rastro precisa durar o bastante
      // para ler a DIREÇÃO, que é a única coisa que ele tem a dizer.
      m.marca.material.opacity = 0.9 * (1 - k ** 3);
      m.marca.scale.setScalar(1 - k * 0.35);
    }
  }

  limpar() {
    for (const m of this.marcas) {
      this.cena.remove(m.marca);
      m.marca.material.dispose();
    }
    this.marcas.length = 0;
  }
}

// ------------------------------------------------------------ nuvem de pó

/**
 * A nuvem assentando no chão.
 *
 * Precisa ser visível para os dois lados: quem caça precisa saber onde já
 * cobriu, e a lagartixa precisa poder evitar. Um campo minado invisível não é
 * leitura de jogo, é sorte.
 */
export class Nuvens {
  constructor(cena) {
    this.cena = cena;
    this.vivas = [];
  }

  soltar(ponto, raio, duracaoMs) {
    const disco = new THREE.Mesh(
      new THREE.CircleGeometry(raio, 40),
      new THREE.MeshBasicMaterial({
        color: 0xe6d5ff,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    disco.rotation.x = -Math.PI / 2;
    disco.position.set(ponto[0], ponto[1] + 0.02, ponto[2]);

    const borda = new THREE.Mesh(
      new THREE.RingGeometry(raio - 0.12, raio, 48),
      new THREE.MeshBasicMaterial({
        color: 0xe6d5ff,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    borda.rotation.x = -Math.PI / 2;
    borda.position.copy(disco.position);

    this.cena.add(disco, borda);
    this.vivas.push({
      disco, borda, t: 0,
      ate: performance.now() + duracaoMs,
      total: duracaoMs,
    });
  }

  atualizar(dt) {
    const agora = performance.now();
    for (let i = this.vivas.length - 1; i >= 0; i--) {
      const n = this.vivas[i];
      n.t += dt;
      const resta = n.ate - agora;
      if (resta <= 0) {
        this.cena.remove(n.disco, n.borda);
        n.disco.material.dispose();
        n.borda.material.dispose();
        this.vivas.splice(i, 1);
        continue;
      }
      // Assenta ao cair e depois só desbota. Nos últimos dois segundos apaga
      // de vez, para ninguém contar com uma nuvem que já acabou.
      const chegando = Math.min(1, n.t / 0.6);
      const morrendo = Math.min(1, resta / 2000);
      n.disco.scale.setScalar(0.3 + chegando * 0.7);
      n.borda.scale.copy(n.disco.scale);
      n.disco.material.opacity = 0.14 * chegando * morrendo;
      n.borda.material.opacity = (0.28 + Math.sin(n.t * 1.6) * 0.08) * chegando * morrendo;
    }
  }

  limpar() {
    for (const n of this.vivas) {
      this.cena.remove(n.disco, n.borda);
      n.disco.material.dispose();
      n.borda.material.dispose();
    }
    this.vivas.length = 0;
  }
}

// ------------------------------------------------------------ rede

/**
 * A rede voando, e depois enrolada em quem foi pego.
 *
 * Reaproveitar o projétil do dardo aqui foi um erro que só aparece jogando: o
 * que se via era a mesma esferinha âmbar do tiro comum, e a rede -- que NÃO
 * fere -- ficava visualmente idêntica ao tiro que mata. Quem levava não sabia
 * o que tinha acontecido, e quem estava perto não sabia o que o colega usou.
 *
 * Aqui ela é uma malha de verdade: uma folha de cordas que gira no ar, abre
 * enquanto voa e depois fica presa ao corpo durante os mesmos 1,5 s em que o
 * servidor recusa o movimento. O tempo na tela é o tempo da regra -- é assim
 * que se entende, sem ler nada, quando dá para correr de novo.
 */
const VEL_REDE = 16;        // m/s: lenta o bastante para dar para desviar

/** A malha, desenhada uma vez e reaproveitada por todas as redes. */
function tecerMalha() {
  const lado = 128;
  const tela = document.createElement("canvas");
  tela.width = tela.height = lado;
  const ctx = tela.getContext("2d");

  ctx.strokeStyle = "#b0ffe0";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const casas = 6;
  for (let i = 0; i <= casas; i++) {
    const p = (i / casas) * lado;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, lado); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(lado, p); ctx.stroke();
  }
  // Nós nos cruzamentos: sem eles a malha lê como grade de janela.
  ctx.fillStyle = "#7fe0c0";
  for (let i = 0; i <= casas; i++) {
    for (let j = 0; j <= casas; j++) {
      ctx.beginPath();
      ctx.arc((i / casas) * lado, (j / casas) * lado, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const textura = new THREE.CanvasTexture(tela);
  textura.colorSpace = THREE.SRGBColorSpace;
  return textura;
}

export class Redes {
  constructor(cena) {
    this.cena = cena;
    this.malha = tecerMalha();
    this.geometria = new THREE.PlaneGeometry(1, 1);
    this.vivas = [];
  }

  /**
   * @param {THREE.Vector3} de     de onde sai
   * @param {THREE.Vector3} ate    onde acerta
   * @param {() => THREE.Vector3|null} seguir  onde o alvo está, a cada quadro
   * @param {number} duracaoMs     quanto tempo fica enrolada
   */
  lancar(de, ate, seguir, duracaoMs) {
    const material = new THREE.MeshBasicMaterial({
      map: this.malha,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      opacity: 0.95,
    });
    const folha = new THREE.Mesh(this.geometria, material);
    folha.position.copy(de);
    folha.renderOrder = 8;
    this.cena.add(folha);

    this.vivas.push({
      folha,
      de: de.clone(),
      ate: ate.clone(),
      seguir,
      t: 0,
      voo: Math.max(0.12, de.distanceTo(ate) / VEL_REDE),
      presa: duracaoMs / 1000,
      giro: new THREE.Vector3(1.7, 2.6, 1.1),
      // Inclinação com que ela repousa sobre o corpo. Varia por lançamento
      // para duas redes seguidas não saírem idênticas.
      tombo: (this.vivas.length % 4) * 0.19 - 0.28,
    });
  }

  atualizar(dt, camera) {
    for (let i = this.vivas.length - 1; i >= 0; i--) {
      const r = this.vivas[i];
      r.t += dt;

      if (r.t < r.voo) {
        // Voando: sobe num arco raso, gira e ABRE. A abertura é o que conta --
        // uma rede que chega do tamanho que saiu parece um pano jogado.
        const k = r.t / r.voo;
        r.folha.position.lerpVectors(r.de, r.ate, k);
        r.folha.position.y += Math.sin(k * Math.PI) * 0.45;
        r.folha.rotation.x += r.giro.x * dt;
        r.folha.rotation.y += r.giro.y * dt;
        r.folha.rotation.z += r.giro.z * dt;
        r.folha.scale.setScalar(0.35 + k * 1.05);
        continue;
      }

      const presa = r.t - r.voo;
      if (presa >= r.presa) {
        this.cena.remove(r.folha);
        r.folha.material.dispose();
        this.vivas.splice(i, 1);
        continue;
      }

      // Enrolada: acompanha o corpo, encolhe até o tamanho dele e para de
      // girar. O alvo pode ter saído da sala no meio -- daí ela fica onde caiu.
      const onde = r.seguir?.() ?? null;
      if (onde) r.folha.position.copy(onde).setY(onde.y + 0.22);
      const k = presa / r.presa;

      // Ao prender, a malha passa a ENCARAR a câmera.
      //
      // Girando livre, ela parava no ângulo em que o tombo do voo a deixasse
      // -- e um plano visto de canto é um risco de um pixel. Metade das vezes
      // a rede ficava invisível justamente no momento em que ela importa: o
      // 1,5 s em que o corpo não anda. Encarando a lente, ela sempre lê como
      // malha, de qualquer lugar da sala.
      if (camera) {
        r.folha.quaternion.copy(camera.quaternion);
        // Um giro de tela por cima, para não parecer adesivo colado na tela.
        r.folha.rotateZ(r.tombo + Math.sin(presa * 12) * 0.06);
      }
      r.folha.scale.setScalar(1.4 - k * 0.35);
      r.folha.material.opacity = 0.95 * Math.min(1, (1 - k) * 3);
    }
  }

  limpar() {
    for (const r of this.vivas) {
      this.cena.remove(r.folha);
      r.folha.material.dispose();
    }
    this.vivas.length = 0;
  }
}
