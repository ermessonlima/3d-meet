"""
Modela e anima a lagartixa, exportando public/models/lagartixa.glb.

    blender --background --factory-startup --python tools/lagartixa.py

O pacote POLYGON Office nao tem nenhum reptil -- so um peixe de aquario --
entao o bicho e construido aqui, a partir de caixas, no mesmo espirito
low-poly facetado do resto do cenario.

## Sem esqueleto, de proposito

O personagem humano usa skinning porque veio riggado da Synty. A lagartixa nao
precisa: ela e uma HIERARQUIA de peças separadas (corpo, cabeca, quatro patas,
tres segmentos de cauda) e a animacao gira os NOS, nao ossos. O glTF suporta
isso nativamente, e evita escrever pesos de skinning a mao -- que seria a parte
mais chata e mais fragil de rigar um bicho do zero.

## Material unico

Um material so, cor chapada, sem textura. E o que torna "pintar a lagartixa"
trivial no jogo: e uma cor de material, nao um atlas com regioes.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Vector, Quaternion

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = os.path.join(RAIZ, "public", "models", "lagartixa.glb")

FPS = 24

# Medidas em metros. Uma lagartixa de escritorio: pequena o bastante para se
# esconder atras das coisas, grande o bastante para ser vista e acertada.
CORPO = (0.10, 0.24, 0.07)     # largura, comprimento, altura
CABECA = (0.085, 0.11, 0.055)
PATA = (0.034, 0.034, 0.082)
CAUDA = [(0.055, 0.10, 0.045), (0.040, 0.09, 0.034), (0.026, 0.09, 0.024)]

ALTURA_CORPO = 0.075           # centro do corpo acima do chao


def log(msg):
    print("[lagartixa] %s" % msg, flush=True)


def caixa(nome, tamanho, local=(0, 0, 0), pai=None, conicidade=1.0):
    """Cria uma caixa. `conicidade` afina a ponta +Y, para cauda e focinho."""
    lx, ly, lz = (t / 2 for t in tamanho)
    k = conicidade

    verts = [
        (-lx, -ly, -lz), (lx, -ly, -lz), (lx, -ly, lz), (-lx, -ly, lz),
        (-lx * k, ly, -lz * k), (lx * k, ly, -lz * k),
        (lx * k, ly, lz * k), (-lx * k, ly, lz * k),
    ]
    faces = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
        (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ]

    malha = bpy.data.meshes.new(nome)
    malha.from_pydata(verts, [], faces)
    # Sombreamento facetado: e o que dá o visual low-poly do resto da cena.
    malha.shade_flat()
    malha.update()

    obj = bpy.data.objects.new(nome, malha)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = Vector(local)
    if pai:
        obj.parent = pai
        obj.matrix_parent_inverse.identity()
    return obj


def montar():
    bpy.ops.wm.read_factory_settings(use_empty=True)

    raiz = bpy.data.objects.new("Lagartixa", None)
    bpy.context.scene.collection.objects.link(raiz)

    corpo = caixa("corpo", CORPO, (0, 0, ALTURA_CORPO), raiz)

    # A cabeca fica na frente (+Y no Blender vira +Z no glTF, a frente do jogo).
    cabeca = caixa("cabeca", CABECA, (0, CORPO[1] / 2 + CABECA[1] / 2 - 0.01, 0.004),
                   corpo, conicidade=0.72)

    # Olhos: duas caixinhas escuras, o suficiente para ler como rosto.
    for lado, sx in (("L", 1), ("R", -1)):
        caixa("olho_%s" % lado, (0.022, 0.022, 0.022),
              (sx * 0.030, 0.012, 0.024), cabeca)

    # Patas: pivo no ombro/quadril, caixa descendo a partir dali.
    patas = {}
    for nome, sx, sy in (("FL", 1, 1), ("FR", -1, 1), ("TL", 1, -1), ("TR", -1, -1)):
        pivo = bpy.data.objects.new("pata_%s" % nome, None)
        bpy.context.scene.collection.objects.link(pivo)
        pivo.parent = corpo
        pivo.matrix_parent_inverse.identity()
        pivo.location = Vector((sx * CORPO[0] / 2, sy * CORPO[1] * 0.3, -0.012))
        caixa("perna_%s" % nome, PATA, (sx * 0.012, 0, -PATA[2] / 2), pivo,
              conicidade=0.7)
        patas[nome] = pivo

    # Cauda: cada segmento e filho do anterior, entao girar o primeiro balanca
    # a cauda inteira.
    #
    # A posicao de cada elo e relativa ao PAI, entao o deslocamento e
    # (metade do pai) + (metade do filho), menos uma sobreposicao para nao
    # abrir fresta quando a cauda dobra. Usar o comprimento errado aqui
    # desmonta a cauda em pedacos flutuando.
    cauda = []
    pai = corpo
    comprimento_pai = CORPO[1]
    for i, tam in enumerate(CAUDA):
        y = -(comprimento_pai / 2) - (tam[1] / 2) + 0.010
        seg = caixa("cauda_%d" % (i + 1), tam, (0, y, -0.004 if i == 0 else 0),
                    pai, conicidade=0.74)
        cauda.append(seg)
        pai = seg
        comprimento_pai = tam[1]

    return raiz, corpo, cabeca, patas, cauda


def material(raiz):
    """Um material, cor chapada. O jogo troca a cor para 'pintar' o bicho."""
    mat = bpy.data.materials.new("Lagartixa")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    saida = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.36, 0.62, 0.30, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.7
    bsdf.inputs["Metallic"].default_value = 0.0
    links.new(bsdf.outputs["BSDF"], saida.inputs["Surface"])
    # O modo Workbench (usado nos previews) lê diffuse_color, não o nó.
    mat.diffuse_color = (0.36, 0.62, 0.30, 1.0)

    escuro = bpy.data.materials.new("LagartixaOlho")
    escuro.use_nodes = True
    n2 = escuro.node_tree.nodes
    n2.clear()
    s2 = n2.new("ShaderNodeOutputMaterial")
    b2 = n2.new("ShaderNodeBsdfPrincipled")
    b2.inputs["Base Color"].default_value = (0.04, 0.04, 0.05, 1.0)
    b2.inputs["Roughness"].default_value = 0.35
    escuro.node_tree.links.new(b2.outputs["BSDF"], s2.inputs["Surface"])
    escuro.diffuse_color = (0.04, 0.04, 0.05, 1.0)

    for obj in raiz.children_recursive:
        if obj.type != "MESH":
            continue
        obj.data.materials.append(escuro if obj.name.startswith("olho") else mat)


# ---------------------------------------------------------------- animacao


def _action(obj, nome):
    ad = obj.animation_data or obj.animation_data_create()
    act = bpy.data.actions.new(nome)
    ad.action = act
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots.new(id_type="OBJECT", name=obj.name)
    return act


def _chave(obj, frame, rot=None, loc=None):
    if rot is not None:
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = rot
        obj.keyframe_insert("rotation_quaternion", frame=frame)
    if loc is not None:
        obj.location = loc
        obj.keyframe_insert("location", frame=frame)


def gravar(nome, duracao_s, funcao, pecas):
    """Anima todas as peças e junta tudo num clipe só.

    Cada objeto precisa da própria action -- o Blender não tem action que
    controle vários objetos. Se paramos por aí, o exportador de glTF trata
    cada uma como uma animação separada, e um bicho de 11 peças vira 11
    "animações" que ninguém consegue tocar junto. Pior: `animation_data.action`
    guarda UMA action, então o clipe seguinte sobrescreve o anterior e só o
    último sobrevive.

    A solução é empilhar cada action numa trilha NLA com o NOME DO CLIPE. O
    exportador, em modo NLA_TRACKS, junta as trilhas homônimas de objetos
    diferentes numa única animação glTF -- que é exatamente "Andar" movendo o
    corpo, a cabeça, quatro patas e três segmentos de cauda ao mesmo tempo.
    """
    total = max(1, int(round(duracao_s * FPS)))
    for obj in pecas.values():
        _action(obj, "%s_%s" % (nome, obj.name))

    for f in range(1, total + 2):
        t = ((f - 1) % total) / total
        funcao(t, f, pecas)

    for obj in pecas.values():
        act = obj.animation_data.action
        for camada in act.layers:
            for strip in camada.strips:
                for cb in strip.channelbags:
                    for fc in cb.fcurves:
                        for kp in fc.keyframe_points:
                            kp.interpolation = "LINEAR"

        trilha = obj.animation_data.nla_tracks.new()
        trilha.name = nome
        trilha.strips.new(nome, 1, act)
        # Solta a action: sem isto o próximo clipe sobrescreve esta.
        obj.animation_data.action = None

    log("clipe '%s': %d frames" % (nome, total))


def _eixo(v, ang):
    return Quaternion(Vector(v), math.radians(ang))


def anim_parado(t, f, p):
    fase = 2 * math.pi * t
    respira = math.sin(fase)
    _chave(p["corpo"], f, rot=_eixo((1, 0, 0), 1.2 * respira),
           loc=(0, 0, ALTURA_CORPO + 0.004 * respira))
    _chave(p["cabeca"], f, rot=_eixo((0, 0, 1), 7 * math.sin(fase * 0.5)))
    for i, seg in enumerate(("cauda_1", "cauda_2", "cauda_3")):
        _chave(p[seg], f, rot=_eixo((0, 0, 1), 5 * math.sin(fase - i * 0.7)))
    for nome in ("FL", "FR", "TL", "TR"):
        _chave(p["pata_" + nome], f, rot=Quaternion())


def anim_andar(t, f, p):
    fase = 2 * math.pi * t
    # Marcha diagonal: dianteira esquerda anda junto com traseira direita.
    passo = {"FL": 0, "TR": 0, "FR": math.pi, "TL": math.pi}
    for nome, desloc in passo.items():
        _chave(p["pata_" + nome], f, rot=_eixo((1, 0, 0), 34 * math.sin(fase + desloc)))

    # O corpo serpenteia e sobe/desce duas vezes por ciclo.
    _chave(p["corpo"], f,
           rot=_eixo((0, 0, 1), 6 * math.sin(fase)),
           loc=(0, 0, ALTURA_CORPO + 0.006 * abs(math.sin(fase))))
    _chave(p["cabeca"], f, rot=_eixo((0, 0, 1), -5 * math.sin(fase)))
    # A cauda vem atrasada em relacao ao corpo: e o que da a ondulacao.
    for i, seg in enumerate(("cauda_1", "cauda_2", "cauda_3")):
        _chave(p[seg], f, rot=_eixo((0, 0, 1), 13 * math.sin(fase - (i + 1) * 0.9)))


def anim_esconder(t, f, p):
    """Achatada no chão, imóvel. Só a respiração denuncia."""
    fase = 2 * math.pi * t
    respira = math.sin(fase)
    _chave(p["corpo"], f, rot=Quaternion(),
           loc=(0, 0, 0.028 + 0.0025 * respira))
    _chave(p["cabeca"], f, rot=_eixo((1, 0, 0), 4))
    # Patas abertas para os lados, coladas ao chão.
    for nome, sx in (("FL", 1), ("FR", -1), ("TL", 1), ("TR", -1)):
        _chave(p["pata_" + nome], f, rot=_eixo((0, 1, 0), sx * 62))
    for i, seg in enumerate(("cauda_1", "cauda_2", "cauda_3")):
        _chave(p[seg], f, rot=_eixo((0, 0, 1), 2 * math.sin(fase - i)))


def exportar():
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=SAIDA,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_bake_animation=True,
        # O exportador descarta trilhas de valor constante. Parece inofensivo,
        # mas a pose de "Esconder" É constante: as patas ficam abertas num
        # ângulo fixo o clipe inteiro. Sem estas duas flags, elas somem do glTF
        # e o bicho "esconde" com as patas na posição de andar.
        #
        # `keep_anim_object` é a que importa aqui (nosso rig é hierarquia de
        # objetos, não armature); `optimize_animation_size` sozinha não basta.
        export_optimize_animation_size=False,
        export_optimize_animation_keep_anim_object=True,
        export_cameras=False,
        export_lights=False,
    )
    log("gravado %s (%.0f KB)" % (SAIDA, os.path.getsize(SAIDA) / 1024))


def main():
    raiz, corpo, cabeca, patas, cauda = montar()
    material(raiz)

    pecas = {"corpo": corpo, "cabeca": cabeca}
    for nome, pivo in patas.items():
        pecas["pata_" + nome] = pivo
    for i, seg in enumerate(cauda):
        pecas["cauda_%d" % (i + 1)] = seg

    gravar("Parado", 3.0, anim_parado, pecas)
    gravar("Andar", 0.55, anim_andar, pecas)
    gravar("Esconder", 4.0, anim_esconder, pecas)

    total = sum(1 for o in bpy.data.objects if o.type == "MESH")
    tris = sum(len(o.data.polygons) * 2 for o in bpy.data.objects if o.type == "MESH")
    log("montada: %d peças, ~%d triângulos" % (total, tris))
    exportar()


if __name__ == "__main__":
    main()
