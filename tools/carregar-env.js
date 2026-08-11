/**
 * Lê o .env para o servidor de produção.
 *
 * No modo dev quem faz isso é o Vite (`loadEnv` no vite.config.js). O server.js
 * roda sem Vite, então precisa de um leitor próprio -- pequeno de propósito,
 * para não arrastar uma dependência só por causa de um arquivo de chave.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { criarHandlerDeChat } from "./chat-proxy.js";

function analisar(texto) {
  const saida = {};
  for (const linha of texto.split("\n")) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith("#")) continue;

    const igual = limpa.indexOf("=");
    if (igual < 0) continue;

    const chave = limpa.slice(0, igual).trim();
    let valor = limpa.slice(igual + 1).trim();
    // Aspas ao redor do valor são convenção do formato, não parte do valor.
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (chave) saida[chave] = valor;
  }
  return saida;
}

export async function carregarEnv(diretorio = process.cwd()) {
  let doArquivo = {};
  try {
    doArquivo = analisar(await readFile(resolve(diretorio, ".env"), "utf8"));
  } catch {
    // Sem .env: o ambiente real pode já trazer a variável (Docker, CI, PaaS).
  }
  // O ambiente do processo ganha do arquivo, que é o esperado em deploy.
  return { ...doArquivo, ...process.env };
}

export async function createHandlerDeChatComEnv() {
  // Ver a nota em server.js: import.meta.dirname é undefined antes do Node 20.11.
  const aqui = fileURLToPath(new URL(".", import.meta.url));
  const env = await carregarEnv(resolve(aqui, ".."));
  if (!env.OPENAI_API_KEY) {
    console.warn(
      "[chat] OPENAI_API_KEY ausente: o chat vai responder 503 até você criar o .env",
    );
  }
  return criarHandlerDeChat(env);
}
