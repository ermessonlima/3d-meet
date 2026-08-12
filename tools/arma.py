"""
Converte a arma de brinquedo do pacote para public/models/arma.glb.

    blender --background --factory-startup --python tools/arma.py

O POLYGON Office traz quatro SM_Wep_ToyGun_* -- armas de brinquedo, no espírito
do escritório. Usamos o rifle: é a silhueta que mais lê à distância de terceira
pessoa, onde a arma aparece pequena na mão.

A malha é levada para a ORIGEM e alinhada: no FBX ela vem posicionada onde
estava na cena, e uma arma que nasce a 12 metros do personagem não gruda na mão
de jeito nenhum. Aqui ela sai com o punho na origem e o cano apontando para +Z
(a mesma frente do personagem), que é o que o código de mira assume.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJETO = os.path.dirname(RAIZ)

FBX = os.path.join(PROJETO, "SourceFiles", "FBX", "SM_Wep_ToyGun_Rifle_01.fbx")
TEXTURA = os.path.join(
    PROJETO, "SourceFiles", "Textures", "PolygonOffice_Texture_01_A.png"
)
SAIDA = os.path.join(RAIZ, "public", "models", "arma.glb")


def log(msg):
    print("[arma] %s" % msg, flush=True)


def main():
    if not os.path.exists(FBX):
        sys.exit("FBX da arma nao encontrado: %s" % FBX)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=FBX, use_image_search=False)

    malhas = [o for o in bpy.data.objects if o.type == "MESH"]
    if not malhas:
        sys.exit("import sem malha")

    # Junta tudo numa peça só.
    bpy.ops.object.select_all(action="DESELECT")
    for o in malhas:
        o.select_set(True)
    bpy.context.view_layer.objects.active = malhas[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    if len(malhas) > 1:
        bpy.ops.object.join()
    arma = bpy.context.view_layer.objects.active
    arma.name = "Arma"

    # Congela a transformação e centra a geometria na origem.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    arma.location = (0, 0, 0)
    bpy.context.view_layer.update()

    dim = arma.dimensions
    log("dimensões brutas: %.3f x %.3f x %.3f m" % (dim.x, dim.y, dim.z))

    # O eixo mais longo é o cano. Gira para ele ficar em -Y do Blender, que o
    # exportador manda para +Z do glTF -- a frente do personagem.
    eixo = max(range(3), key=lambda i: dim[i])
    if eixo == 0:
        arma.rotation_euler.z = math.radians(90)
    elif eixo == 2:
        arma.rotation_euler.x = math.radians(90)
    bpy.ops.object.transform_apply(rotation=True)

    # Material com o mesmo atlas do resto.
    mat = bpy.data.materials.new("Arma")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    saida = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.55
    links.new(bsdf.outputs["BSDF"], saida.inputs["Surface"])
    if os.path.exists(TEXTURA):
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(TEXTURA, check_existing=True)
        tex.image.colorspace_settings.name = "sRGB"
        tex.interpolation = "Closest"
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    arma.data.materials.clear()
    arma.data.materials.append(mat)

    d = arma.dimensions
    log("alinhada: %.3f x %.3f x %.3f m (cano no eixo Y)" % (d.x, d.y, d.z))

    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=SAIDA, export_format="GLB", export_yup=True,
        export_animations=False, export_cameras=False, export_lights=False,
    )
    log("gravado %s (%.0f KB)" % (SAIDA, os.path.getsize(SAIDA) / 1024))


if __name__ == "__main__":
    main()
