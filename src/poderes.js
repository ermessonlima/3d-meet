import * as THREE from "three";

/**
 * Truques da lagartixa.
 *
 * O problema que estes poderes resolvem é de ritmo: escondida, ela fazia UMA
 * escolha -- onde se enfiar -- e depois assistia cinco minutos. Toda a tensão
 * ficava do lado do caçador. Aqui ela ganha coisas para gastar, e o preço de
 * todas é o mesmo: o assobio chega mais cedo. Quem apronta se entrega.
 *
 * Quem decide se um poder vale (papel, fase, espera, alcance) é o servidor.
 * Este arquivo é só o que se vê e se ouve.
 */

// ------------------------------------------------------------ cauda solta

const COR_CAUDA = 0x8fbf6a;
// Quanto a isca corre antes de parar e se contorcer onde caiu.
const FUGA_MS = 1400;
const VEL_FUGA = 5.2;

/**
 * A cauda destacada, que fica se contorcendo no chão.
 *
 * É a isca: osga de verdade solta a cauda e ela continua se mexendo para
 * prender a atenção do predador enquanto o bicho some. Aqui ela também assobia
 * uma vez, senão ninguém iria até lá.
 */
export class CaudasSoltas {
  /**
   * `criarCorpo` devolve `{ raiz, mixer }` de uma lagartixa clonada, ou null.
   *
   * A isca usa o MODELO de verdade, não caixinhas: o objetivo dela é ser
   * confundida com a lagartixa por um segundo, e três blocos verdes não
   * enganam ninguém. Quando o clone não estiver disponível (modelo ainda
   * carregando), cai nas caixas -- é melhor uma isca tosca do que nenhuma.
   */
  constructor(cena, criarCorpo = null) {
    this.cena = cena;
    this.criarCorpo = criarCorpo;
    this.ativas = [];
    this.geoElo = new THREE.BoxGeometry(0.05, 0.045, 0.1);
    this.geoCorpo = new THREE.BoxGeometry(0.13, 0.07, 0.2);
    this.geoFaisca = new THREE.BoxGeometry(0.03, 0.03, 0.03);
  }

  _corpoDeCaixas(cor) {
    const grupo = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: cor, roughness: 0.8 });
    grupo.add(new THREE.Mesh(this.geoCorpo, material));
    const elos = [];
    for (let i = 0; i < 3; i++) {
      const elo = new THREE.Mesh(this.geoElo, material);
      elo.position.z = -0.14 - i * 0.08;
      elo.scale.setScalar(1 - i * 0.2);
      grupo.add(elo);
      elos.push(elo);
    }
    return { raiz: grupo, mixer: null, elos, material };
  }

  /**
   * Solta a isca em `ponto`, disparando para `fuga`.
   *
   * Ela CORRE para o lado oposto ao que a lagartixa estava olhando. Parada,
   * ninguém percebia que a habilidade tinha sido usada -- a cauda nascia sob o
   * próprio corpo e ficava escondida por ele. Correndo, é a coisa que se move
   * na tela, que é o que o olho do caçador persegue.
   */
  soltar(ponto, duracaoMs, cor, fuga) {
    const tom = new THREE.Color(cor ?? COR_CAUDA);
    const feito = this.criarCorpo?.(tom) ?? this._corpoDeCaixas(tom);
    const { raiz, mixer } = feito;

    raiz.position.copy(ponto);
    raiz.position.y += 0.02;

    const direcao = (fuga ?? new THREE.Vector3(0, 0, 1)).clone().setY(0);
    if (direcao.lengthSq() < 1e-6) direcao.set(0, 0, 1);
    direcao.normalize();
    raiz.rotation.y = Math.atan2(direcao.x, direcao.z);

    this.cena.add(raiz);
    this.ativas.push({
      raiz, mixer, elos: feito.elos ?? null, material: feito.material ?? null,
      direcao,
      ate: performance.now() + duracaoMs,
      correndoAte: performance.now() + FUGA_MS,
      fase: Math.random() * 6.28,
    });

    this._estourar(ponto, tom);
    return raiz;
  }

  /** Faíscas na cor do bicho, no instante em que a isca se solta. */
  _estourar(ponto, cor) {
    for (let i = 0; i < 14; i++) {
      const f = new THREE.Mesh(
        this.geoFaisca,
        new THREE.MeshBasicMaterial({ color: cor, transparent: true }),
      );
      f.position.copy(ponto);
      f.position.y += 0.06;
      const ang = Math.random() * Math.PI * 2;
      this.cena.add(f);
      this.ativas.push({
        faisca: f,
        vel: new THREE.Vector3(Math.cos(ang) * 2.1, 2.2 + Math.random(), Math.sin(ang) * 2.1),
        ate: performance.now() + 700,
      });
    }
  }

  atualizar(dt) {
    const agora = performance.now();
    for (let i = this.ativas.length - 1; i >= 0; i--) {
      const c = this.ativas[i];

      if (c.faisca) {
        c.vel.y -= 9 * dt;
        c.faisca.position.addScaledVector(c.vel, dt);
        c.faisca.material.opacity = Math.max(0, (c.ate - agora) / 700);
        if (agora > c.ate) {
          this.cena.remove(c.faisca);
          c.faisca.material.dispose();
          this.ativas.splice(i, 1);
        }
        continue;
      }

      c.fase += dt * 11;
      c.mixer?.update(dt);

      // Corre rápido no começo e vai perdendo o fôlego, como bicho assustado.
      const correndo = agora < c.correndoAte;
      if (correndo) {
        const k = (c.correndoAte - agora) / FUGA_MS;
        c.raiz.position.addScaledVector(c.direcao, VEL_FUGA * k * dt);
      }

      // As caixas se contorcem à mão; o clone já tem clipe para isso.
      if (c.elos) {
        const vida = Math.max(0, (c.ate - agora) / 3000);
        const forca = Math.min(1, vida) * 0.55;
        c.elos.forEach((elo, k) => {
          elo.rotation.y = Math.sin(c.fase - k * 0.9) * forca;
        });
      }
      // Parada, dá uns tremeliques -- é o que prende o olho de quem chega.
      if (!correndo) c.raiz.rotation.z = Math.sin(c.fase * 0.8) * 0.06;

      if (agora > c.ate) {
        this.cena.remove(c.raiz);
        c.material?.dispose();
        this.ativas.splice(i, 1);
      }
    }
  }

  limpar() {
    for (const c of this.ativas) this.cena.remove(c.raiz ?? c.faisca);
    this.ativas.length = 0;
  }
}

// ------------------------------------------------------------ pedra jogada

/**
 * A pedrinha do assobio falso.
 *
 * O som saía do nada, num ponto qualquer da sala, e não havia como ligar o
 * efeito à causa -- nem para quem jogou, nem para quem ouviu. Vendo a pedra
 * sair em arco e bater no chão, a habilidade passa a ter um gesto: a lagartixa
 * ATIRA alguma coisa para fazer barulho longe dela.
 */
export class PedrasJogadas {
  constructor(cena) {
    this.cena = cena;
    this.geometria = new THREE.DodecahedronGeometry(0.035);
    this.material = new THREE.MeshStandardMaterial({ color: 0x8a8f9c, roughness: 0.9 });
    this.ativas = [];
  }

  /** Arco de `de` até `ate`; `aoCair` dispara quando encosta no chão. */
  jogar(de, ate, aoCair) {
    const pedra = new THREE.Mesh(this.geometria, this.material);
    pedra.position.copy(de);
    pedra.castShadow = true;
    this.cena.add(pedra);

    // Tempo de voo pela distância, para pedra perto não sair em câmera lenta
    // nem pedra longe demorar meio segundo a mais do que deveria.
    const dist = de.distanceTo(ate);
    const duracao = Math.min(1.1, 0.28 + dist * 0.055);

    this.ativas.push({
      pedra, de: de.clone(), ate: ate.clone(), aoCair,
      t: 0, duracao,
      giro: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
    });
    return pedra;
  }

  atualizar(dt) {
    for (let i = this.ativas.length - 1; i >= 0; i--) {
      const p = this.ativas[i];
      p.t += dt / p.duracao;
      const k = Math.min(1, p.t);

      p.pedra.position.lerpVectors(p.de, p.ate, k);
      // Parábola por cima da reta: é o que faz ler como arremesso e não como
      // tiro. A altura acompanha a distância.
      p.pedra.position.y += Math.sin(k * Math.PI) * (0.35 + p.de.distanceTo(p.ate) * 0.09);
      p.pedra.rotation.x += p.giro.x * dt;
      p.pedra.rotation.z += p.giro.z * dt;

      if (k >= 1) {
        this.cena.remove(p.pedra);
        p.aoCair?.(p.ate);
        this.ativas.splice(i, 1);
      }
    }
  }

  limpar() {
    for (const p of this.ativas) this.cena.remove(p.pedra);
    this.ativas.length = 0;
  }
}

// ------------------------------------------------------------ cuspe na tela

/**
 * Borrão de tinta na tela de quem levou o cuspe.
 *
 * Desenhado num canvas por cima de tudo, não no mundo 3D: o efeito é "sujou a
 * minha lente", e uma mancha no mundo se moveria com a câmera de um jeito
 * errado. Fica opaco no meio e vazado nas bordas, para atrapalhar sem cegar --
 * cegar por completo é o tipo de coisa que faz a pessoa fechar a aba.
 */
export class CuspeNaTela {
  constructor(elemento) {
    this.el = elemento;
    this.ctx = elemento.getContext("2d");
    this.ate = 0;
  }

  sujar(cor, duracaoMs) {
    const l = (this.el.width = this.el.clientWidth || 1280);
    const a = (this.el.height = this.el.clientHeight || 720);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, l, a);
    ctx.fillStyle = cor;

    // Cobertura pesada: quem leva o cuspe fica sem ver por alguns segundos, e
    // é esse o preço que dá sentido ao risco de quem cospe -- ela precisa
    // chegar a sete metros do caçador para acertar.
    const r = Math.max(l, a);
    const centro = [l * (0.4 + Math.random() * 0.2), a * (0.38 + Math.random() * 0.24)];

    // Um miolo grande e opaco, e uma coroa de manchas cobrindo o resto.
    const borroes = [{ x: centro[0], y: centro[1], r: r * 0.42 }];
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
      const d = r * (0.2 + Math.random() * 0.45);
      borroes.push({
        x: centro[0] + Math.cos(ang) * d,
        y: centro[1] + Math.sin(ang) * d,
        r: r * (0.1 + Math.random() * 0.2),
      });
    }
    for (const b of borroes) {
      ctx.globalAlpha = 0.85 + Math.random() * 0.15;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r, b.r * (0.72 + Math.random() * 0.55), Math.random() * 3, 0, 6.3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.ate = performance.now() + duracaoMs;
    this.duracao = duracaoMs;
    this.el.hidden = false;
  }

  atualizar() {
    if (this.el.hidden) return;
    const resta = this.ate - performance.now();
    if (resta <= 0) {
      this.el.hidden = true;
      return;
    }
    // Cega de verdade na primeira metade e vai escorrendo depois: sair do
    // opaco direto para o limpo pareceria falha de renderização, e ficar cego
    // até o fim faria a pessoa largar o teclado.
    const escoando = this.duracao * 0.45;
    this.el.style.opacity = String(resta > escoando ? 1 : Math.max(0, resta / escoando));
  }
}

// ------------------------------------------------------------ escuro

/**
 * Apaga as luzes do escritório por alguns segundos.
 *
 * Só a lagartixa GRUDADA NUMA PAREDE consegue -- a justificativa é que ela
 * alcançou o interruptor, e a regra existe para o poder nascer da escalada em
 * vez de ser mais um botão solto.
 */
export class Escuridao {
  constructor(palco) {
    this.palco = palco;
    this.ate = 0;
    this.original = null;
  }

  acionar(duracaoMs) {
    if (!this.original) {
      const { hemisferio, sol, preenchimento, scene } = this.palco;
      // TODAS as fontes, não só as duas óbvias. O `scene.environment` (o mapa
      // de reflexo que dá o brilho de cromo e vidro) ilumina o cenário inteiro
      // por conta própria: baixando só o sol e o hemisfério, a tela continuava
      // do mesmo jeito e o poder não fazia nada visível.
      this.original = {
        hemi: hemisferio?.intensity ?? 0,
        sol: sol?.intensity ?? 0,
        preenchimento: preenchimento?.intensity ?? 0,
        ambiente: scene?.environmentIntensity ?? 1,
      };
    }
    this.ate = performance.now() + duracaoMs;
    this.duracao = duracaoMs;
  }

  /** Se o prédio está no escuro agora -- o disjuntor pergunta isto. */
  get escuro() {
    return this.ate > performance.now();
  }

  atualizar() {
    if (!this.original) return;
    const { hemisferio, sol, preenchimento, scene } = this.palco;
    const resta = this.ate - performance.now();

    // Não é breu: uma fração do normal ainda deixa ler silhueta e parede.
    // Escuro total viraria tela preta, e ninguém joga de olhos fechados.
    //
    // Nos primeiros 400 ms a luz PISCA duas vezes antes de morrer. Sem isso a
    // sala simplesmente escurecia, e escurecer devagar se confunde com o olho
    // se acostumando; o piscar diz que alguém mexeu no interruptor.
    const decorrido = this.duracao - resta;
    let k;
    if (resta <= 0) k = 1;
    else if (decorrido < 400) k = Math.sin(decorrido * 0.045) > 0 ? 0.9 : 0.16;
    else if (resta < 700) k = 0.14 + (1 - resta / 700) * 0.86;
    else k = 0.14;
    if (hemisferio) hemisferio.intensity = this.original.hemi * k;
    if (sol) sol.intensity = this.original.sol * k;
    if (preenchimento) preenchimento.intensity = this.original.preenchimento * k;
    if (scene) scene.environmentIntensity = this.original.ambiente * k;
  }
}

// ------------------------------------------------------------ faro

/**
 * Contorno dos caçadores através da parede, enquanto a lagartixa está imóvel.
 *
 * Não serve para fugir -- serve para DECIDIR: dá para deixar passar ou é hora
 * de correr? É o que transforma o esconderijo em leitura de jogo em vez de
 * sorte. Só funciona parada, então usar o faro e fugir são coisas diferentes.
 */
export class Faro {
  constructor(cena) {
    this.cena = cena;
    this.marcas = new Map();
    this.geometria = new THREE.CapsuleGeometry(0.34, 1.1, 4, 8);
  }

  _marca(id) {
    if (!this.marcas.has(id)) {
      const malha = new THREE.Mesh(
        this.geometria,
        new THREE.MeshBasicMaterial({
          color: 0xff7a7a,
          transparent: true,
          opacity: 0.32,
          // Desenha por cima de tudo: é justamente para ver ATRAVÉS da parede.
          depthTest: false,
          depthWrite: false,
        }),
      );
      malha.renderOrder = 999;
      this.cena.add(malha);
      this.marcas.set(id, malha);
    }
    return this.marcas.get(id);
  }

  /** `alvos` são os avatares a marcar; qualquer um fora da lista some. */
  atualizar(alvos, ligado, origem, alcance) {
    const vistos = new Set();
    if (ligado) {
      for (const alvo of alvos) {
        if (origem.distanceTo(alvo.raiz.position) > alcance) continue;
        const m = this._marca(alvo.id);
        m.position.copy(alvo.raiz.position);
        m.position.y += 0.95;
        m.visible = true;
        vistos.add(alvo.id);
      }
    }
    for (const [id, m] of this.marcas) if (!vistos.has(id)) m.visible = false;
  }

  limpar() {
    for (const m of this.marcas.values()) {
      this.cena.remove(m);
      m.material.dispose();
    }
    this.marcas.clear();
  }
}
