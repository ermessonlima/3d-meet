import * as THREE from "three";

/**
 * Navegação para clicar-e-andar.
 *
 * ## Por que existe uma grade, e não só "ande em linha reta até lá"
 *
 * Andar direto na direção do clique funciona em campo aberto. Aqui o cenário é
 * um escritório: paredes, baias, portas de 1 m. Clicar na sala ao lado faria o
 * personagem encostar na parede e ficar empurrando, porque a cápsula desliza
 * mas não contorna. É preciso um caminho.
 *
 * A grade é amostrada uma vez, no carregamento, disparando um raio para baixo
 * por coluna e guardando TODOS os pisos encontrados -- não só o primeiro. É o
 * que permite o térreo existir por baixo do mezanino: com um único nível por
 * coluna, todo o andar de baixo sumiria do mapa.
 *
 * Não há erosão das bordas. O instinto é encolher as áreas caminháveis pelo
 * raio da cápsula, mas uma porta de 1 m tem 2 ou 3 células: comer uma de cada
 * lado fecha a passagem. Deixamos o caminho passar rente à parede e a física
 * de colisão resolve o resto, deslizando.
 */

const CIMA = new THREE.Vector3(0, 1, 0);
const BAIXO = new THREE.Vector3(0, -1, 0);

export class GradeDeNavegacao {
  constructor(colisor, opcoes = {}) {
    this.colisor = colisor;
    this.celula = opcoes.celula ?? 0.4;
    this.altura = opcoes.altura ?? 1.75;   // pé-direito exigido
    this.degrau = opcoes.degrau ?? 0.45;   // desnível que dá para subir andando
    this.niveis = new Map();               // índice da coluna -> [y, y, ...]
  }

  _indice(ix, iz) {
    return ix * this.nz + iz;
  }

  paraCelula(x, z) {
    return [
      Math.round((x - this.min.x) / this.celula),
      Math.round((z - this.min.z) / this.celula),
    ];
  }

  paraMundo(ix, iz) {
    return [this.min.x + ix * this.celula, this.min.z + iz * this.celula];
  }

  /** Amostra o cenário. Devolve métricas para o log de carregamento. */
  construir() {
    const inicio = performance.now();

    const caixa = new THREE.Box3().setFromObject(this.colisor);
    this.min = caixa.min.clone();
    this.nx = Math.ceil((caixa.max.x - caixa.min.x) / this.celula) + 1;
    this.nz = Math.ceil((caixa.max.z - caixa.min.z) / this.celula) + 1;
    const topo = caixa.max.y + 1;

    const raio = new THREE.Raycaster();
    raio.firstHitOnly = false; // precisamos de TODOS os pisos da coluna
    const origem = new THREE.Vector3();

    let colunas = 0;
    let total = 0;

    for (let ix = 0; ix < this.nx; ix++) {
      for (let iz = 0; iz < this.nz; iz++) {
        const [x, z] = this.paraMundo(ix, iz);
        origem.set(x, topo, z);
        raio.set(origem, BAIXO);
        const toques = raio.intersectObject(this.colisor, true);
        if (!toques.length) continue;

        const alturas = [];
        for (let i = 0; i < toques.length; i++) {
          const toque = toques[i];
          const normal = toque.face?.normal;
          // Só superfícies aproximadamente horizontais viradas para cima:
          // parede e teto aparecem no mesmo raio e não são piso.
          if (!normal || normal.dot(CIMA) < 0.6) continue;

          // O toque anterior na lista é o que está logo acima (o raio desce),
          // e é ele que limita o pé-direito. Sem espaço, não dá para ficar em pé.
          const acima = i > 0 ? toques[i - 1].point.y : Infinity;
          if (acima - toque.point.y < this.altura) continue;

          alturas.push(toque.point.y);
        }

        if (alturas.length) {
          this.niveis.set(this._indice(ix, iz), alturas);
          colunas += 1;
          total += alturas.length;
        }
      }
    }

    this.ms = Math.round(performance.now() - inicio);
    return {
      ms: this.ms,
      colunas,
      niveis: total,
      grade: `${this.nx}x${this.nz}`,
      celula: this.celula,
    };
  }

  /** Altura caminhável mais próxima de `y` naquela coluna, ou null. */
  nivelEm(ix, iz, y, tolerancia = this.degrau) {
    const alturas = this.niveis.get(this._indice(ix, iz));
    if (!alturas) return null;
    let melhor = null;
    for (const altura of alturas) {
      const d = Math.abs(altura - y);
      if (d <= tolerancia && (melhor === null || d < Math.abs(melhor - y))) {
        melhor = altura;
      }
    }
    return melhor;
  }

  /** Nível mais próximo em altura, sem exigir tolerância. Para o destino. */
  _nivelLivre(ix, iz, y) {
    const alturas = this.niveis.get(this._indice(ix, iz));
    if (!alturas) return null;
    let melhor = alturas[0];
    for (const altura of alturas) {
      if (Math.abs(altura - y) < Math.abs(melhor - y)) melhor = altura;
    }
    return melhor;
  }

  /**
   * A* de `de` até `para`, ambos em coordenadas de mundo.
   * Devolve uma lista de pontos, ou null se não houver caminho.
   */
  encontrarCaminho(de, para, maxNos = 20000) {
    const [ax, az] = this.paraCelula(de.x, de.z);
    const [bx, bz] = this.paraCelula(para.x, para.z);

    const yInicio = this.nivelEm(ax, az, de.y, 1.2);
    const yFim = this._nivelLivre(bx, bz, para.y);
    if (yInicio === null || yFim === null) return null;

    const inicio = `${ax},${az},${yInicio.toFixed(2)}`;
    const alvo = `${bx},${bz},${yFim.toFixed(2)}`;
    if (inicio === alvo) return [para.clone()];

    const h = (x, z) => {
      const dx = Math.abs(x - bx);
      const dz = Math.abs(z - bz);
      // Octile: diagonais custam sqrt(2), o resto custa 1.
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };

    const abertos = new Map([[inicio, { ix: ax, iz: az, y: yInicio, g: 0, f: h(ax, az), pai: null }]]);
    const fechados = new Set();
    let visitados = 0;

    while (abertos.size) {
      // Sem fila de prioridade: a grade é pequena e um mínimo linear custa
      // menos do que a complexidade de manter um heap correto aqui.
      let chaveAtual = null;
      let atual = null;
      for (const [chave, no] of abertos) {
        if (!atual || no.f < atual.f) {
          atual = no;
          chaveAtual = chave;
        }
      }

      if (chaveAtual === alvo || (atual.ix === bx && atual.iz === bz)) {
        return this._reconstruir(atual, para);
      }

      abertos.delete(chaveAtual);
      fechados.add(chaveAtual);
      if (++visitados > maxNos) return null;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const nx = atual.ix + dx;
          const nz = atual.iz + dz;
          if (nx < 0 || nz < 0 || nx >= this.nx || nz >= this.nz) continue;

          const ny = this.nivelEm(nx, nz, atual.y);
          if (ny === null) continue;

          // Na diagonal, exigir os dois ortogonais livres: sem isso o caminho
          // corta quinas de parede pelo vértice, onde o corpo não passa.
          if (dx && dz) {
            if (this.nivelEm(atual.ix + dx, atual.iz, atual.y) === null) continue;
            if (this.nivelEm(atual.ix, atual.iz + dz, atual.y) === null) continue;
          }

          const chave = `${nx},${nz},${ny.toFixed(2)}`;
          if (fechados.has(chave)) continue;

          const passo = dx && dz ? Math.SQRT2 : 1;
          // Subir custa mais: entre um desvio plano e uma escada, o plano vence.
          const custo = atual.g + passo + Math.abs(ny - atual.y) * 2;

          const existente = abertos.get(chave);
          if (existente && existente.g <= custo) continue;
          abertos.set(chave, {
            ix: nx, iz: nz, y: ny, g: custo, f: custo + h(nx, nz), pai: atual,
          });
        }
      }
    }

    return null;
  }

  _reconstruir(no, destinoOriginal) {
    const bruto = [];
    for (let atual = no; atual; atual = atual.pai) {
      const [x, z] = this.paraMundo(atual.ix, atual.iz);
      bruto.push(new THREE.Vector3(x, atual.y, z));
    }
    bruto.reverse();
    bruto.push(destinoOriginal.clone());
    return this._suavizar(bruto);
  }

  /**
   * Tira os pontos intermediários que não mudam o trajeto.
   *
   * A* devolve o caminho célula a célula, e seguir isso à risca faz o
   * personagem andar em ziguezague de 40 cm. Se dá para ir direto de A a C,
   * B não precisa existir.
   */
  _suavizar(pontos) {
    if (pontos.length <= 2) return pontos;

    const saida = [pontos[0]];
    let ancora = 0;

    for (let i = 2; i < pontos.length; i++) {
      if (!this._temVisada(pontos[ancora], pontos[i])) {
        saida.push(pontos[i - 1]);
        ancora = i - 1;
      }
    }
    saida.push(pontos[pontos.length - 1]);
    return saida;
  }

  /** Há linha reta caminhável entre dois pontos? Amostra a cada meia célula. */
  _temVisada(a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const distancia = Math.hypot(dx, dz);
    const passos = Math.ceil(distancia / (this.celula * 0.5));
    if (passos === 0) return true;

    let yAnterior = a.y;
    for (let i = 1; i <= passos; i++) {
      const t = i / passos;
      const [ix, iz] = this.paraCelula(a.x + dx * t, a.z + dz * t);
      const y = this.nivelEm(ix, iz, yAnterior);
      if (y === null) return false;
      yAnterior = y;
    }
    return true;
  }
}
