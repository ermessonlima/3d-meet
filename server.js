/**
 * Servidor de produção: serve dist/ e expõe /api/chat.
 *
 *     npm run build && npm start
 *
 * O `vite build` gera só arquivos estáticos, e estáticos não têm onde guardar
 * uma chave de API. Este servidor existe para que a versão publicada tenha o
 * mesmo proxy do modo dev -- sem ele, a única forma de o chat funcionar em
 * produção seria embutir a chave no bundle, que é exatamente o que se quer
 * evitar.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandlerDeChatComEnv } from "./tools/carregar-env.js";
import { criarServidorMultiplayer } from "./tools/multiplayer.js";

// fileURLToPath em vez de import.meta.dirname: `dirname` só existe a partir do
// Node 20.11, e em versões anteriores é `undefined` -- o servidor nem sobe.
const AQUI = fileURLToPath(new URL(".", import.meta.url));
const RAIZ = resolve(AQUI, "dist");
const PORTA = Number(process.env.PORT) || 4173;

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const chat = await createHandlerDeChatComEnv();

const http = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Usado pelo HEALTHCHECK do contêiner. Não toca no disco de propósito: um
  // healthcheck que lê arquivo mede o disco, não se o processo está de pé.
  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: true, tempoDeVida: process.uptime() }));
  }

  if (url.pathname === "/api/chat") {
    return chat(req, res).catch((erro) => {
      console.error(erro);
      res.statusCode = 500;
      res.end('{"erro":"falha interna"}');
    });
  }

  // normalize + prefixo obrigatório: sem isso um pedido com ".." leria
  // arquivos fora de dist/, inclusive o .env com a chave.
  const pedido = normalize(decodeURIComponent(url.pathname));
  let caminho = join(RAIZ, pedido === "/" ? "index.html" : pedido);
  if (!caminho.startsWith(RAIZ)) {
    res.statusCode = 403;
    return res.end("acesso negado");
  }

  try {
    const corpo = await readFile(caminho);
    res.setHeader("Content-Type", TIPOS[extname(caminho)] ?? "application/octet-stream");

    // Os arquivos em /assets/ levam hash no nome: uma versão nova tem outro
    // nome, então podem ser cacheados para sempre. Modelos e retratos mantêm o
    // nome entre versões, então recebem um cache curto -- do contrário, trocar
    // um personagem só apareceria depois do cache do usuário expirar.
    if (pedido.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (pedido.startsWith("/models/") || pedido.startsWith("/retratos/")) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
    res.end(corpo);
  } catch {
    res.statusCode = 404;
    res.end("não encontrado");
  }
});

const mp = criarServidorMultiplayer(http);

http.listen(PORTA, () => {
  console.log(`servindo dist/ em http://localhost:${PORTA}`);
  console.log(`multiplayer em ws://localhost:${PORTA}/ws`);
});

/**
 * Desligamento limpo.
 *
 * O comportamento padrão do Node ao receber SIGTERM é morrer na hora, o que
 * derruba os WebSockets sem aviso -- para quem está jogando, o jogo trava até
 * o TCP desistir. Aqui avisamos cada cliente com um código de fechamento antes
 * de sair, e o front trata isso no `aoDesconectar`.
 *
 * O timer de segurança existe porque um socket travado pode não confirmar o
 * fechamento nunca; sem ele o contêiner só morreria no fim do grace period.
 */
let encerrando = false;

for (const sinal of ["SIGTERM", "SIGINT"]) {
  process.on(sinal, () => {
    if (encerrando) return;
    encerrando = true;
    console.log(`${sinal} recebido, encerrando`);

    for (const ws of mp.wss.clients) {
      ws.close(1001, "servidor reiniciando"); // 1001 = "going away"
    }
    mp.encerrar();

    http.close(() => {
      console.log("encerrado");
      process.exit(0);
    });

    setTimeout(() => process.exit(0), 8000).unref();
  });
}
