import * as THREE from "three";

/**
 * Interruptores de luz: onde a lagartixa pode apagar as luzes.
 *
 * Antes bastava estar grudada em QUALQUER parede, o que tornava o poder um
 * botão sem lugar -- e não havia nada na tela dizendo isso, então parecia
 * quebrado. Aqui ele ganha endereço: pontos fixos, marcados, que precisam ser
 * alcançados. Escalar deixa de ser enfeite e vira o caminho até o interruptor.
 *
 * As posições são achadas em carga porque o cenário vem fundido em 19 malhas
 * por material -- não existe um objeto "interruptor" para procurar. Em vez de
 * fingir que existe, a busca coloca os pontos onde um interruptor estaria:
 * numa parede, à altura da mão, perto de onde se anda.
 */

const ALTURA = 1.25;       // altura de interruptor de verdade
const SEPARACAO = 9;       // metros entre um e outro, para espalhar pelo prédio
const MAXIMO = 8;
const ALCANCE = 1.3;       // o quanto é preciso chegar perto para acionar

/** O eixo que a placa considera "frente"; veja `criarBotao`. */
const FRENTE = new THREE.Vector3(0, 0, 1);

/** Um ponto de parede, à altura da mão, perto de piso caminhável. */
function procurar(colisor, grade) {
  const raio = new THREE.Raycaster();
  raio.firstHitOnly = true;
  const achados = [];

  // Direções em leque: uma parede pode estar para qualquer lado da coluna.
  const direcoes = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    direcoes.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
  }

  const colunas = [...grade.niveis.entries()];
  // Passo largo: varrer 7 mil colunas seria lento e daria interruptor de metro
  // em metro. O que interessa é cobrir o prédio, não cada canto.
  const passo = Math.max(1, Math.floor(colunas.length / 400));

  for (let c = 0; c < colunas.length && achados.length < MAXIMO; c += passo) {
    const [indice, alturas] = colunas[c];
    // Faixa estreita, e não "acima de 3": a grade também considera tampo de
    // mesa e armário como piso caminhável, e o interruptor acabava nascendo a
    // 2,3 m da parede, na altura de quem sobe no móvel.
    const piso = alturas.find((y) => y >= 3.1 && y <= 3.6);
    if (piso === undefined) continue;

    const ix = Math.floor(indice / grade.nz);
    const iz = indice % grade.nz;
    const [x, z] = grade.paraMundo(ix, iz);
    const origem = new THREE.Vector3(x, piso + ALTURA, z);

    for (const dir of direcoes) {
      raio.set(origem, dir);
      raio.near = 0;
      raio.far = 1.4;
      const toque = raio.intersectObject(colisor, true)[0];
      if (!toque?.face) continue;

      // Só parede: piso e teto não têm interruptor.
      const normal = toque.face.normal.clone()
        .transformDirection(toque.object.matrixWorld);
      if (Math.abs(normal.y) > 0.35) continue;

      // A parede precisa ser LARGA e LISA em volta do ponto.
      //
      // Sem isto o interruptor nascia em tirinhas de parede -- entre o alarme
      // de incêndio e o batente do elevador, em quina de divisória -- e a
      // placa ficava metade para fora, num lugar onde ninguém procuraria.
      // Quatro sondas paralelas devem bater na MESMA parede, à mesma
      // distância.
      const lado = new THREE.Vector3(-dir.z, 0, dir.x);
      let liso = true;
      for (const [dx, dy] of [[-0.35, 0], [0.35, 0], [0, 0.3], [0, -0.3]]) {
        const de = origem.clone().addScaledVector(lado, dx);
        de.y += dy;
        raio.set(de, dir);
        raio.far = 1.4;
        const t2 = raio.intersectObject(colisor, true)[0];
        if (!t2 || Math.abs(t2.distance - toque.distance) > 0.12) { liso = false; break; }
      }
      if (!liso) continue;

      // E precisa haver espaço livre à frente, para dar para chegar até ela.
      raio.set(toque.point.clone().addScaledVector(dir, -0.15), dir.clone().negate());
      raio.far = 1.2;
      if (raio.intersectObject(colisor, true)[0]) continue;

      // Longe o bastante dos outros, para não nascerem em cacho.
      const ponto = toque.point.clone().addScaledVector(dir, -0.06);
      if (achados.some((p) => p.ponto.distanceTo(ponto) < SEPARACAO)) continue;

      // A normal aponta para dentro do cômodo, e é para lá que a placa olha.
      achados.push({ ponto, normal: dir.clone().negate() });
      break;
    }
  }
  return achados;
}

/**
 * O interruptor em si: uma placa com um botão vermelho.
 *
 * Sem ele havia só uma exclamação pairando na parede, e não dava para saber
 * ONDE apertar -- o alvo era um ponto invisível. A placa dá o alvo; a
 * exclamação, que fica exatamente em cima dela, dá a chamada de longe.
 */
function criarBotao() {
  const grupo = new THREE.Group();

  const placa = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.22, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xe8ecf4, roughness: 0.6 }),
  );

  const botao = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.03, 16),
    new THREE.MeshStandardMaterial({
      color: 0xe8433f,
      roughness: 0.35,
      // Aceso por dentro: num escritório escuro a placa branca some, e o que
      // se procura é justamente o ponto vermelho.
      emissive: 0xe8433f,
      emissiveIntensity: 0.7,
    }),
  );
  // Deitado sobre a placa e saliente, para ler como botão de apertar.
  botao.rotation.x = Math.PI / 2;
  botao.position.z = 0.02;

  grupo.add(placa, botao);
  grupo.userData.botao = botao;
  return grupo;
}

/** A exclamação que sobe e desce sobre o interruptor. */
function criarMarca(cor) {
  const grupo = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: cor,
    transparent: true,
    opacity: 0.95,
    // Atravessa parede: a graça é justamente saber que há um interruptor do
    // outro lado do móvel, senão o marcador só serviria para o que já se vê.
    depthTest: false,
    depthWrite: false,
  });

  // Grande o bastante para ler como exclamação de longe: no tamanho anterior
  // a haste e o ponto se fundiam num risquinho amarelo sem significado.
  const haste = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.38, 0.03), material);
  haste.position.y = 0.26;
  const ponto = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.03), material);
  ponto.position.y = -0.02;

  grupo.add(haste, ponto);
  grupo.renderOrder = 998;
  return grupo;
}

export class Interruptores {
  constructor(cena, colisor, grade, cor = 0xffd479) {
    this.cena = cena;
    const achados = procurar(colisor, grade);
    this.pontos = achados.map((a) => a.ponto);
    this.marcas = [];
    this.botoes = [];

    achados.forEach(({ ponto, normal }) => {
      // A placa fica sempre visível: faz parte do cenário, não é dica.
      const botao = criarBotao();
      botao.position.copy(ponto);
      // `setFromUnitVectors` em vez de `lookAt`: gira o +Z da placa até a
      // normal da parede, sem depender da posição do objeto nem do vetor
      // "up". Com `lookAt` a placa saía de perfil -- ficava um risco branco na
      // parede, e o botão vermelho apontava para dentro do concreto.
      botao.quaternion.setFromUnitVectors(FRENTE, normal);
      cena.add(botao);
      this.botoes.push(botao);

      // A exclamação, exatamente em cima da placa.
      const marca = criarMarca(cor);
      marca.position.copy(ponto);
      marca.position.y += 0.42;
      marca.visible = false;
      cena.add(marca);
      this.marcas.push(marca);
    });
  }

  /** O interruptor ao alcance, ou null. */
  aoAlcance(posicao) {
    let melhor = null;
    let dist = ALCANCE;
    for (const p of this.pontos) {
      const d = p.distanceTo(posicao);
      if (d < dist) { dist = d; melhor = p; }
    }
    return melhor;
  }

  /** O mais próximo em qualquer distância, para dizer o quão longe está. */
  distanciaAoMaisProximo(posicao) {
    let dist = Infinity;
    for (const p of this.pontos) dist = Math.min(dist, p.distanceTo(posicao));
    return dist;
  }

  /**
   * `mostrar` liga os marcadores (só a lagartixa os vê).
   *
   * Eles balançam de cima para baixo e encaram a câmera: parados, some no meio
   * da tralha do escritório; virados de lado, viram um risco fino.
   */
  atualizar(dt, mostrar, camera, posicao) {
    this._t = (this._t ?? 0) + dt;
    for (let i = 0; i < this.marcas.length; i++) {
      const marca = this.marcas[i];
      marca.visible = mostrar;
      if (!mostrar) continue;

      marca.position.x = this.pontos[i].x;
      marca.position.z = this.pontos[i].z;
      marca.position.y = this.pontos[i].y + 0.42 + Math.sin(this._t * 2.6 + i) * 0.1;
      marca.quaternion.copy(camera.quaternion);

      // Acende ao ficar ao alcance: é o aviso de que dá para acionar agora.
      const perto = posicao && this.pontos[i].distanceTo(posicao) < ALCANCE;
      for (const parte of marca.children) {
        parte.material.opacity = perto ? 1 : 0.5;
      }
      marca.scale.setScalar(perto ? 1.35 : 1);

      // O botão pulsa quando dá para acionar; parado, fica só aceso de leve.
      const luz = this.botoes[i]?.userData.botao?.material;
      if (luz) {
        luz.emissiveIntensity = perto ? 1.4 + Math.sin(this._t * 8) * 0.5 : 0.55;
      }
    }
  }

  limpar() {
    for (const m of this.marcas) this.cena.remove(m);
    for (const b of this.botoes) this.cena.remove(b);
    this.marcas.length = 0;
    this.botoes.length = 0;
  }
}
