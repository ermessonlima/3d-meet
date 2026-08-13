import * as THREE from "three";

/**
 * Pintura manual da lagartixa: um atlas de textura desenhado com pincel.
 *
 * O modelo vem do Blender sem UV nenhuma -- são 11 caixas de cor chapada. Aqui
 * a UV é gerada em carga: cada caixa ganha um quadrante do atlas, e dentro dele
 * cada uma das 6 faces ganha um retângulo. Como toda face é um paralelogramo
 * plano, a conversão entre ponto 3D e pixel do atlas é linear e exata.
 *
 * A pincelada acontece em ESPAÇO 3D, não em espaço de UV. Pintar em UV parece
 * mais simples, mas quebra nas emendas: uma pincelada em cima do quadril
 * pintaria o corpo e deixaria a perna intacta, porque as duas ocupam
 * retângulos distantes no atlas. Aqui o pincel é uma esfera; para cada face
 * calculamos a interseção esfera-plano (um círculo de raio menor) e desenhamos
 * esse círculo no retângulo da face. O traço atravessa as quinas sozinho.
 */

// 9 partes pintáveis (os olhos ficam de fora) numa grade 3x3, e cada parte
// subdividida em 3x2 para as 6 faces da caixa.
export const LADO = 1024;
const LADO_REDE = 512;
const SLOTS = 3;
const FACES_X = 3;
const FACES_Y = 2;

/** Agrupa os vértices de uma caixa por face, usando a normal como chave. */
function agruparFaces(geometria) {
  const pos = geometria.getAttribute("position");
  const nor = geometria.getAttribute("normal");
  const grupos = new Map();

  for (let i = 0; i < pos.count; i++) {
    // Arredondar antes de virar chave: as normais saem do exportador com
    // ruído de ponto flutuante e "1.0000001" não bate com "1".
    const chave = [nor.getX(i), nor.getY(i), nor.getZ(i)]
      .map((v) => Math.round(v * 1000) / 1000)
      .join(",");
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(i);
  }

  const saida = [];
  for (const [chave, indices] of grupos) {
    if (indices.length < 4) continue;
    const normal = new THREE.Vector3(...chave.split(",").map(Number));
    const cantos = indices.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));

    // Ordena os 4 cantos em volta do centro, no plano da face: sem isso os
    // vértices vêm na ordem do buffer e o quadrilátero sai em ampulheta.
    const centro = cantos
      .reduce((a, c) => a.add(c), new THREE.Vector3())
      .divideScalar(cantos.length);
    const eixoU = cantos[0].clone().sub(centro).normalize();
    const eixoV = new THREE.Vector3().crossVectors(normal, eixoU).normalize();
    const ordem = indices
      .map((indice, k) => {
        const d = cantos[k].clone().sub(centro);
        return { indice, canto: cantos[k], ang: Math.atan2(d.dot(eixoV), d.dot(eixoU)) };
      })
      .sort((a, b) => a.ang - b.ang);

    saida.push({ normal, ordem });
  }
  return saida;
}

/** As malhas do corpo, sem os olhos (que nunca são pintados). */
function partesPintaveis(raiz) {
  const partes = [];
  raiz.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => /olho/i.test(m?.name ?? ""))) return;
    partes.push(o);
  });
  return partes;
}

/**
 * Dá a cada avatar a própria cópia dos materiais.
 *
 * O GLB tem UM material para as 11 caixas, e tanto o cache do carregador
 * quanto o `SkeletonUtils.clone` dos avatares remotos reaproveitam a mesma
 * instância. Sem isolar, pintar uma lagartixa pintaria todas as outras da
 * sala da mesma cor -- e a textura de pintura de uma vazaria para as demais.
 */
export function isolarMateriais(raiz) {
  const copias = new Map();
  raiz.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const trocar = (m) => {
      if (!copias.has(m.uuid)) copias.set(m.uuid, m.clone());
      return copias.get(m.uuid);
    };
    o.material = Array.isArray(o.material) ? o.material.map(trocar) : trocar(o.material);
  });
}

/**
 * Gera as UVs do modelo, uma única vez por geometria.
 *
 * As geometrias são compartilhadas entre todas as lagartixas (só os materiais
 * são clonados), então o desdobramento vale para a sala inteira e não pode ser
 * refeito a cada avatar.
 */
export function garantirUV(raiz) {
  const partes = partesPintaveis(raiz);
  const passo = 1 / SLOTS;
  const faceW = passo / FACES_X;
  const faceH = passo / FACES_Y;
  // Sem margem, o filtro bilinear puxa a cor do retângulo vizinho e cada face
  // aparece com uma borda da cor errada.
  const margem = 1.5 / LADO;

  return partes.map((malha, iParte) => {
    const geo = malha.geometry;
    if (geo.userData.facesDePintura) {
      return { malha, faces: geo.userData.facesDePintura };
    }

    const uv = new Float32Array(geo.getAttribute("position").count * 2);
    const sx = (iParte % SLOTS) * passo;
    const sy = Math.floor(iParte / SLOTS) * passo;
    const listaFaces = [];

    agruparFaces(geo).forEach((face, iFace) => {
      const rx = sx + (iFace % FACES_X) * faceW + margem;
      const ry = sy + Math.floor(iFace / FACES_X) * faceH + margem;
      const rw = faceW - margem * 2;
      const rh = faceH - margem * 2;

      const [c0, c1, , c3] = face.ordem.map((o) => o.canto);
      const eixoU = c1.clone().sub(c0);
      const eixoV = c3.clone().sub(c0);
      const compU = eixoU.length();
      const compV = eixoV.length();
      eixoU.normalize();
      eixoV.normalize();

      face.ordem.forEach(({ indice, canto }) => {
        const d = canto.clone().sub(c0);
        uv[indice * 2] = rx + (d.dot(eixoU) / compU) * rw;
        uv[indice * 2 + 1] = ry + (d.dot(eixoV) / compV) * rh;
      });

      listaFaces.push({
        origem: c0.clone(),
        normal: face.normal,
        eixoU, eixoV, compU, compV,
        px: rx * LADO, py: ry * LADO, pw: rw * LADO, ph: rh * LADO,
      });
    });

    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.userData.facesDePintura = listaFaces;
    return { malha, faces: listaFaces };
  });
}

/** Prepara uma textura para ser usada como pintura do corpo. */
function vestir(raiz, textura) {
  const vistos = [];
  for (const malha of partesPintaveis(raiz)) {
    const mats = Array.isArray(malha.material) ? malha.material : [malha.material];
    for (const m of mats) {
      if (!m || vistos.includes(m)) continue;
      m.map = textura;
      // A cor do material multiplica a textura; deixá-la como estava tingiria
      // de verde tudo o que fosse pintado por cima.
      m.color.setRGB(1, 1, 1);
      m.needsUpdate = true;
      vistos.push(m);
    }
  }
  return vistos;
}

/** O atlas pintável da SUA lagartixa. */
export class TelaDePintura {
  constructor(raiz) {
    isolarMateriais(raiz);
    this.partes = garantirUV(raiz);

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = LADO;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    this.textura = new THREE.CanvasTexture(this.canvas);
    // `flipY = false` alinha a origem da UV com a origem do canvas, então a
    // conta de pixel da pincelada é direta, sem inverter V no meio do caminho.
    this.textura.flipY = false;
    this.textura.colorSpace = THREE.SRGBColorSpace;

    this.materiais = vestir(raiz, this.textura);

    this._inversa = new THREE.Matrix4();
    this._centroLocal = new THREE.Vector3();
    this._escala = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._t = new THREE.Vector3();
  }

  /** Pinta o atlas inteiro de uma cor só. */
  preencher(cor) {
    this.ctx.fillStyle = cor;
    this.ctx.fillRect(0, 0, LADO, LADO);
    this.textura.needsUpdate = true;
  }

  /**
   * Uma pincelada esférica em `ponto` (coordenadas do mundo), raio em metros.
   *
   * Devolve `true` se encostou em alguma face -- é o que diz à interface se o
   * traço pegou o bicho ou passou ao lado.
   */
  pincelar(ponto, cor, raio) {
    this.ctx.fillStyle = cor;
    let tocou = false;

    for (const { malha, faces } of this.partes) {
      malha.updateWorldMatrix(true, false);
      this._inversa.copy(malha.matrixWorld).invert();
      this._centroLocal.copy(ponto).applyMatrix4(this._inversa);

      // O raio também precisa sair do mundo para o espaço da malha: as caixas
      // vêm com escala no nó, e um pincel de 2 cm viraria um borrão.
      malha.matrixWorld.decompose(this._t, this._q, this._escala);
      const raioLocal = raio / Math.max(this._escala.x, 1e-6);

      for (const face of faces) {
        const desloc = this._centroLocal.clone().sub(face.origem);
        const dist = desloc.dot(face.normal);
        if (Math.abs(dist) >= raioLocal) continue;

        // Círculo que a esfera recorta no plano da face.
        const rCirc = Math.sqrt(raioLocal * raioLocal - dist * dist);
        const a = desloc.dot(face.eixoU) / face.compU;
        const b = desloc.dot(face.eixoV) / face.compV;
        const folgaU = rCirc / face.compU;
        const folgaV = rCirc / face.compV;
        if (a < -folgaU || a > 1 + folgaU || b < -folgaV || b > 1 + folgaV) continue;

        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(face.px, face.py, face.pw, face.ph);
        this.ctx.clip();
        this.ctx.beginPath();
        // A face raramente é quadrada, então o círculo vira elipse em pixels.
        this.ctx.ellipse(
          face.px + a * face.pw,
          face.py + b * face.ph,
          folgaU * face.pw,
          folgaV * face.ph,
          0, 0, Math.PI * 2,
        );
        this.ctx.fill();
        this.ctx.restore();
        tocou = true;
      }
    }

    if (tocou) this.textura.needsUpdate = true;
    return tocou;
  }

  /**
   * O atlas em PNG, para mandar pela rede.
   *
   * Sai reduzido: pintar precisa de 1024 para o traço não virar escada, mas
   * quem vê a lagartixa do outro lado da sala vê um bicho de 10 cm ocupando
   * poucas dezenas de pixels na tela. Mandar o atlas cheio seria quadruplicar
   * o pacote para uma diferença que ninguém enxerga.
   */
  paraPNG(tetoBytes = Infinity) {
    if (!this._reduzido) this._reduzido = document.createElement("canvas");

    // Uma pintura cheia de manchas de cores diferentes comprime muito pior do
    // que uma de poucas cores chapadas. Em vez de torcer para caber no teto do
    // servidor -- e ser descartada em silêncio quando não coubesse --, cai de
    // resolução até caber. Perder nitidez num bicho de 10 cm visto de longe é
    // melhor do que a sala inteira não ver a pintura.
    let lado = LADO_REDE;
    let saida = "";
    while (true) {
      this._reduzido.width = this._reduzido.height = lado;
      const ctx = this._reduzido.getContext("2d");
      ctx.clearRect(0, 0, lado, lado);
      ctx.drawImage(this.canvas, 0, 0, lado, lado);
      saida = this._reduzido.toDataURL("image/png");
      if (saida.length <= tetoBytes || lado <= 128) return saida;
      lado /= 2;
    }
  }

  descartar() {
    this.textura.dispose();
  }
}

/**
 * Tira o atlas de um avatar, devolvendo-o à cor chapada.
 *
 * É o par do "Cobrir tudo": sem isto, a cor nova seria multiplicada pela
 * textura antiga e o avatar continuaria com o desenho de antes.
 */
export function limparPinturaRemota(raiz) {
  const usadas = new Set();
  raiz.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m?.map) continue;
      usadas.add(m.map);
      m.map = null;
      m.needsUpdate = true;
    }
  });
  for (const t of usadas) t.dispose();
}

/**
 * Aplica numa lagartixa remota a pintura que ela mandou pela rede.
 *
 * Aqui basta uma `Texture` sobre a `Image` decodificada -- avatares remotos não
 * são pintados, então não precisam do canvas 2D de 4 MB que a `TelaDePintura`
 * carrega.
 */
export function aplicarPinturaRemota(raiz, dataUrl) {
  return new Promise((ok, erro) => {
    const img = new Image();
    img.onload = () => {
      const textura = new THREE.Texture(img);
      textura.flipY = false;
      textura.colorSpace = THREE.SRGBColorSpace;
      textura.needsUpdate = true;
      garantirUV(raiz);
      // Recolhe as texturas ANTES de vestir: depois da troca `m.map` já é a
      // nova, e a antiga vazaria na GPU a cada repintura recebida.
      const antigas = new Set();
      raiz.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m?.map && m.map !== textura) antigas.add(m.map);
        }
      });
      vestir(raiz, textura);
      for (const t of antigas) t.dispose();
      ok(textura);
    };
    img.onerror = () => erro(new Error("PNG de pintura inválido"));
    img.src = dataUrl;
  });
}
