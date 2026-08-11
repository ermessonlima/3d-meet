"""
Renderiza os retratos dos personagens usados na tela de selecao.

    blender --background --factory-startup --python tools/retratos.py

Gera public/retratos/<Nome>.png com fundo transparente. Retratos prontos
custam alguns KB e evitam um segundo renderer WebGL so para a vitrine do
lobby -- que teria que carregar os 16 MB de modelos antes de o jogador
escolher qualquer coisa.

Reaproveita as funcoes de personagem_to_glb.py para o personagem aparecer com
os bracos ja abaixados; em T-pose o retrato ficaria com os ombros cortados.
"""

import os
import sys

import bpy
from mathutils import Vector

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)

# Importa o outro script como modulo, sem executar o main() dele.
_fonte = open(os.path.join(AQUI, "personagem_to_glb.py")).read().split("def main()")[0]
exec(_fonte)

SAIDA_DIR = os.path.join(RAIZ, "public", "retratos")

PERSONAGENS = [
    "Business_Male_01",
    "Business_Female_01",
    "Developer_Male_01",
    "Developer_Female_01",
    "Boss_Male_01",
    "Security_Female_01",
]


def preparar_cena():
    cena = bpy.context.scene
    cena.render.engine = "BLENDER_WORKBENCH"
    cena.render.resolution_x = 300
    cena.render.resolution_y = 380
    cena.render.film_transparent = True
    cena.render.image_settings.file_format = "PNG"
    cena.render.image_settings.color_mode = "RGBA"
    cena.display.shading.light = "STUDIO"
    cena.display.shading.color_type = "TEXTURE"
    cena.display.shading.show_object_outline = False
    return cena


def montar_camera(cena, alvo):
    dados = bpy.data.cameras.new("retrato")
    dados.type = "ORTHO"
    dados.ortho_scale = 0.95  # enquadra cabeca e ombros

    cam = bpy.data.objects.new("retrato", dados)
    cena.collection.objects.link(cam)

    # O personagem foi girado para olhar no -Y do Blender, entao a camera fica
    # do lado negativo de Y para pegar o rosto de frente.
    cam.location = Vector((0.55, -2.6, alvo.z + 0.12))
    direcao = alvo - cam.location
    cam.rotation_euler = direcao.to_track_quat("-Z", "Y").to_euler()
    cena.camera = cam


def renderizar(nome):
    global FBX
    FBX = os.path.join(
        os.path.dirname(RAIZ), "SourceFiles", "Characters", "SK_Chr_%s.fbx" % nome
    )
    if not os.path.exists(FBX):
        log("pulando %s: FBX ausente" % nome)
        return

    arm, malha = importar()
    religar_material(malha)
    _medir_eixos(arm)
    orientar_para_z_positivo(arm)

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    rig = Rig(arm)
    for osso, q in pose_base(rig).items():
        arm.pose.bones[osso].rotation_quaternion = q
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

    cena = preparar_cena()
    cabeca = arm.matrix_world @ arm.pose.bones["head"].head
    montar_camera(cena, cabeca)

    destino = os.path.join(SAIDA_DIR, "%s.png" % nome)
    cena.render.filepath = destino
    bpy.ops.render.render(write_still=True)
    log("retrato %s" % os.path.basename(destino))


def main():
    os.makedirs(SAIDA_DIR, exist_ok=True)
    for nome in PERSONAGENS:
        renderizar(nome)
    log("pronto: %d retratos" % len(PERSONAGENS))


if __name__ == "__main__":
    main()
