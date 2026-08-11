import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Monta renderer, camera, controles e luzes.
 *
 * A cena original vinha com ~20 point lights do Unreal. Elas foram descartadas
 * na conversao: point lights com sombra sao caras em WebGL e o resultado fica
 * melhor com um key light direcional + preenchimento hemisferico + um
 * environment map para os materiais metalicos (cromo) terem o que refletir.
 */
export function criarPalco(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121820);
  scene.fog = new THREE.Fog(0x121820, 90, 220);

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    600,
  );

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.screenSpacePanning = false;
  controls.minDistance = 2;
  controls.maxDistance = 220;
  // Trava um pouco acima do horizonte para nao entrar embaixo do piso.
  controls.maxPolarAngle = Math.PI * 0.495;

  // Reflexos para cromo e vidro, sem precisar carregar um HDR externo.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const hemisferio = new THREE.HemisphereLight(0xbcd3ff, 0x3a3a44, 0.9);
  scene.add(hemisferio);

  const sol = new THREE.DirectionalLight(0xfff3e0, 2.4);
  sol.position.set(48, 70, 32);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  sol.shadow.bias = -0.0006;
  sol.shadow.normalBias = 0.04;
  scene.add(sol);
  scene.add(sol.target);

  const preenchimento = new THREE.DirectionalLight(0x9fbcff, 0.55);
  preenchimento.position.set(-40, 28, -36);
  scene.add(preenchimento);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, controls, sol, hemisferio };
}

/**
 * Ajusta camera, controles e sombra ao tamanho real do modelo, para o
 * enquadramento nao depender de numeros chutados.
 */
export function enquadrar({ camera, controls, sol }, objeto) {
  const caixa = new THREE.Box3().setFromObject(objeto);
  const tamanho = caixa.getSize(new THREE.Vector3());
  const centro = caixa.getCenter(new THREE.Vector3());
  const raio = tamanho.length() / 2;

  controls.target.copy(centro);
  camera.position.set(
    centro.x + raio * 0.85,
    centro.y + raio * 0.55,
    centro.z + raio * 0.85,
  );
  camera.near = raio / 120;
  camera.far = raio * 12;
  camera.updateProjectionMatrix();
  controls.maxDistance = raio * 4;
  controls.update();

  // A sombra direcional precisa cobrir a cena inteira, senao some nas bordas.
  const c = sol.shadow.camera;
  c.left = -raio;
  c.right = raio;
  c.top = raio;
  c.bottom = -raio;
  c.near = 0.5;
  c.far = raio * 6;
  sol.position.copy(centro).add(new THREE.Vector3(raio, raio * 1.4, raio * 0.7));
  sol.target.position.copy(centro);
  sol.target.updateMatrixWorld();
  c.updateProjectionMatrix();

  return { centro, tamanho, raio };
}
