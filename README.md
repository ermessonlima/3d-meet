# POLYGON Office — visualizador web

Renderiza o cenário de demonstração do pacote POLYGON Office (Synty) no
navegador, com three.js.

```bash
npm install
npm run dev
```

## Qual arquivo do pacote é usado

O pacote traz o mesmo conteúdo em vários formatos. Só um deles é um **cenário
montado**:

| Arquivo | Uso |
|---|---|
| `SourceFiles/Office_Demo.fbx` | **é a fonte deste projeto** — a cena de demonstração inteira, montada |
| `SourceFiles/FBX/` e `OBJ/` (774 arquivos) | peças soltas, sem posicionamento |
| `POLYGON_Office_Unreal_5_3_v1_10_0/` | formato proprietário da Unreal |
| `POLYGON_Office_Unity_2022_3_v1_9_3.unitypackage` | formato proprietário da Unity |

## Pipeline

`Office_Demo.fbx` → `tools/fbx_to_glb.py` (Blender headless) →
`public/models/office_demo.glb` → three.js.

```bash
npm run convert
```

Requer o Blender no PATH (`brew install --cask blender`). O `.glb` já está
versionado, então só é preciso rodar isso se você mexer no script ou no FBX.

O script resolve quatro problemas do FBX original:

1. **Colisão.** 1876 das 4190 malhas são `UCX_*`, volumes de colisão do
   Unreal. São invisíveis no jogo, mas na web apareceriam como blocos sólidos
   cobrindo a cena. São descartadas.
2. **Texturas.** Os materiais apontam para caminhos absolutos do Windows do
   artista (`U:/Dropbox/SyntyStudios/...`), e o atlas principal aponta para um
   `.psd` que nem vem no pacote. Cada material é religado à mão no PNG certo
   (tabela `TEXTURAS` no script).
3. **Draw calls.** As 2276 malhas restantes seriam 2276 draw calls por frame.
   Como só existem 9 materiais, as malhas são fundidas por
   *(grupo de topo × material)*, caindo para **19 malhas / 363 mil
   triângulos**. Fundir tudo num bloco só seria ainda mais rápido, mas
   soldaria o telhado ao resto e impediria de olhar dentro do prédio.
4. **Luzes.** As ~28 point lights do Unreal são descartadas; a iluminação é
   refeita no three.js (key direcional + hemisférica + `RoomEnvironment` para
   os reflexos do cromo e do vidro).

Os grupos de topo do FBX (`MainOffice`, `HomeOffice`, `Ceiling`, `Roof`,
`Diversos`) viram nós no glTF, e é isso que permite o botão **Ver interior**
esconder `Roof` e `Ceiling`.

## Personagem jogável

O botão **Entrar com o personagem** troca da órbita para terceira pessoa:
`WASD` anda, `shift` corre, `espaço` pula, o mouse gira a câmera.

```bash
npm run convert:personagem
```

Os `SK_Chr_*.fbx` vêm riggados (esqueleto UE4 de 55 ossos) mas com **zero
animações** — a Synty espera que você traga as suas. Como não há de onde
importar, `tools/personagem_to_glb.py` autora três clipes na mão: `Parado`,
`Andar` e `Pular`.

Autorar animação por script tem uma armadilha central: não dá para chutar em
torno de qual eixo local cada osso gira, porque isso depende de como o FBX foi
exportado. O script converte um eixo conhecido do espaço do armature para o
espaço local do osso e depois **afere o sinal medindo o deslocamento real** do
membro no mundo. Por isso ele detecta sozinho, por exemplo, que os sinais dos
dois braços são espelhados — e continua correto se você trocar o personagem
por outro do pacote (constante `PERSONAGEM` no topo do script).

### Clicar e caminhar

Clique num ponto do chão e o personagem vai até lá, contornando paredes e
móveis. `WASD` continua funcionando e assume o controle assim que você toca
numa tecla.

**Por que existe uma grade, e não "ande em linha reta até o clique".** Andar
direto funciona em campo aberto. Aqui é um escritório: clicar na sala ao lado
faria o personagem encostar na parede e ficar empurrando, porque a cápsula
desliza mas não contorna.

[src/navegacao.js](src/navegacao.js) amostra o cenário uma vez, no
carregamento — um raio para baixo por coluna de 40 cm, guardando **todos** os
pisos encontrados, não só o primeiro. É o que permite o térreo existir por
baixo do mezanino: com um nível por coluna, o andar de baixo sumiria do mapa.
Medido: **25 ms**, 7413 colunas caminháveis, 8292 níveis (879 colunas têm mais
de um piso). O A* roda em 0,2 ms nos trajetos curtos e ~15 ms nos piores.

Três decisões que valem explicar:

- **Sem erosão das bordas.** O instinto é encolher as áreas caminháveis pelo
  raio do corpo, mas uma porta de 90 cm tem duas células: comer uma de cada
  lado fecha a passagem. O caminho passa rente à parede e a física resolve
  deslizando.
- **Detecção de travamento.** A consequência de não erodir é que um trajeto
  pode passar apertado demais e o corpo não caber. Sem saída, o personagem
  empurra a mobília com a animação de andar rodando para sempre — foi o que
  aconteceu no primeiro teste: 0,7 m andados de 3,6 m pedidos, preso por 25 s.
  Agora, 900 ms sem se aproximar do ponto e ele pula para o próximo.
- **Clique fora do chão vira chão.** Clicar num tampo de mesa, prateleira ou
  parede procura o piso logo abaixo do ponto e vai até ali, recuando 30 cm na
  direção do jogador — pousar exatamente sobre a face de uma parede cairia numa
  coluna sem piso e o caminho falharia por um centímetro.

A captura de ponteiro **saiu** por causa disto. Ela era boa para olhar em
volta, mas some com o cursor, e sem cursor não há como mirar um ponto no chão.
Agora arrastar gira a câmera e clicar sem arrastar (menos de 5 px) é ordem de
movimento.

### Física e câmera

- **Colisão**: `three-mesh-bvh` sobre uma BVH das ~363 mil faces do cenário. O
  jogador é uma cápsula empurrada para fora de cada triângulo que penetra; o
  deslocamento acumulado também diz se ele está no chão.
- **Nascimento**: uma varredura em grade raycasta o chão e mede o pé-direito de
  cada candidato, ficando com o de maior folga perto do centro. Nascer no
  centro geométrico cairia dentro de uma parede.
- **Câmera**: braço telescópico próprio (`cameraTerceiraPessoa.js`), que
  encolhe quando há parede entre a lente e o personagem.

## Multiplayer

A tela inicial pede nome, personagem (6 opções, com retratos) e cor, e então
cria ou entra numa sala. Salas têm código de 6 caracteres e senha opcional;
`copiar convite` gera um link com `?sala=CODIGO` que já abre na aba certa.

Dentro do jogo: `Y` fala (balão sobre a cabeça), e o painel superior lista quem
está online.

```bash
npm run dev       # jogo + chat + multiplayer, tudo na mesma porta
```

### Chat, voz, vídeo e tela

Na sala: **chat lateral** com histórico (quem entra no meio recebe as últimas
50 mensagens), **microfone**, **câmera** e **compartilhamento de tela**. Toda
mensagem do chat também vira um balão sobre a cabeça do avatar, por 6 segundos.

Áudio e vídeo vão **direto entre os navegadores** (WebRTC). O servidor só
carrega os envelopes da negociação — a mídia nunca passa por ele.

**Tudo isso exige HTTPS.** `getUserMedia` e `getDisplayMedia` não existem fora
de contexto seguro; em `http://` os botões aparecem desabilitados explicando o
motivo, em vez de falhar com um erro críptico.

#### Malha, e até onde ela vai

Cada participante manda o próprio vídeo para todos os outros. Com 4 pessoas são
3 uploads simultâneos por pessoa; com 8, são 7. Por isso a câmera é capturada
em 320×240 e a tela a 8 fps — mesmo assim, **acima de ~6 pessoas com câmera
ligada a banda de subida doméstica não aguenta**. Passar disso pede um SFU
(servidor que recebe uma vez e redistribui), que é outra arquitetura.

Há STUN público configurado, que resolve a maioria das redes domésticas. **Não
há TURN**: em NAT simétrico (parte das redes corporativas e móveis) a conexão
não fecha. TURN exige um servidor que retransmite mídia, com custo de banda.

#### Três armadilhas do WebRTC que estão resolvidas aqui

1. **`replaceTrack` não avisa o outro lado.** A primeira versão usava os
   eventos `mute`/`unmute` da faixa recebida para saber se alguém ligou a
   câmera. Eles disparam na negociação inicial e **nunca mais** — ligar a
   câmera depois não gerava evento nenhum. Quem manda é a mensagem `midia`,
   explícita; a faixa WebRTC é só o cano.
2. **Responder sem faixas trava o canal.** Quem entra com câmera e microfone
   desligados (o caso normal) responde `recvonly`, e aquele transceptor fica
   preso em "só recebo" — ligar a câmera depois não envia nada, sem erro algum.
   O respondedor força `direction = "sendrecv"` antes de criar a resposta.
3. **Sinal que chega cedo demais some.** O outro lado oferta assim que o
   servidor confirma sua entrada; se nesse instante você ainda estiver baixando
   o GLB do personagem, a oferta chega sem malha e é descartada — e não há
   retransmissão, a chamada fica em `new` para sempre. A malha é criada antes
   de qualquer `await` posterior à entrada.

Os canais são negociados **uma vez só**: três transceptores fixos (áudio,
câmera, tela) reservados na abertura, e ligar/desligar vira `replaceTrack` no
canal que já existe. Sem renegociação, sem risco de ofertas cruzadas. O preço é
que a ordem vira contrato: `mid` 0 é áudio, 1 é câmera, 2 é tela.

### Decisões de segurança

- **Senha de sala nunca fica em texto puro.** É guardada como `scrypt` com salt
  por sala e comparada com `timingSafeEqual` — comparar com `===` vaza, pelo
  tempo de resposta, quantos bytes iniciais estavam certos. Sala de jogo não
  parece valer o esforço, mas as pessoas reciclam senhas.
- **Sala inexistente e senha errada dão a mesma mensagem**, e o caminho sem
  sala também gasta um `scrypt`. Sem isso, o endpoint viraria um oráculo para
  descobrir quais códigos existem.
- **Senha não vai para o `localStorage`.** Nome, personagem e cor vão (é
  conveniência); senha seria persistir credencial de outra pessoa em disco.
- **Tudo que chega do cliente é validado no servidor**: personagem e cor contra
  listas fechadas, nome e fala com limite e sem caracteres de controle,
  posições contra os limites do mundo e uma velocidade máxima.
- **Limites de taxa**: 45 mensagens/s por conexão, 12 tentativas de entrar por
  minuto por IP, 1 fala a cada 700 ms.
- **Ping/pong a cada 30 s.** Socket morto por cabo arrancado ou celular
  dormindo não dispara `close`; sem a batida, jogadores fantasmas ficariam na
  sala para sempre.

### O que isto não é

Não é à prova de trapaça. O cliente manda a própria posição e o servidor
retransmite. A validação barra teleporte e voo bobos, mas quem quiser trapacear
ainda anda rápido dentro do limite permitido. Para valer, a física teria que
rodar no servidor — é uma reescrita, não um ajuste.

Em produção, sirva por HTTPS: o cliente escolhe `wss://` automaticamente quando
a página está em `https:`, mas sem TLS a senha da sala trafega em claro.

## Publicar

Este projeto **não é um site estático**. O `dist/` sozinho não funciona: o
chat precisa de um servidor que guarde a chave da OpenAI, e o multiplayer
precisa de um WebSocket. Hospedagem estática (GitHub Pages, Netlify drop,
S3 puro) só serviria se você abrisse mão dos dois.

O que o host precisa oferecer: **processo Node de vida longa** (não serverless
por requisição), **WebSocket**, e variáveis de ambiente. Render, Railway, Fly.io
ou uma VPS resolvem.

### Com Docker (recomendado)

```bash
cp .env.example .env        # preencha OPENAI_API_KEY
docker compose up --build
```

Sobe em `http://localhost:4173`. Para outra porta: `PORTA_EXTERNA=8080 docker
compose up`.

A imagem tem dois estágios: o de build carrega three, Vite e o ferramental; o
de runtime recebe só o `dist/` e um único pacote (`ws`). O toolchain inteiro
fica fora da imagem publicada.

Escolhas que valem explicar:

- **A chave entra por `env_file`, nunca por build arg.** Um build arg ficaria
  gravado numa camada, legível por qualquer um que baixasse a imagem. O
  `.dockerignore` também mantém o `.env` fora do contexto de build.
- **Roda como `node`, não como root**, com `read_only: true` e
  `no-new-privileges`. O processo não escreve em disco, então nada disso
  atrapalha — e se ele for comprometido, o estrago fica contido.
- **`CMD ["node", "server.js"]`, sem npm no meio.** Com `npm start`, o npm
  seria o PID 1 e engoliria o SIGTERM; o contêiner só morreria no timeout,
  derrubando os WebSockets de forma abrupta. Assim o Node recebe o sinal
  direto, avisa cada cliente com o código 1001 e sai — medido: 1 s.
- **`npm ci --ignore-scripts` nos dois estágios.** No build é obrigatório (o
  `postinstall` chama um arquivo que ainda não foi copiado, para preservar o
  cache de camadas); no runtime é higiene, além de o Draco já vir pronto no
  `dist/`.
- **Os `.glb` não são gerados no build.** Vêm do Blender, que sozinho passaria
  de 1 GB na imagem. Rode `npm run convert:todos` na sua máquina e versione o
  `public/`.

Imagem final: 381 MB, dos quais 17 MB são os assets do jogo.

### Sem Docker

```bash
npm ci
npm run build
npm start          # respeita PORT; escuta HTTP e /ws na mesma porta
```

No painel do host, configure `OPENAI_API_KEY` como variável de ambiente —
não suba o `.env` junto com o código.

### Antes de apontar o domínio

- **HTTPS não é opcional.** Sem TLS a senha da sala trafega em claro, e a
  captura do mouse (pointer lock) não funciona. O cliente já escolhe `wss://`
  sozinho quando a página está em `https:`.
- **Uma instância só.** As salas vivem na memória do processo. Se o host subir
  duas réplicas, jogadores da mesma sala caem em processos diferentes e não se
  enxergam. Para escalar horizontalmente seria preciso mover as salas para
  Redis (ou similar) e usar sessões fixas — não é ajuste de configuração.
- **~17 MB de assets** por jogador novo, dos quais 14 MB são modelos. O
  servidor já manda `Cache-Control` (imutável para `/assets/`, uma hora para
  modelos e retratos), então a segunda visita é barata; a primeira não. Se a
  banda pesar, ponha um CDN na frente.
- **Custo do chat.** Cada mensagem reenvia o histórico. Sem teto de gasto na
  conta da OpenAI, uma sala movimentada vira fatura.
- **Node 18.17+** (`engines` no package.json).

## NPC com chat

Chegue perto da Renata (ela nasce a ~4 m de você), aperte `E`: a câmera enquadra
o rosto dela e abre um painel de conversa. `Esc` ou se afastar encerra.

### Configurar a chave

```bash
cp .env.example .env
```

Preencha `OPENAI_API_KEY=sk-...` e reinicie o `npm run dev`. Sem a chave o chat
abre normalmente e responde com um aviso dizendo o que falta.

**A chave nunca vai para o navegador.** O front fala com `/api/chat`, e só o
processo do servidor fala com a OpenAI. Isso não é zelo excessivo: uma chave em
código de front aparece no bundle, no devtools e em qualquer deploy estático —
qualquer pessoa poderia gastar na sua conta.

Consequência prática: `vite build` gera só estáticos, que não têm onde guardar
uma chave. Por isso existe o `server.js`, que serve `dist/` **e** o mesmo proxy:

```bash
npm run build && npm start
```

O modelo padrão é `gpt-4o-mini`; troque com `OPENAI_MODEL` no `.env` sem mexer
no código. Se sua conta não tiver acesso ao modelo escolhido, a mensagem de erro
da OpenAI sobe intacta para o painel do chat.

### Detalhes

- A persona é montada **no servidor**, não no cliente, e o histórico que volta
  do navegador é filtrado a `user`/`assistant`. Sem isso, um cliente adulterado
  poderia injetar o próprio `system` e reescrever quem é a Renata.
- A API de chat não guarda estado entre chamadas: "memória" é reenviar o
  histórico a cada mensagem. `MAX_TURNOS` limita a janela — sem teto, cada
  mensagem de uma conversa longa fica progressivamente mais cara.
- O NPC é o mesmo pipeline do jogável, com outro `SK_Chr_*`
  (`npm run convert:npc`). Como os sinais de rotação são aferidos do rig, os
  clipes saem corretos sem nenhum ajuste manual para o novo corpo.
- Enquanto o chat está aberto o jogador congela e as teclas param no painel —
  senão o personagem sairia andando a cada "w" digitado.

## Interface

O sistema visual está em [src/style.css](src/style.css), com duas regras que
valem mais que o resto:

- **Tipografia por função.** A fonte do sistema para a interface; a
  monoespaçada só para dados literais — código da sala, contadores do HUD,
  teclas. Antes era tudo monoespaçado, o que faz qualquer produto parecer
  terminal de depuração.
- **Superfícies nomeadas** (`--sup-0..3`) em vez de hexadecimais soltos.
  Painéis que flutuam sobre a cena 3D precisam de contraste previsível contra
  *qualquer* fundo, e a cena vai de parede branca a corredor escuro.

Os ícones vêm do **Lucide**, importados um a um em
[src/icones.js](src/icones.js) — o pacote tem 3500 e o bundler carrega só os
nomeados. Substituíram emoji, que são desenhados pela fonte do sistema: mudam
de forma entre macOS, Windows e Android, não herdam cor (então não acompanham
o estado de um botão) e não alinham com o texto ao lado.

Uma variável `--painel-direito` guarda quanto o chat lateral ocupa. Tudo que é
centrado se centra no que *sobra* e encolhe junto: deslocar só o `left` de um
elemento com `translate(-50%)` move o centro sem reduzir a largura, e foi assim
que o palco de tela compartilhada saiu pela borda esquerda na primeira versão.

## Estrutura

```
src/main.js                entrada: carrega, liga a UI, alterna os modos
src/scene.js               renderer, câmera, controles, luzes, enquadramento
src/carregarModelo.js      GLTFLoader + Draco, e os ajustes de material
src/colisor.js             BVH do cenário e busca do ponto de nascimento
src/navegacao.js           grade caminhável multinível e A*
src/marcador.js            anel que marca o destino do clique
src/jogador.js             cápsula, gravidade, pulo e máquina de animação
src/cameraTerceiraPessoa.js braço telescópico com colisão
src/npc.js                 NPC, proximidade e persona
src/chat.js                painel de conversa com o NPC
src/lobby.js               tela inicial: perfil e sala
src/rede.js                cliente WebSocket
src/webrtc.js              malha ponto a ponto de áudio, vídeo e tela
src/midia.js               captura local e detector de voz
src/painelChat.js          chat lateral da sala
src/tilesVideo.js          tiles de vídeo e palco de tela compartilhada
src/jogadoresRemotos.js    avatares dos outros, com interpolação
src/etiquetas.js           nomes e balões de fala no mundo 3D
server.js                  produção: dist/ + /api/chat + /ws
tools/salas.js             regras de sala e senha (sem transporte)
tools/multiplayer.js       WebSocket, validação e retransmissão
tools/fbx_to_glb.py        conversão do cenário (Blender headless)
tools/personagem_to_glb.py conversão + autoria das animações do personagem
tools/chat-proxy.js        proxy da OpenAI (dev via plugin, prod via server.js)
tools/carregar-env.js      leitor de .env para o server.js
tools/copy-draco.js        copia o decodificador Draco para public/ (postinstall)
```

## Detalhes que custaram tempo

- **Escala.** O importador de FBX do Blender já aplica o fator de unidade do
  cabeçalho. Passar `global_scale=0.01` "para converter cm → m" encolhe a cena
  100×, para 0.6 m. O valor correto é `1.0`.
- **Filtro de textura.** A textura da Synty é um atlas de blocos de cor
  chapada. Com filtro linear na ampliação, blocos vizinhos se misturam e
  aparecem listras de cor errada. Usamos `NearestFilter` na ampliação e
  mipmap + anisotropia na redução, senão a cena cintila de longe.
- **Blender 5.x.** O importador de FBX quebra em qualquer arquivo com luz
  (`CyclesLightSettings.cast_shadow` foi removido). `remendar_importador_de_luz()`
  contorna isso.
- **Vidro.** Fica fora do mapa de sombras: o shadow map é binário e ignora
  alpha, então o vidro projetaria sombra de parede sólida.
- **Ordem de composição dos quatérnions.** A rotação de pose de um osso vale
  `L @ q`; para somar uma rotação `A` do espaço do armature sobre uma base `B`,
  sai `extra @ base`, não `base @ extra`. Com a ordem trocada as pernas ainda
  funcionam (a base delas é identidade), mas os braços não: em T-pose o braço
  aponta na direção do eixo lateral, então girar em torno dele antes de baixar
  o braço vira uma torção no próprio eixo do osso e o balanço some.
- **Ângulo de braço no pulo.** Partindo do braço já abaixado, 90° é a
  **horizontal**, não o alto. Com 95° a pose lê como zumbi apontando para
  frente; o impulso só lê como arremesso para cima a partir de ~140°.
- **`import.meta.dirname`.** Só existe a partir do Node 20.11; antes disso é
  `undefined` e o servidor de produção nem sobe. `fileURLToPath(new URL(".",
  import.meta.url))` funciona em qualquer versão com ESM.
- **`ws` com a opção `server`.** Passar `server` faz o `ws` registrar o próprio
  listener de upgrade e **abortar** o handshake de qualquer caminho que não seja
  o dele — o que derruba o WebSocket de HMR do Vite, que divide a porta. O certo
  é `noServer: true` e tratar o `upgrade` na mão, ignorando caminhos alheios.
- **`SkeletonUtils` não existe como objeto.** O módulo exporta `clone` solto;
  `const { SkeletonUtils } = await import(...)` dá `undefined` sem erro, e a
  falha só aparece depois, como avatar remoto que nunca nasce.
- **`acceleratedRaycast`.** Instalar a `MeshBVH` numa geometria não faz o
  `THREE.Raycaster` usá-la: é preciso trocar `THREE.Mesh.prototype.raycast`.
  Sem isso cada raio percorre os 363 mil triângulos um a um — passa
  despercebido na busca do nascimento (roda uma vez) e inviabiliza a sonda da
  câmera, que dispara cinco raios por frame.
- **Decodificador Draco.** Parece redundante servir uma cópia em
  `public/draco/`, já que o `DRACOLoader` do three aponta sozinho para os
  arquivos do pacote e o Vite os emite no `build`. Mas isso só vale no build:
  em `dev` o Vite pré-empacota o three em `.vite/deps/`, o `import.meta.url`
  passa a apontar para um caminho inexistente, o servidor responde `index.html`
  e o decodificador morre com `Unexpected token '<'`. A cópia explícita é o que
  faz dev e produção se comportarem igual.

## Problema conhecido

Dois monitores do `HomeOffice` (`SM_Prop_Computer_Monitor_04`) terminam a
conversão deslocados ~7 m para oeste, e aparecem como dois quadrados escuros
flutuando fora do prédio. Eles estão na posição certa no FBX e continuam certos
até a etapa `separate`; o desvio surge no reparenteamento, e sobrevive tanto à
atribuição direta de `.parent` quanto ao operador `parent_set`. Só essas 2 das
19 malhas finais são afetadas. Investigação interrompida a pedido — o resto da
cena está correto (bounding box 56.4 m no FBX, contra 63.6 m no `.glb` por
causa desses dois objetos).
# 3d-meet
