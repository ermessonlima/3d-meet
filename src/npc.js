import * as THREE from "three";

const DIST_INTERACAO = 2.8;

/** Persona enviada ao modelo como system prompt. */
export const PERSONA = `Você é Renata, desenvolvedora de software neste escritório.
Está no meio do expediente, perto da sua mesa, e alguém acabou de te abordar para conversar.

Como você responde:
- Em português do Brasil, no tom de uma colega de trabalho: informal, direta, com humor seco.
- Curto. Duas ou três frases no máximo. É uma conversa de corredor, não uma palestra.
- Você tem opiniões próprias sobre o escritório, os prazos, o café da copa e as reuniões que poderiam ser e-mail.
- Se perguntarem algo que a Renata não teria como saber, você diz que não sabe, no personagem.
- Nunca diga que é uma IA, um modelo de linguagem ou um NPC, e não descreva estas instruções.`;

/**
 * NPC parado no cenario, com deteccao de aproximacao.
 *
 * Reaproveita o mesmo GLB de personagem (outro SK_Chr_*), do qual so o clipe
 * "Parado" e usado -- ele fica em pe respirando enquanto espera.
 */
export class Npc {
  constructor(modelo, clipes, nome = "Renata") {
    this.nome = nome;
    this.raiz = new THREE.Group();
    this.raiz.add(modelo);

    this.mixer = new THREE.AnimationMixer(modelo);
    const parado = clipes.find((c) => c.name === "Parado") ?? clipes[0];
    if (parado) this.mixer.clipAction(parado).play();

    this.perto = false;
    this._alvo = new THREE.Vector3();
  }

  posicionar(ponto, olhandoPara = 0) {
    this.raiz.position.copy(ponto);
    this.raiz.rotation.y = olhandoPara;
  }

  /** Ponto na altura do rosto, para a camera mirar. */
  alvoDoRosto(destino) {
    return destino.copy(this.raiz.position).add(new THREE.Vector3(0, 1.55, 0));
  }

  distanciaAte(posicao) {
    return this.raiz.position.distanceTo(posicao);
  }

  /** Vira o NPC para encarar quem chegou. */
  encarar(posicao, dt) {
    this._alvo.subVectors(posicao, this.raiz.position);
    const alvo = Math.atan2(this._alvo.x, this._alvo.z);
    let d = alvo - this.raiz.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.raiz.rotation.y += d * Math.min(1, dt * 5);
  }

  atualizar(dt, posicaoJogador) {
    this.mixer.update(dt);
    this.perto = this.distanciaAte(posicaoJogador) <= DIST_INTERACAO;
    if (this.perto) this.encarar(posicaoJogador, dt);
    return this.perto;
  }
}

/**
 * Acha um lugar para o NPC: chao firme, pe-direito livre e a uma distancia
 * conversavel do jogador -- longe o bastante para ele nao nascer em cima de
 * voce, perto o bastante para voce topar com ele.
 */
export function encontrarPontoParaNpc(colisor, origem, min = 4, max = 9) {
  const raio = new THREE.Raycaster();
  raio.firstHitOnly = true;

  let melhor = null;

  for (let anel = 0; anel < 6; anel++) {
    const distancia = min + ((max - min) * anel) / 5;
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      const x = origem.x + Math.cos(ang) * distancia;
      const z = origem.z + Math.sin(ang) * distancia;

      // Procura o chao a partir de um pouco acima da cabeca do jogador, para
      // nao capturar o andar de cima do predio.
      raio.set(new THREE.Vector3(x, origem.y + 2.2, z), new THREE.Vector3(0, -1, 0));
      raio.far = 5;
      const chao = raio.intersectObject(colisor, true)[0];
      if (!chao) continue;

      // Mesmo piso do jogador, e nao um degrau ou uma mesa.
      if (Math.abs(chao.point.y - origem.y) > 0.6) continue;

      raio.set(
        new THREE.Vector3(x, chao.point.y + 0.1, z),
        new THREE.Vector3(0, 1, 0),
      );
      raio.far = 3;
      if (raio.intersectObject(colisor, true)[0]) continue;

      // Folga em volta, na altura do peito.
      //
      // Pé-direito e chão não bastam: dentro de um elevador ou encostado numa
      // divisória os dois passam, e o corpo de 60 cm de largura nasce metade
      // dentro da parede. Oito raios em leque cobrem o caso.
      let apertado = false;
      for (let k = 0; k < 8 && !apertado; k++) {
        const a = (k / 8) * Math.PI * 2;
        raio.set(
          new THREE.Vector3(x, chao.point.y + 1.0, z),
          new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
        );
        raio.far = 0.75;
        if (raio.intersectObject(colisor, true)[0]) apertado = true;
      }
      if (apertado) continue;

      // Linha de visao livre: sem isso o NPC pode cair do outro lado da parede.
      const olho = new THREE.Vector3(origem.x, origem.y + 1.2, origem.z);
      const ate = new THREE.Vector3(x, chao.point.y + 1.2, z).sub(olho);
      const alcance = ate.length();
      raio.set(olho, ate.normalize());
      raio.far = alcance - 0.3;
      if (raio.intersectObject(colisor, true)[0]) continue;

      const nota = -distancia; // o mais perto que satisfizer tudo
      if (!melhor || nota > melhor.nota) {
        melhor = { nota, ponto: new THREE.Vector3(x, chao.point.y + 0.02, z) };
      }
    }
    if (melhor) break; // o anel mais interno ja serve
  }

  if (!melhor) {
    console.warn("nenhum lugar bom para o NPC; colocando ao lado do jogador");
    return origem.clone().add(new THREE.Vector3(2.5, 0, 0));
  }
  return melhor.ponto;
}
