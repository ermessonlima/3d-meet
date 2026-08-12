"""
Converte SourceFiles/Office_Demo.fbx para public/models/office_demo.glb.

Rodar com o Blender em modo headless:

    blender --background --factory-startup --python tools/fbx_to_glb.py

O FBX da Synty vem com tres problemas que este script resolve:

  1. ~533 malhas UCX_* (colisao do Unreal) que sao invisiveis no jogo mas
     apareceriam como caixas solidas no navegador.
  2. Os materiais apontam para caminhos absolutos do Windows do artista, e o
     atlas principal aponta para um .psd que nem existe no pacote. Religamos
     cada material no PNG correto a mao (tabela TEXTURAS abaixo).
  3. As luzes do Unreal (~20 point lights) vem juntas. Na web sai mais barato
     e mais bonito iluminar no three.js, entao descartamos.
"""

import json
import math
import os
import re
import sys

import bpy
from mathutils import Vector

# ---------------------------------------------------------------- caminhos

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJETO = os.path.dirname(RAIZ)

FBX = os.path.join(PROJETO, "SourceFiles", "Office_Demo.fbx")
TEXTURAS_DIR = os.path.join(PROJETO, "SourceFiles", "Textures")
SAIDA = os.path.join(RAIZ, "public", "models", "office_demo.glb")

# O FBX declara centimetros no cabecalho e o importador ja aplica essa
# conversao sozinho, entao aqui e 1.0. Passar 0.01 encolhe a cena 100x.
ESCALA = 1.0

# Nome do material no FBX -> arquivo em SourceFiles/Textures/
TEXTURAS = {
    "Mat_PolygonOffice_01_A": "PolygonOffice_Texture_01_A.png",
    "Mat_PolygonOffice_Screen_01": "PolygonOffice_Texture_Sceen_01.png",
    "Mat_PolygonOffice_Screen_02": "PolygonOffice_Texture_Sceen_02.png",
    "Mat_PolygonOffice_Screen_03": "PolygonOffice_Texture_Sceen_03.png",
    "Mat_PolygonOffice_Screen_04": "PolygonOffice_Texture_Sceen_04.png",
    "Mat_PolygonOffice_Screen_05": "PolygonOffice_Texture_Sceen_05.png",
    "Mat_PolygonOffice_Screen_Arcade_01": "PolygonOffice_Texture_Sceen_Arcade_01.png",
}

# Materiais sem textura: (cor rgba, metallic, roughness)
SEM_TEXTURA = {
    "Mat_PolygonOffice_Glass": ((0.55, 0.68, 0.72, 0.25), 0.0, 0.05),
    "Mat_PolygonOffice_Chrome": ((0.85, 0.86, 0.88, 1.0), 1.0, 0.18),
}

# As telas de monitor emitem luz propria.
EMISSIVOS = {
    "Mat_PolygonOffice_Screen_01",
    "Mat_PolygonOffice_Screen_02",
    "Mat_PolygonOffice_Screen_03",
    "Mat_PolygonOffice_Screen_04",
    "Mat_PolygonOffice_Screen_05",
    "Mat_PolygonOffice_Screen_Arcade_01",
}

# Empties/atores que o Unreal exporta junto e que nao tem uso na web.
LIXO_UNREAL = ("AbstractNavData", "AtmosphericFog", "PlayerStart", "SkySphere",
               "Demonstration_", "NavMesh", "LightmassImportance", "Brush")


def log(msg):
    print("[fbx2glb] %s" % msg, flush=True)


def limpar_cena():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def remendar_importador_de_luz():
    """Contorna um bug do io_scene_fbx no Blender 5.x.

    O importador faz `lamp.cycles.cast_shadow = lamp.use_shadow`, mas essa
    propriedade saiu do CyclesLightSettings no 5.x, entao qualquer FBX com
    luz aborta a importacao inteira. Este FBX tem ~20 point lights e nos as
    jogamos fora logo depois, entao basta a leitura nao explodir.
    """
    try:
        from io_scene_fbx import import_fbx
    except ImportError:
        log("aviso: io_scene_fbx nao importavel, seguindo sem o remendo")
        return

    original = import_fbx.blen_read_light

    def tolerante(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except AttributeError:
            # Luz descartada mais adiante; devolvemos um placeholder valido.
            return bpy.data.lights.new(name="fbx_luz_ignorada", type="POINT")

    import_fbx.blen_read_light = tolerante


def importar():
    if not os.path.exists(FBX):
        sys.exit("FBX nao encontrado: %s" % FBX)
    remendar_importador_de_luz()
    log("importando %s (%.1f MB)" % (FBX, os.path.getsize(FBX) / 1e6))
    bpy.ops.import_scene.fbx(
        filepath=FBX,
        global_scale=ESCALA,
        use_image_search=False,   # os caminhos embutidos sao lixo, religamos na mao
        ignore_leaf_bones=True,
        automatic_bone_orientation=True,
    )
    log("importados %d objetos" % len(bpy.data.objects))


def remover(obj):
    bpy.data.objects.remove(obj, do_unlink=True)


def limpar_objetos():
    """Tira colisao UCX, luzes, cameras e empties do Unreal."""
    contagem = {"ucx": 0, "luz": 0, "camera": 0, "lixo": 0}

    for obj in list(bpy.data.objects):
        nome = obj.name

        if nome.upper().startswith("UCX"):
            remover(obj)
            contagem["ucx"] += 1
        elif obj.type == "LIGHT":
            remover(obj)
            contagem["luz"] += 1
        elif obj.type == "CAMERA":
            remover(obj)
            contagem["camera"] += 1
        elif any(nome.startswith(p) for p in LIXO_UNREAL):
            remover(obj)
            contagem["lixo"] += 1

    # Empties que ficaram sem nenhum filho depois da poda acima.
    for obj in list(bpy.data.objects):
        if obj.type == "EMPTY" and not obj.children:
            remover(obj)
            contagem["lixo"] += 1

    log("removidos: %d UCX, %d luzes, %d cameras, %d empties/atores"
        % (contagem["ucx"], contagem["luz"], contagem["camera"], contagem["lixo"]))
    log("restaram %d objetos (%d malhas)"
        % (len(bpy.data.objects),
           sum(1 for o in bpy.data.objects if o.type == "MESH")))


def _no_saida(mat):
    for n in mat.node_tree.nodes:
        if n.type == "OUTPUT_MATERIAL":
            return n
    return mat.node_tree.nodes.new("ShaderNodeOutputMaterial")


def religar_materiais():
    """Reconstroi cada material como um Principled BSDF limpo."""
    faltando = []

    for mat in bpy.data.materials:
        nome = mat.name.split(".")[0]  # Blender sufixa duplicatas com .001

        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        nodes.clear()

        saida = nodes.new("ShaderNodeOutputMaterial")
        saida.location = (400, 0)
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.location = (0, 0)
        links.new(bsdf.outputs["BSDF"], saida.inputs["Surface"])

        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 0.75

        if nome in TEXTURAS:
            caminho = os.path.join(TEXTURAS_DIR, TEXTURAS[nome])
            if not os.path.exists(caminho):
                faltando.append(TEXTURAS[nome])
                continue

            tex = nodes.new("ShaderNodeTexImage")
            tex.location = (-400, 0)
            tex.image = bpy.data.images.load(caminho, check_existing=True)
            tex.image.colorspace_settings.name = "sRGB"
            # Atlas da Synty: cada patch de cor e um bloco chapado. Linear
            # borra as bordas entre patches, entao amostramos no vizinho.
            tex.interpolation = "Closest"
            links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

            if nome in EMISSIVOS:
                links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
                bsdf.inputs["Emission Strength"].default_value = 1.0

        elif nome in SEM_TEXTURA:
            cor, metallic, roughness = SEM_TEXTURA[nome]
            bsdf.inputs["Base Color"].default_value = cor
            bsdf.inputs["Metallic"].default_value = metallic
            bsdf.inputs["Roughness"].default_value = roughness
            if cor[3] < 1.0:
                bsdf.inputs["Alpha"].default_value = cor[3]
                mat.blend_method = "BLEND"

        else:
            log("  aviso: material sem regra, ficou cinza: %s" % nome)

    if faltando:
        sys.exit("texturas nao encontradas em %s: %s"
                 % (TEXTURAS_DIR, ", ".join(faltando)))

    log("religados %d materiais" % len(bpy.data.materials))


# Grupos de topo do FBX que viram nos separados no glTF. Qualquer malha solta
# fora deles cai em "Diversos".
GRUPOS = ("MainOffice", "HomeOffice", "Ceiling", "Roof")
GRUPO_PADRAO = "Diversos"


def _grupo_de(obj):
    """Sobe na hierarquia ate achar o ancestral de topo."""
    no = obj
    while no.parent is not None:
        no = no.parent
    return no.name.split(".")[0] if no.name.split(".")[0] in GRUPOS else GRUPO_PADRAO


def fundir_por_grupo_e_material():
    """Funde as malhas por (grupo de topo, material).

    A cena chega com ~2276 malhas separadas, e cada malha e um draw call no
    three.js -- 2276 draw calls por frame nao fecha o orcamento de 16ms em
    hardware nenhum. Como sao apenas 9 materiais, fundir derruba isso para
    algumas dezenas de draws.

    Fundir *tudo* num bloco so seria ainda mais rapido, mas ai o telhado e o
    forro ficariam soldados ao resto e nao daria mais para olhar dentro do
    predio. Preservando os grupos de topo, o viewer consegue esconder Roof e
    Ceiling e revelar o interior -- que e o conteudo interessante do pacote.
    """
    por_grupo = {}
    for obj in bpy.data.objects:
        if obj.type == "MESH":
            por_grupo.setdefault(_grupo_de(obj), []).append(obj)

    if not por_grupo:
        sys.exit("nenhuma malha para fundir")

    log("fundindo %d malhas em %d grupos (pode demorar)..."
        % (sum(len(v) for v in por_grupo.values()), len(por_grupo)))

    # Soltar TODAS as malhas dos pais de uma vez, e so entao apagar os empties
    # do FBX. Fazer isso por grupo deixava os empties originais vivos, e como
    # eles se chamam MainOffice/Roof/Ceiling/HomeOffice, os grupos novos
    # nasciam como "Roof.001" -- e o getObjectByName("Roof") do viewer achava
    # o empty velho e vazio em vez do grupo real.
    todas = [o for lista in por_grupo.values() for o in lista]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in todas:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = todas[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")

    for obj in list(bpy.data.objects):
        if obj.type == "EMPTY":
            remover(obj)
    bpy.context.view_layer.update()

    total_malhas = 0
    total_tris = 0

    for grupo, malhas in por_grupo.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in malhas:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = malhas[0]

        if len(malhas) > 1:
            bpy.ops.object.join()

        juntada = bpy.context.view_layer.objects.active

        # Uma malha por material dentro do grupo.
        bpy.ops.object.select_all(action="DESELECT")
        juntada.select_set(True)
        bpy.context.view_layer.objects.active = juntada
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")

        pedacos = [o for o in bpy.context.selected_objects if o.type == "MESH"]

        raiz = bpy.data.objects.new(grupo, None)  # empty
        bpy.context.scene.collection.objects.link(raiz)

        for pedaco in pedacos:
            pedaco.data.calc_loop_triangles()
            total_tris += len(pedaco.data.loop_triangles)
            mats = pedaco.data.materials
            sufixo = mats[0].name.split(".")[0] if mats and mats[0] else "sem_material"
            pedaco.name = "%s__%s" % (grupo, sufixo.replace("Mat_PolygonOffice_", ""))

        # parent_set (operador) em vez de atribuir .parent na mao: ele
        # recalcula matrix_parent_inverse e atualiza o depsgraph, entao a
        # posicao no mundo sobrevive ao reparenteamento.
        bpy.ops.object.select_all(action="DESELECT")
        for pedaco in pedacos:
            pedaco.select_set(True)
        raiz.select_set(True)
        bpy.context.view_layer.objects.active = raiz
        bpy.ops.object.parent_set(type="OBJECT", keep_transform=True)

        total_malhas += len(pedacos)
        log("  %-12s -> %d malhas" % (grupo, len(pedacos)))

    bpy.context.view_layer.update()
    log("resultado: %d malhas, %s triangulos"
        % (total_malhas, format(total_tris, ",d")))


def centralizar_e_medir():
    """Assenta a cena na origem (chao em y=0) e devolve as dimensoes."""
    malhas = [o for o in bpy.data.objects if o.type == "MESH"]
    if not malhas:
        sys.exit("nenhuma malha sobrou depois da limpeza")

    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for obj in malhas:
        for canto in obj.bound_box:
            p = obj.matrix_world @ Vector(canto)
            lo = Vector((min(lo[i], p[i]) for i in range(3)))
            hi = Vector((max(hi[i], p[i]) for i in range(3)))

    centro = (lo + hi) / 2.0
    # Em Blender Z e pra cima; deslocamos XY pro centro e Z pro piso.
    desloca = Vector((-centro.x, -centro.y, -lo.z))

    for obj in bpy.data.objects:
        if obj.parent is None:
            obj.location = obj.location + desloca

    tam = hi - lo
    log("bounding box: %.1f x %.1f x %.1f metros" % (tam.x, tam.y, tam.z))
    return tam, desloca


def exportar():
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)

    opcoes = dict(
        filepath=SAIDA,
        export_format="GLB",
        export_yup=True,
        export_apply=True,          # aplica modificadores
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
    )

    try:
        bpy.ops.export_scene.gltf(**opcoes)
    except TypeError:
        # Blender antigo nao conhece alguma flag; tenta sem as de Draco.
        log("aviso: flags de Draco recusadas, exportando sem compressao")
        for k in ("export_draco_mesh_compression_enable",
                  "export_draco_mesh_compression_level"):
            opcoes.pop(k, None)
        bpy.ops.export_scene.gltf(**opcoes)

    log("gravado %s (%.1f MB)" % (SAIDA, os.path.getsize(SAIDA) / 1e6))


# Assentos que o jogador pode usar. Vaso sanitario tambem casa com "Seat" no
# nome do pacote, e fica de fora de proposito.
PADRAO_ASSENTO = re.compile(r"(couch|benchseat|outdoor_seat)", re.I)

SAIDA_ASSENTOS = os.path.join(RAIZ, "public", "models", "assentos.json")


def _obb(obj):
    """Caixa do objeto no espaco LOCAL dele, e os eixos desse espaco no mundo."""
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for v in obj.data.vertices:
        lo = Vector((min(lo[i], v.co[i]) for i in range(3)))
        hi = Vector((max(hi[i], v.co[i]) for i in range(3)))
    return lo, hi


def coletar_assentos():
    """Grava onde ficam os sofas, para o jogo saber onde dá para sentar.

    Precisa rodar ANTES da fusao: depois que as malhas viram um bloco por
    material, nao existe mais "um sofa" para consultar -- some o nome e some a
    transformacao individual.

    O lado que o assento encara sai da geometria, nao de um palpite: dividimos
    a caixa do objeto ao meio no eixo mais curto (a profundidade) e medimos a
    altura media dos vertices de cada metade. A metade mais alta e o encosto,
    entao a frente e o lado oposto. Isso vale para sofa, banco e poltrona sem
    tabela de excecoes.
    """
    assentos = []

    for obj in bpy.data.objects:
        if obj.type != "MESH" or not PADRAO_ASSENTO.search(obj.name):
            continue

        lo, hi = _obb(obj)
        tamanho = hi - lo

        # Dos dois eixos horizontais locais, o mais curto e a profundidade.
        eixo_prof = 0 if tamanho.x < tamanho.y else 1
        eixo_larg = 1 - eixo_prof

        meio = (lo[eixo_prof] + hi[eixo_prof]) / 2
        soma = [0.0, 0.0]
        conta = [0, 0]
        for v in obj.data.vertices:
            lado = 0 if v.co[eixo_prof] < meio else 1
            soma[lado] += v.co.z
            conta[lado] += 1

        alto = 0 if (conta[0] and soma[0] / conta[0]) > (conta[1] and soma[1] / conta[1]) else 1
        # A frente aponta para longe do encosto.
        sinal = 1.0 if alto == 0 else -1.0

        frente_local = Vector((0, 0, 0))
        frente_local[eixo_prof] = sinal
        frente = (obj.matrix_world.to_3x3() @ frente_local)
        frente.z = 0
        if frente.length < 1e-6:
            continue
        frente.normalize()

        centro_local = (lo + hi) / 2
        centro_local.z = lo.z  # nivel do chao sob o assento
        centro = obj.matrix_world @ centro_local

        # Converte para o eixo do glTF (Y para cima): Blender (x, y, z) vira
        # (x, z, -y), e o mesmo vale para a direcao.
        assentos.append({
            "nome": obj.name,
            "posicao": [round(centro.x, 3), round(centro.z, 3), round(-centro.y, 3)],
            "frente": [round(frente.x, 3), 0.0, round(-frente.y, 3)],
            "largura": round(tamanho[eixo_larg] * abs(obj.matrix_world.to_scale()[eixo_larg]), 2),
        })

    return assentos


def gravar_assentos(assentos, desloca):
    """Grava o JSON já no sistema de coordenadas final do .glb.

    Os assentos são lidos antes da fusão, mas `centralizar_e_medir` move a cena
    inteira depois disso. Sem somar esse deslocamento aqui, cada sofá do JSON
    ficaria alguns metros fora do sofá que aparece na tela -- e o erro seria
    silencioso, porque as duas coisas parecem plausíveis isoladamente.
    """
    # desloca vem em coordenadas do Blender (Z para cima); o JSON está em glTF.
    dx, dy, dz = desloca.x, desloca.z, -desloca.y

    for assento in assentos:
        p = assento["posicao"]
        assento["posicao"] = [
            round(p[0] + dx, 3), round(p[1] + dy, 3), round(p[2] + dz, 3),
        ]

    os.makedirs(os.path.dirname(SAIDA_ASSENTOS), exist_ok=True)
    with open(SAIDA_ASSENTOS, "w") as arquivo:
        json.dump(assentos, arquivo, indent=1, ensure_ascii=False)

    log("gravados %d assentos em %s"
        % (len(assentos), os.path.basename(SAIDA_ASSENTOS)))


def main():
    limpar_cena()
    importar()
    limpar_objetos()
    assentos = coletar_assentos()
    religar_materiais()
    fundir_por_grupo_e_material()
    _, desloca = centralizar_e_medir()
    gravar_assentos(assentos, desloca)
    exportar()
    log("pronto")


if __name__ == "__main__":
    main()
