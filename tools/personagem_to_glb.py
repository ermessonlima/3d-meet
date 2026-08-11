"""
Converte um personagem da Synty para public/models/personagem.glb, criando as
animacoes que o pacote nao traz.

    blender --background --factory-startup --python tools/personagem_to_glb.py

Os SK_Chr_*.fbx vem riggados (esqueleto UE4 de 55 ossos) mas com ZERO actions --
a Synty espera que voce traga as animacoes de fora (Mixamo, mannequin da Epic).
Como aqui nao ha de onde importar, este script autora tres clipes na mao:
Parado, Andar e Pular.

Duas armadilhas que moldaram o codigo:

  1. O FBX esta em T-pose, com os bracos na horizontal. Qualquer animacao
     precisa primeiro DESCER os bracos; sem isso o personagem anda igual a um
     epouvantail.

  2. Nao da para chutar em torno de qual eixo local girar cada osso: a
     orientacao depende de como o FBX foi exportado. Em vez de hardcodar,
     convertemos um eixo conhecido do espaco do armature para o espaco local
     do osso (`_eixo_local`) e AFERIMOS o sinal medindo o deslocamento real do
     osso no mundo (`_calibrar_sinal`). Assim o script continua correto se
     alguem trocar o personagem por outro do pacote.
"""

import os
import sys
import math

import bpy
from mathutils import Vector, Quaternion

# ---------------------------------------------------------------- caminhos

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJETO = os.path.dirname(RAIZ)

TEXTURA = os.path.join(
    PROJETO, "SourceFiles", "Textures", "PolygonOffice_Texture_01_A.png"
)


def _argumentos():
    """Le os argumentos passados depois de `--` na linha do Blender.

        blender -b -P tools/personagem_to_glb.py -- --personagem NOME --saida X

    Sem argumentos, gera o personagem jogavel. Qualquer SK_Chr_* da pasta
    Characters serve: os sinais de rotacao sao aferidos do proprio rig, entao
    os clipes saem corretos sem ajuste manual.
    """
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    nome, saida = "SK_Chr_Business_Male_01", "personagem.glb"
    for i, a in enumerate(argv):
        if a == "--personagem" and i + 1 < len(argv):
            nome = argv[i + 1]
        elif a == "--saida" and i + 1 < len(argv):
            saida = argv[i + 1]
    return nome, saida


PERSONAGEM, _SAIDA_NOME = _argumentos()
FBX = os.path.join(PROJETO, "SourceFiles", "Characters", "%s.fbx" % PERSONAGEM)
SAIDA = os.path.join(RAIZ, "public", "models", _SAIDA_NOME)

FPS = 24

# Eixos no espaco do armature, medidos do proprio rig em _medir_eixos().
LATERAL = Vector((1, 0, 0))   # do quadril direito para o esquerdo
CIMA = Vector((0, 1, 0))      # o armature vem rotacionado 90 graus em X
FRENTE = Vector((0, 0, 1))    # LATERAL x CIMA


def log(msg):
    print("[personagem] %s" % msg, flush=True)


# ------------------------------------------------------------- importacao


def remendar_importador_de_luz():
    """Mesmo remendo de fbx_to_glb.py: o io_scene_fbx do Blender 5.x quebra
    ao ler luzes. O FBX do personagem nao tem nenhuma, mas o custo e zero e
    evita uma surpresa se alguem apontar isto para outro arquivo."""
    try:
        from io_scene_fbx import import_fbx
    except ImportError:
        return
    original = import_fbx.blen_read_light

    def tolerante(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except AttributeError:
            return bpy.data.lights.new(name="luz_ignorada", type="POINT")

    import_fbx.blen_read_light = tolerante


def importar():
    if not os.path.exists(FBX):
        sys.exit("FBX do personagem nao encontrado: %s" % FBX)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    remendar_importador_de_luz()
    bpy.ops.import_scene.fbx(
        filepath=FBX,
        use_image_search=False,
        automatic_bone_orientation=True,
        ignore_leaf_bones=True,
    )

    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    malhas = [o for o in bpy.data.objects if o.type == "MESH"]
    if not arms or not malhas:
        sys.exit("import sem armature ou sem malha")
    log("importado %s (%d ossos)" % (PERSONAGEM, len(arms[0].data.bones)))
    return arms[0], malhas[0]


def religar_material(malha):
    """O material aponta para um .psd inexistente; usamos o mesmo atlas PNG
    do cenario (os personagens compartilham a textura 01_A)."""
    if not os.path.exists(TEXTURA):
        sys.exit("textura nao encontrada: %s" % TEXTURA)

    for mat in malha.data.materials:
        if not mat:
            continue
        mat.use_nodes = True
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        nodes.clear()

        saida = nodes.new("ShaderNodeOutputMaterial")
        saida.location = (400, 0)
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.location = (0, 0)
        bsdf.inputs["Metallic"].default_value = 0.0
        bsdf.inputs["Roughness"].default_value = 0.8
        links.new(bsdf.outputs["BSDF"], saida.inputs["Surface"])

        tex = nodes.new("ShaderNodeTexImage")
        tex.location = (-400, 0)
        tex.image = bpy.data.images.load(TEXTURA, check_existing=True)
        tex.image.colorspace_settings.name = "sRGB"
        tex.interpolation = "Closest"  # atlas de cores chapadas, ver README
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    log("material religado em %s" % os.path.basename(TEXTURA))


# --------------------------------------------------------- eixos e sinais


def _eixo_local(pb, eixo_armature):
    """Converte um eixo do espaco do armature para o espaco local do osso."""
    v = pb.bone.matrix_local.to_3x3().inverted() @ eixo_armature
    return v.normalized()


def _pos_mundo(arm, nome):
    return arm.matrix_world @ arm.pose.bones[nome].head


def _limpar_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    bpy.context.view_layer.update()


def _calibrar_sinal(arm, osso, ponta, eixo_armature, direcao_mundo):
    """Descobre o sinal do giro medindo para onde a ponta do membro anda.

    Devolve +1 se um angulo positivo em torno de `eixo_armature` move `ponta`
    no sentido de `direcao_mundo`, e -1 caso contrario. Isso evita depender da
    convencao de orientacao de osso do exportador do FBX.
    """
    _limpar_pose(arm)
    antes = _pos_mundo(arm, ponta)

    pb = arm.pose.bones[osso]
    pb.rotation_quaternion = Quaternion(_eixo_local(pb, eixo_armature), math.radians(20))
    bpy.context.view_layer.update()
    depois = _pos_mundo(arm, ponta)

    _limpar_pose(arm)
    return 1.0 if (depois - antes).dot(direcao_mundo) > 0 else -1.0


def _medir_eixos(arm):
    """Le do proprio rig os eixos e a direcao para onde o personagem olha."""
    global LATERAL, CIMA, FRENTE
    ossos = arm.data.bones
    LATERAL = (ossos["Thigh_L"].head_local - ossos["Thigh_R"].head_local).normalized()
    CIMA = (ossos["head"].head_local - ossos["Pelvis"].head_local).normalized()
    # Ortogonaliza: o vetor quadril->cabeca nao e exatamente vertical.
    CIMA = (CIMA - LATERAL * CIMA.dot(LATERAL)).normalized()
    FRENTE = LATERAL.cross(CIMA).normalized()

    # LATERAL x CIMA pode dar para frente ou para tras; o osso dos olhos
    # resolve a ambiguidade, porque ele fica deslocado na direcao do rosto.
    olhos = ossos.get("eyes")
    if olhos is not None:
        rosto = olhos.head_local - ossos["head"].head_local
        if rosto.dot(FRENTE) < 0:
            FRENTE = -FRENTE

    log("eixos do rig: lateral=%s cima=%s frente=%s"
        % (tuple(round(v, 2) for v in LATERAL),
           tuple(round(v, 2) for v in CIMA),
           tuple(round(v, 2) for v in FRENTE)))


def orientar_para_z_positivo(arm):
    """Gira o personagem para ele olhar no +Z do glTF.

    O exportador manda Blender -Y para glTF +Z. Deixar o rosto ali significa
    que, no three.js, basta apontar a rotacao Y para a direcao de caminhada
    sem nenhum offset magico espalhado pelo controlador.
    """
    frente_mundo = (arm.matrix_world.to_3x3() @ FRENTE)
    frente_mundo.z = 0
    frente_mundo.normalize()

    alvo = Vector((0, -1, 0))  # Blender -Y  ->  glTF +Z
    angulo = math.atan2(
        frente_mundo.x * alvo.y - frente_mundo.y * alvo.x,
        frente_mundo.x * alvo.x + frente_mundo.y * alvo.y,
    )
    arm.rotation_euler.z -= angulo
    bpy.context.view_layer.update()
    log("rosto girado %.0f graus para olhar no +Z do glTF" % math.degrees(-angulo))


# ------------------------------------------------------------ pose e clipes

# Ossos que TODO clipe precisa keyframar. Se um clipe omitir um osso, o
# three.js mantem o valor deixado pelo clipe anterior e a transicao suja a
# pose (braco que fica pra tras depois de um pulo, por exemplo).
OSSOS = [
    "Pelvis", "spine_01", "spine_02", "spine_03", "head",
    "clavicle_l", "UpperArm_L", "lowerarm_l",
    "clavicle_r", "UpperArm_R", "lowerarm_r",
    "Thigh_L", "calf_l", "Foot_L",
    "Thigh_R", "calf_r", "Foot_R",
]


class Rig:
    """Guarda os sinais aferidos e monta quaternions em termos humanos."""

    def __init__(self, arm):
        self.arm = arm
        # Perna: angulo positivo deve levar o pe para FRENTE.
        frente_mundo = (arm.matrix_world.to_3x3() @ FRENTE).normalized()
        cima_mundo = (arm.matrix_world.to_3x3() @ CIMA).normalized()
        self.s_perna = _calibrar_sinal(arm, "Thigh_L", "Foot_L", LATERAL, frente_mundo)
        self.s_braco = _calibrar_sinal(arm, "UpperArm_L", "Hand_L", LATERAL, frente_mundo)
        # Braco abaixando: angulo positivo em torno de FRENTE deve DESCER a mao.
        self.s_desce_l = _calibrar_sinal(arm, "UpperArm_L", "Hand_L", FRENTE, -cima_mundo)
        self.s_desce_r = _calibrar_sinal(arm, "UpperArm_R", "Hand_R", FRENTE, -cima_mundo)
        # Quanto vale 1 unidade de translacao do Pelvis, em metros.
        self.escala_loc = self._medir_escala_loc()
        log("sinais aferidos: perna=%+d braco=%+d desce_l=%+d desce_r=%+d  loc=%.1f u/m"
            % (self.s_perna, self.s_braco, self.s_desce_l, self.s_desce_r,
               self.escala_loc))

    def _medir_escala_loc(self):
        _limpar_pose(self.arm)
        antes = _pos_mundo(self.arm, "Pelvis")
        pb = self.arm.pose.bones["Pelvis"]
        pb.location = _eixo_local(pb, CIMA) * 1.0
        bpy.context.view_layer.update()
        d = (_pos_mundo(self.arm, "Pelvis") - antes).length
        _limpar_pose(self.arm)
        return 1.0 / d if d > 1e-9 else 100.0

    def giro(self, osso, eixo, graus):
        pb = self.arm.pose.bones[osso]
        return Quaternion(_eixo_local(pb, eixo), math.radians(graus))

    def balanco(self, osso, graus):
        """Giro no plano sagital: positivo = para frente."""
        return self.giro(osso, LATERAL, graus * self.s_perna)

    def balanco_braco(self, osso, graus):
        return self.giro(osso, LATERAL, graus * self.s_braco)


def pose_base(rig):
    """Tira o personagem da T-pose: bracos para baixo, cotovelos de leve.

    Sem isto qualquer clipe fica com os bracos abertos na horizontal.
    """
    return {
        "UpperArm_L": rig.giro("UpperArm_L", FRENTE, 72 * rig.s_desce_l),
        "UpperArm_R": rig.giro("UpperArm_R", FRENTE, 72 * rig.s_desce_r),
        "lowerarm_l": rig.giro("lowerarm_l", FRENTE, 12 * rig.s_desce_l),
        "lowerarm_r": rig.giro("lowerarm_r", FRENTE, 12 * rig.s_desce_r),
    }


def _mesclar(base, extra):
    """Aplica `extra` DEPOIS de `base`, no espaco do armature.

    A ordem importa e nao e a intuitiva. A rotacao de pose de um osso vale
    `L @ q`, onde L e a matriz de repouso; para acrescentar uma rotacao A no
    espaco do armature em cima de uma base B, sai `q = (L-1 A L) @ B` -- ou
    seja, `extra @ base`, com o eixo de `extra` ja convertido por _eixo_local.

    Com a ordem trocada (`base @ extra`) as pernas ainda funcionam, porque a
    base delas e identidade, mas os bracos nao: em T-pose o braco aponta na
    direcao do eixo lateral, entao girar em torno dele antes de baixar o braco
    e uma TORCAO no proprio eixo do osso, e o balanco simplesmente some.
    """
    saida = dict(base)
    for osso, q in extra.items():
        saida[osso] = q @ saida[osso] if osso in saida else q
    return saida


def clipe_parado(rig, t):
    """Respiracao sutil, ~3 s de ciclo."""
    fase = 2 * math.pi * t
    respira = math.sin(fase)
    pose = _mesclar(pose_base(rig), {
        "spine_01": rig.balanco("spine_01", -1.2 * respira),
        "spine_03": rig.balanco("spine_03", 1.8 * respira),
        "UpperArm_L": rig.giro("UpperArm_L", FRENTE, 2.0 * respira * rig.s_desce_l),
        "UpperArm_R": rig.giro("UpperArm_R", FRENTE, 2.0 * respira * rig.s_desce_r),
        "head": rig.balanco("head", -0.8 * respira),
    })
    loc = {"Pelvis": CIMA * (0.006 * respira)}
    return pose, loc


def clipe_andar(rig, t):
    """Ciclo de caminhada de 1 s: contato, passagem, contato, passagem."""
    fase = 2 * math.pi * t

    def perna(desloc):
        """desloc=0 para a esquerda, pi para a direita."""
        coxa = 26.0 * math.sin(fase + desloc)
        # O joelho dobra no recuo (t=0.75 do proprio lado), nunca para frente.
        joelho = 8.0 + 34.0 * (1 - math.cos(2 * math.pi * ((t + desloc / (2 * math.pi)) - 0.75))) / 2
        return coxa, joelho

    coxa_l, joelho_l = perna(0.0)
    coxa_r, joelho_r = perna(math.pi)

    # Bracos contrabalancam a perna do mesmo lado.
    braco_l = -22.0 * math.sin(fase)
    braco_r = -22.0 * math.sin(fase + math.pi)

    pose = _mesclar(pose_base(rig), {
        "Thigh_L": rig.balanco("Thigh_L", coxa_l),
        "calf_l": rig.balanco("calf_l", -joelho_l),
        "Foot_L": rig.balanco("Foot_L", 0.35 * (joelho_l - coxa_l)),
        "Thigh_R": rig.balanco("Thigh_R", coxa_r),
        "calf_r": rig.balanco("calf_r", -joelho_r),
        "Foot_R": rig.balanco("Foot_R", 0.35 * (joelho_r - coxa_r)),
        "UpperArm_L": rig.balanco_braco("UpperArm_L", braco_l),
        # Cotovelo sempre POSITIVO: negativo dobraria para tras, hiperestendendo
        # o braco. Dobra um pouco mais quando aquele braco vai para frente.
        "lowerarm_l": rig.balanco_braco("lowerarm_l", 18 - 8 * math.sin(fase)),
        "UpperArm_R": rig.balanco_braco("UpperArm_R", braco_r),
        "lowerarm_r": rig.balanco_braco("lowerarm_r", 18 - 8 * math.sin(fase + math.pi)),
        # Tronco contra-gira em relacao a pelve, e o corpo inclina de leve.
        "spine_01": rig.giro("spine_01", CIMA, -4.0 * math.sin(fase)),
        "spine_02": rig.balanco("spine_02", 3.0),
        "head": rig.giro("head", CIMA, 3.0 * math.sin(fase)),
    })
    # Sobe e desce duas vezes por ciclo (uma por passo).
    loc = {"Pelvis": CIMA * (-0.022 * math.cos(2 * fase))}
    return pose, loc


# Marcos do pulo, em fracao do clipe: (t, coxa, joelho, braco, altura_pelve)
#
# Dois numeros aqui sao contraintuitivos:
#
#   `braco` parte do braco ja abaixado, entao 90 graus e a HORIZONTAL, nao o
#   alto. Para o impulso ler como arremesso para cima e preciso passar de 140;
#   com 95 a pose sai apontando para frente, tipo zumbi.
#
#   `altura_pelve` e comedida de proposito. Nesta hierarquia o pe e neto da
#   pelve (Pelvis -> Thigh -> calf -> Foot), entao baixar a pelve leva o pe
#   junto e afunda no chao -- nao existe IK aqui para plantar o pe. O
#   agachamento vem principalmente da dobra do joelho; a pelve so acompanha.
_PULO = [
    (0.00, 0, 8, 0, 0.00),        # neutro
    (0.15, 42, 80, -50, -0.12),   # agacha, bracos para tras
    (0.30, -10, 5, 145, 0.05),    # impulso: pernas estendidas, bracos para cima
    (0.55, 32, 68, 120, 0.02),    # apice, pernas recolhidas
    (0.78, 8, 15, 45, 0.00),      # estende para aterrissar
    (0.90, 38, 74, -20, -0.10),   # absorve o impacto
    (1.00, 0, 8, 0, 0.00),        # volta ao neutro
]


def clipe_pular(rig, t):
    for i in range(len(_PULO) - 1):
        t0, *a = _PULO[i]
        t1, *b = _PULO[i + 1]
        if t <= t1 or i == len(_PULO) - 2:
            k = 0.0 if t1 == t0 else max(0.0, min(1.0, (t - t0) / (t1 - t0)))
            k = k * k * (3 - 2 * k)  # suaviza as bordas
            coxa, joelho, braco, altura = [a[j] + (b[j] - a[j]) * k for j in range(4)]
            break

    pose = _mesclar(pose_base(rig), {
        "Thigh_L": rig.balanco("Thigh_L", coxa),
        "calf_l": rig.balanco("calf_l", -joelho),
        "Foot_L": rig.balanco("Foot_L", 0.4 * (joelho - coxa)),
        "Thigh_R": rig.balanco("Thigh_R", coxa),
        "calf_r": rig.balanco("calf_r", -joelho),
        "Foot_R": rig.balanco("Foot_R", 0.4 * (joelho - coxa)),
        "UpperArm_L": rig.balanco_braco("UpperArm_L", braco),
        "UpperArm_R": rig.balanco_braco("UpperArm_R", braco),
        "lowerarm_l": rig.balanco_braco("lowerarm_l", 22),
        "lowerarm_r": rig.balanco_braco("lowerarm_r", 22),
        "spine_02": rig.balanco("spine_02", coxa * 0.28),
    })
    loc = {"Pelvis": CIMA * altura}
    return pose, loc


# ------------------------------------------------------------- keyframing


def _nova_action(arm, nome):
    ad = arm.animation_data or arm.animation_data_create()
    act = bpy.data.actions.new(nome)
    ad.action = act
    # Blender 4.4+ exige um slot para as fcurves terem onde morar.
    if hasattr(ad, "action_slot") and ad.action_slot is None:
        ad.action_slot = act.slots.new(id_type="OBJECT", name=arm.name)
    return act


def gravar_clipe(rig, nome, funcao, duracao_s, passo=2):
    arm = rig.arm
    act = _nova_action(arm, nome)
    total = max(1, int(round(duracao_s * FPS)))

    for f in range(1, total + 2, passo):
        t = ((f - 1) % total) / total
        pose, loc = funcao(rig, t)
        _limpar_pose(arm)

        for osso in OSSOS:
            pb = arm.pose.bones[osso]
            pb.rotation_quaternion = pose.get(osso, Quaternion())
            if osso in loc:
                pb.location = _eixo_local(pb, CIMA) * (loc[osso].length * rig.escala_loc
                                                       * (1 if loc[osso].dot(CIMA) >= 0 else -1))
            pb.keyframe_insert(data_path="rotation_quaternion", frame=f)
            pb.keyframe_insert(data_path="location", frame=f)

    # Amostramos a curva densamente, entao a interpolacao pode ser linear --
    # bezier faria overshoot entre amostras e estouraria os limites do joelho.
    for camada in act.layers:
        for strip in camada.strips:
            for cb in strip.channelbags:
                for fc in cb.fcurves:
                    for kp in fc.keyframe_points:
                        kp.interpolation = "LINEAR"

    log("clipe '%s': %d frames (%.2fs)" % (nome, total, duracao_s))
    return act


# ---------------------------------------------------------------- exportar


def exportar():
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.export_scene.gltf(
        filepath=SAIDA,
        export_format="GLB",
        export_yup=True,
        export_apply=False,      # nao aplicar modificadores: quebraria o skin
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_bake_animation=True,
        export_cameras=False,
        export_lights=False,
    )
    log("gravado %s (%.2f MB)" % (SAIDA, os.path.getsize(SAIDA) / 1e6))


def main():
    arm, malha = importar()
    religar_material(malha)
    _medir_eixos(arm)
    orientar_para_z_positivo(arm)

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")

    rig = Rig(arm)
    gravar_clipe(rig, "Parado", clipe_parado, 3.0)
    gravar_clipe(rig, "Andar", clipe_andar, 1.0)
    gravar_clipe(rig, "Pular", clipe_pular, 0.85)

    _limpar_pose(arm)
    exportar()
    log("pronto")


if __name__ == "__main__":
    main()
