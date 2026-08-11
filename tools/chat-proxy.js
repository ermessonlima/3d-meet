/**
 * Proxy de chat: o navegador fala com /api/chat, e SO o servidor fala com a
 * OpenAI.
 *
 * Por que existe: uma chave de API embutida no front e uma chave publicada.
 * Ela apareceria no bundle, no devtools e em qualquer deploy estatico -- e
 * qualquer pessoa poderia gastar na sua conta. Aqui a chave vive em
 * process.env, no processo do servidor, e nunca cruza a rede em direcao ao
 * navegador.
 *
 * O mesmo handler serve o `vite dev` (via plugin) e a producao (via server.js),
 * para nao existirem dois caminhos que possam divergir.
 */

const URL_OPENAI = "https://api.openai.com/v1/chat/completions";

// Trocavel por .env sem mexer no codigo. Se a conta nao tiver acesso ao
// modelo, a OpenAI responde 404/400 e a mensagem sobe intacta para a interface.
const MODELO_PADRAO = "gpt-4o-mini";

const MAX_MENSAGENS = 24;      // memoria da conversa enviada de volta
const MAX_CARACTERES = 1200;   // por mensagem do usuario

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on("data", (p) => {
      tamanho += p.length;
      // Um corpo gigante aqui viraria custo de token la na frente.
      if (tamanho > 256 * 1024) {
        reject(new Error("corpo grande demais"));
        req.destroy();
        return;
      }
      partes.push(p);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString("utf8") || "{}"));
      } catch (erro) {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

function responder(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(corpo);
}

/**
 * Higieniza o historico que voltou do navegador.
 *
 * O cliente e a fonte do historico, entao ele e dado nao-confiavel: limitamos
 * papeis, tamanho e quantidade. Sem isso, um cliente adulterado poderia
 * injetar um `system` proprio e reescrever a persona do NPC.
 */
function limparHistorico(mensagens) {
  if (!Array.isArray(mensagens)) return [];
  return mensagens
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-MAX_MENSAGENS)
    .map((m) => ({
      role: m.role,
      content: String(m.content ?? "").slice(0, MAX_CARACTERES),
    }))
    .filter((m) => m.content.length > 0);
}

export function criarHandlerDeChat(env = process.env) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      return responder(res, 405, { erro: "use POST" });
    }

    const chave = env.OPENAI_API_KEY;
    if (!chave) {
      return responder(res, 503, {
        erro:
          "OPENAI_API_KEY não configurada. Crie web/.env com " +
          "OPENAI_API_KEY=sk-... e reinicie o servidor.",
      });
    }

    let corpo;
    try {
      corpo = await lerCorpo(req);
    } catch (erro) {
      return responder(res, 400, { erro: erro.message });
    }

    const historico = limparHistorico(corpo.mensagens);
    if (!historico.length) {
      return responder(res, 400, { erro: "nenhuma mensagem" });
    }

    // A persona vem do servidor, nao do cliente: e o que garante que o NPC
    // continue sendo o NPC mesmo que alguem mexa no front.
    const persona = String(corpo.persona ?? "").slice(0, 4000);

    try {
      const resposta = await fetch(URL_OPENAI, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${chave}`,
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || MODELO_PADRAO,
          messages: [{ role: "system", content: persona }, ...historico],
          max_tokens: 300,
          temperature: 0.9,
        }),
      });

      const dados = await resposta.json();

      if (!resposta.ok) {
        console.error("[chat] OpenAI %d:", resposta.status, dados?.error);
        return responder(res, resposta.status, {
          erro: dados?.error?.message ?? `OpenAI respondeu ${resposta.status}`,
        });
      }

      const texto = dados?.choices?.[0]?.message?.content?.trim();
      if (!texto) return responder(res, 502, { erro: "resposta vazia" });

      return responder(res, 200, { texto });
    } catch (erro) {
      console.error("[chat] falha ao chamar a OpenAI:", erro);
      return responder(res, 502, { erro: "não foi possível falar com a API" });
    }
  };
}

/** Plugin que pendura /api/chat no servidor de desenvolvimento do Vite. */
export function pluginDeChat(env) {
  return {
    name: "proxy-de-chat",
    configureServer(servidor) {
      const handler = criarHandlerDeChat(env);
      servidor.middlewares.use("/api/chat", (req, res, next) => {
        handler(req, res).catch(next);
      });
    },
  };
}
