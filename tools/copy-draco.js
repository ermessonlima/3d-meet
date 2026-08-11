/**
 * Copia o decodificador Draco do three.js para public/draco/.
 *
 * O .glb e comprimido com Draco, entao o navegador precisa do decodificador
 * (um .wasm) para abrir a geometria.
 *
 * Em tese daria para omitir isso: o DRACOLoader do three ja aponta para os
 * arquivos que vem no pacote, via `new URL(..., import.meta.url)`, e o Vite os
 * emite no `build`. Mas isso so funciona no build -- em `dev` o Vite
 * pre-empacota o three em node_modules/.vite/deps/, o import.meta.url passa a
 * apontar para um caminho que nao existe, o servidor responde o index.html no
 * lugar e o decodificador morre com "Unexpected token '<'".
 *
 * Servir nossa propria copia de public/ e explicito e funciona igual em dev e
 * em producao. O custo e o bundle carregar uma copia morta dos mesmos
 * arquivos, que nenhum usuario chega a baixar.
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origem = resolve(raiz, "node_modules/three/examples/jsm/libs/draco/gltf");
const destino = resolve(raiz, "public/draco");

try {
  await mkdir(destino, { recursive: true });
  await cp(origem, destino, { recursive: true });
  console.log("draco copiado para public/draco/");
} catch (erro) {
  console.error("nao foi possivel copiar o Draco:", erro.message);
  process.exitCode = 1;
}
