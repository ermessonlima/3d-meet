import { defineConfig, loadEnv } from "vite";
import { pluginDeChat } from "./tools/chat-proxy.js";
import { pluginMultiplayer } from "./tools/multiplayer.js";

export default defineConfig(({ mode }) => ({
  // loadEnv com prefixo "" le TODAS as variaveis do .env, inclusive as sem
  // VITE_. E de proposito: variaveis com VITE_ sao injetadas no bundle do
  // navegador, e a chave da OpenAI nao pode ir para la de jeito nenhum. Esta
  // aqui ela fica no processo do Vite e so o middleware a enxerga.
  plugins: [pluginDeChat(loadEnv(mode, process.cwd(), "")), pluginMultiplayer()],

  resolve: {
    // O three-mesh-bvh declara `three` como peer e o Vite acabava resolvendo
    // uma segunda copia -- o console avisava "Multiple instances of Three.js".
    // Duas copias significam classes distintas, e os `instanceof` internos
    // passam a falhar de formas dificeis de diagnosticar.
    dedupe: ["three"],
  },
  server: {
    // Respeita PORT para conviver com outros dev servers ja rodando na 5173.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    // O .glb e o decodificador Draco vivem em public/ e sao copiados como
    // estao; o aviso de chunk grande so atrapalharia.
    chunkSizeWarningLimit: 1500,
  },
  // .glb e .wasm ja sao tratados como assets pelo Vite; declaramos so para
  // deixar explicito caso alguem adicione modelos importados por codigo.
  assetsInclude: ["**/*.glb"],
}));
