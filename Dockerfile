# syntax=docker/dockerfile:1

# Imagem do POLYGON Office: front estático + proxy de chat + WebSocket.
#
# Dois estágios porque as duas metades têm necessidades opostas. O build
# precisa do three, do Vite e de todo o ferramental; o runtime precisa de UM
# pacote (ws) e dos arquivos prontos. Copiar só o resultado tira o toolchain
# inteiro da imagem publicada -- menos peso e menos superfície de ataque.
#
# Os .glb NÃO são gerados aqui. Eles saem do Blender (npm run convert:todos),
# que sozinho pesaria mais de 1 GB na imagem, e são commitados em public/.

# ---------------------------------------------------------------- build

FROM node:22-slim AS build

WORKDIR /app

# package.json e lock antes do resto: enquanto as dependências não mudarem,
# o Docker reaproveita a camada do npm ci mesmo com o código alterado.
COPY package.json package-lock.json ./
# --ignore-scripts aqui é obrigatório, não preferência: o postinstall deste
# projeto executa tools/copy-draco.js, que ainda não foi copiado. Rodamos o
# script logo depois do COPY, quando ele existe.
RUN npm ci --ignore-scripts

COPY . .

# Os modelos vêm do Blender, fora do contêiner. Sem esta checagem a imagem
# constrói normalmente e o erro só aparece no navegador de quem for jogar --
# barulhento e no lugar errado. Melhor falhar aqui, dizendo o comando.
RUN for f in models/office_demo.glb models/personagens/Business_Male_01.glb \
             retratos/Business_Male_01.png; do \
      test -f "public/$f" || { \
        echo "ERRO: public/$f não existe."; \
        echo "Os .glb e retratos são gerados pelo Blender, fora do Docker."; \
        echo "Rode 'npm run convert:todos' antes de construir a imagem."; \
        exit 1; \
      }; \
    done

RUN node tools/copy-draco.js && npm run build

# --------------------------------------------------------------- runtime

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4173

WORKDIR /app

COPY package.json package-lock.json ./

# --omit=dev deixa só o ws. --ignore-scripts porque o postinstall daqui copia
# o decodificador Draco a partir do three, que não existe em produção -- e
# porque não rodar scripts de pacotes de terceiros em produção é boa prática
# por si só. O Draco já veio pronto dentro do dist/.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server.js ./
COPY tools/chat-proxy.js tools/carregar-env.js tools/multiplayer.js tools/salas.js ./tools/

# A imagem node já traz o usuário `node`, sem privilégios. Um processo que
# atende a internet não tem motivo para ser root: se for comprometido, o
# estrago fica limitado ao que este usuário alcança.
USER node

EXPOSE 4173

# Sem curl nem wget na imagem slim; o próprio Node resolve com o fetch global.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sem npm no meio: o node vira PID 1 e recebe o SIGTERM do `docker stop`
# diretamente. Com `npm start`, o npm engoliria o sinal e o contêiner só
# morreria no timeout, derrubando as conexões WebSocket de forma abrupta.
CMD ["node", "server.js"]
