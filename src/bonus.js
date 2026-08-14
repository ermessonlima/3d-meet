import * as THREE from "three";

/**
 * Os bônus que tiram a lagartixa do canto.
 *
 * O jogo pagava para ela não se mexer: parada e escondida ela compra silêncio,
 * 0,9 s a cada segundo parado. Batida, armadilha e pó são castigo por isso, e
 * castigo funciona menos que recompensa -- a conta dela continuava fechando.
 * Aqui vem o outro lado: uma razão para sair.
 *
 * O módulo faz duas coisas: acha ONDE eles podem nascer (o servidor não
 * carrega o cenário, então quem calcula é o navegador) e desenha o que nasce.
 */

// ---------------------------------------------------- onde eles nascem

const ALTURA_DO_PISO = [3.1, 3.6];   // a laje do escritório, e não tampo de móvel
const RAIO_LIVRE = 2.2;              // metros de vazio exigidos em volta
const SEPARACAO = 7;                 // entre um ponto e outro
const MAXIMO = 60;

/**
 * Pontos EXPOSTOS: no meio do cômodo, longe de parede e de móvel.
 *
 * A escolha do lugar é metade do projeto. Um bônus num canto bom premiaria
 * exatamente o comportamento que ele existe para quebrar -- a lagartixa
 * pegaria sem sair de onde já estava. Ele tem de custar exposição, senão é
 * dinheiro grátis.
 *
 * A lista sai ordenada para ser a mesma em todos os navegadores: o servidor
 * escolhe um índice dela, e dois clientes com listas diferentes desenhariam o
 * bônus em lugares diferentes.
 */
export function procurarPontosDeBonus(colisor, grade) {
  const raio = new THREE.Raycaster();
  raio.firstHitOnly = true;

  // Oito direções em leque, para medir o vazio em volta do ponto.
  const direcoes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    direcoes.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
  }

  const achados = [];
  const colunas = [...grade.niveis.entries()];
  // Passo largo: varrer sete mil colunas seria lento, e o que interessa é
  // cobrir o prédio, não cada célula.
  const passo = Math.max(1, Math.floor(colunas.length / 900));

  for (let c = 0; c < colunas.length && achados.length < MAXIMO; c += passo) {
    const [indice, alturas] = colunas[c];
    const piso = alturas.find((y) => y >= ALTURA_DO_PISO[0] && y <= ALTURA_DO_PISO[1]);
    if (piso === undefined) continue;

    const ix = Math.floor(indice / grade.nz);
    const iz = indice % grade.nz;
    const [x, z] = grade.paraMundo(ix, iz);
    const origem = new THREE.Vector3(x, piso + 0.5, z);

    // Vazio em volta nas oito direções: é isso que separa "meio da sala" de
    // "atrás do armário".
    let livre = true;
    for (const dir of direcoes) {
      raio.set(origem, dir);
      raio.near = 0;
      raio.far = RAIO_LIVRE;
      if (raio.intersectObject(colisor, true)[0]) { livre = false; break; }
    }
    if (!livre) continue;

    const ponto = new THREE.Vector3(x, piso + 0.35, z);
    if (achados.some((p) => p.distanceTo(ponto) < SEPARACAO)) continue;
    achados.push(ponto);
  }

  // Ordem estável: sem isto, a lista depende da ordem de iteração do mapa e
  // dois clientes podem discordar de qual é o ponto número sete.
  achados.sort((a, b) => (a.x - b.x) || (a.z - b.z));
  return achados;
}

// ---------------------------------------------------------- o desenho

const CORES = {
  silencio: 0x7fd1ff,
  armadura: 0xffd166,
  surpresa: 0xc89bff,
};

/**
 * A caixa que fica girando no ar.
 *
 * Ela é visível ATRAVÉS de parede, para os dois lados. Não é descuido: um
 * bônus que só a lagartixa enxerga vira presente, e um que ninguém vê de longe
 * não chega a ser uma decisão. Visível para todos, ele cria terreno disputado
 * -- o caçador pode montar guarda, e é aí que pegar passa a custar algo.
 *
 * O de surpresa é roxo e sem símbolo de propósito: o que ele faz não se
 * anuncia. É a aposta que tira a lagartixa do lugar.
 */
export class Bonus {
  constructor(cena) {
    this.cena = cena;
    this.vivos = new Map();
    this.geoCaixa = new THREE.OctahedronGeometry(0.22, 0);
    this.geoAnel = new THREE.RingGeometry(0.34, 0.4, 28);
  }

  nascer(id, ponto, qual, duracaoMs) {
    if (this.vivos.has(id)) this.sumir(id);
    const cor = CORES[qual] ?? 0xffffff;

    const grupo = new THREE.Group();
    const corpo = new THREE.Mesh(
      this.geoCaixa,
      new THREE.MeshBasicMaterial({
        color: cor,
        transparent: true,
        opacity: 0.92,
        // Atravessa parede: a graça é justamente saber que ele existe do outro
        // lado do armário, e ter de decidir se vale ir.
        depthTest: false,
        depthWrite: false,
      }),
    );
    corpo.renderOrder = 996;

    // O anel no chão diz o tamanho do que sobra de tempo: ele encolhe.
    const anel = new THREE.Mesh(
      this.geoAnel,
      new THREE.MeshBasicMaterial({
        color: cor,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    anel.rotation.x = -Math.PI / 2;
    anel.position.y = -0.3;
    anel.renderOrder = 995;

    grupo.add(corpo, anel);
    grupo.position.copy(ponto);
    this.cena.add(grupo);

    this.vivos.set(id, {
      grupo, corpo, anel, t: 0,
      nasceu: performance.now(),
      total: duracaoMs,
      base: ponto.y,
    });
  }

  sumir(id) {
    const b = this.vivos.get(id);
    if (!b) return;
    this.cena.remove(b.grupo);
    b.corpo.material.dispose();
    b.anel.material.dispose();
    this.vivos.delete(id);
  }

  /** O ponto de um bônus vivo, para o cliente saber quando encostou. */
  ondeEsta(id) {
    return this.vivos.get(id)?.grupo.position ?? null;
  }

  atualizar(dt) {
    const agora = performance.now();
    for (const [id, b] of this.vivos) {
      b.t += dt;
      b.grupo.rotation.y += dt * 1.6;
      b.grupo.position.y = b.base + Math.sin(b.t * 2.2) * 0.12;

      const resta = Math.max(0, 1 - (agora - b.nasceu) / b.total);
      b.anel.scale.setScalar(0.35 + resta * 0.9);
      // Pisca mais depressa quanto menos tempo sobra: o aviso de que a decisão
      // está vencendo tem de chegar sem ninguém precisar ler um relógio.
      const pulso = 0.6 + Math.sin(b.t * (4 + (1 - resta) * 16)) * 0.35;
      b.corpo.material.opacity = 0.55 + pulso * 0.4;
      b.anel.material.opacity = 0.2 + resta * 0.4;
    }
  }

  limpar() {
    for (const id of [...this.vivos.keys()]) this.sumir(id);
  }
}
