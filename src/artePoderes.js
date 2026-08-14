/**
 * Arte das habilidades da lagartixa.
 *
 * SVG, e não PNG, por três motivos práticos: fica nítido em qualquer densidade
 * de tela, pesa alguns KB no lugar de centenas, e -- o que mais importa aqui --
 * é recolorível. A barra precisa mostrar o mesmo ícone vivo, apagado em
 * recarga e bloqueado, e com bitmap isso exigiria três arquivos de cada.
 *
 * O traço segue o cenário: formas chapadas, facetadas em dois ou três tons,
 * sem gradiente nem contorno fino. É o mesmo vocabulário do POLYGON.
 */

/** Cada habilidade tem uma cor de assinatura, usada no brilho e na borda. */
export const ARTE = {
  assobioFalso: {
    nome: "Assobio falso",
    cor: "#7fd1ff",
    resumo: "Joga o chiado num ponto à sua escolha. O caçador corre para lá.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- a lagartixa, à esquerda, calada -->
        <path d="M6 40 L16 34 L26 36 L28 42 L18 46 L8 45 Z" fill="#2f6b46"/>
        <path d="M16 34 L26 36 L28 42 L20 40 Z" fill="#3d8a5a"/>
        <path d="M6 40 L10 37 L12 44 L8 45 Z" fill="#245236"/>
        <circle cx="11" cy="39" r="1.6" fill="#0b0e14"/>
        <!-- o trajeto do som, jogado para longe -->
        <path d="M28 38 C 36 26, 40 24, 44 24" stroke="#3f5a72" stroke-width="1.6"
              stroke-dasharray="3 3" fill="none" stroke-linecap="round"/>
        <!-- a fonte falsa: ondas saindo de onde não há ninguém -->
        <circle cx="45" cy="24" r="3.2" fill="#7fd1ff"/>
        <path d="M50 18 A 9 9 0 0 1 50 30" stroke="#7fd1ff" stroke-width="2.6"
              fill="none" stroke-linecap="round" opacity="0.85"/>
        <path d="M54 13 A 16 16 0 0 1 54 35" stroke="#7fd1ff" stroke-width="2.6"
              fill="none" stroke-linecap="round" opacity="0.5"/>
      </svg>`,
  },

  cauda: {
    nome: "Soltar a cauda",
    cor: "#8fe08f",
    resumo: "Isca que se contorce e assobia sozinha. Você sai de fininho.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- corpo indo embora, cortado pela borda esquerda -->
        <path d="M2 20 L16 16 L24 22 L22 32 L4 32 Z" fill="#2a5c3d"/>
        <path d="M16 16 L24 22 L22 32 L18 26 Z" fill="#3d8a5a"/>
        <circle cx="8" cy="23" r="1.7" fill="#0b0e14"/>
        <!-- a ruptura -->
        <path d="M27 12 L27 38" stroke="#8fe08f" stroke-width="1.8"
              stroke-dasharray="3 3.5" stroke-linecap="round" opacity="0.85"/>
        <!-- a cauda solta: três elos que afinam de verdade -->
        <path d="M32 18 L45 15 L47 27 L34 30 Z" fill="#8fe08f"/>
        <path d="M45 15 L54 20 L54 31 L47 27 Z" fill="#6ec46e"/>
        <path d="M54 20 L61 29 L58 36 L54 31 Z" fill="#4d9a4f"/>
        <!-- rastro do contorcer -->
        <path d="M33 40 C 42 48, 52 45, 60 47" stroke="#8fe08f" stroke-width="2.4"
              fill="none" stroke-linecap="round" opacity="0.4"/>
        <path d="M36 47 C 43 53, 51 51, 57 53" stroke="#8fe08f" stroke-width="2"
              fill="none" stroke-linecap="round" opacity="0.22"/>
      </svg>`,
  },

  cuspe: {
    nome: "Cuspir tinta",
    cor: "#ff9fb2",
    resumo: "Suja a tela do caçador com a sua cor. Ele vê o jato sair.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- focinho, embaixo à esquerda, claro o bastante para se ler -->
        <path d="M2 42 L16 34 L26 40 L24 52 L4 53 Z" fill="#3d8a5a"/>
        <path d="M16 34 L26 40 L24 52 L19 45 Z" fill="#4fa96f"/>
        <path d="M2 42 L8 39 L10 52 L4 53 Z" fill="#2f6b46"/>
        <circle cx="9" cy="42" r="1.9" fill="#0b0e14"/>
        <!-- o jato, grosso e em arco -->
        <path d="M25 39 C 32 27, 37 21, 43 19" stroke="#ff9fb2" stroke-width="4"
              fill="none" stroke-linecap="round" opacity="0.75"/>
        <!-- a mancha na cara de quem levou -->
        <path d="M36 8 L52 4 L61 14 L57 27 L41 28 L33 18 Z" fill="#ff9fb2"/>
        <path d="M52 4 L61 14 L57 27 L48 19 Z" fill="#e8788e"/>
        <circle cx="32" cy="32" r="3" fill="#ff9fb2" opacity="0.9"/>
        <circle cx="43" cy="34" r="2" fill="#ff9fb2" opacity="0.6"/>
        <circle cx="54" cy="34" r="1.5" fill="#ff9fb2" opacity="0.4"/>
      </svg>`,
  },

  escuro: {
    nome: "Apagar a luz",
    cor: "#ffd479",
    resumo: "Vinte segundos de breu. Só dá para alcançar o interruptor na parede.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- fio e luminária. O quebra-luz vai claro de propósito: em cinza
             escuro ele sumia contra o fundo do slot, e o ícone virava só dois
             olhos brilhando no nada. -->
        <path d="M32 2 L32 12" stroke="#5c6880" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M17 14 L47 14 L39 28 L25 28 Z" fill="#8a94a8"/>
        <path d="M32 14 L47 14 L39 28 L32 28 Z" fill="#69738a"/>
        <!-- bulbo apagado, com um resto de calor -->
        <path d="M28 28 L36 28 L34 37 L30 37 Z" fill="#ffd479" opacity="0.28"/>
        <!-- raios cortados: o traço curto e o X dizem "desligada" -->
        <path d="M13 30 L7 34" stroke="#ffd479" stroke-width="2.4"
              stroke-linecap="round" opacity="0.32"/>
        <path d="M51 30 L57 34" stroke="#ffd479" stroke-width="2.4"
              stroke-linecap="round" opacity="0.32"/>
        <path d="M44 38 L54 48 M54 38 L44 48" stroke="#ffd479" stroke-width="2.6"
              stroke-linecap="round" opacity="0.75"/>
        <!-- a lagartixa aproveitando o breu: só a silhueta e os olhos -->
        <path d="M6 48 L22 43 L34 47 L32 57 L8 58 Z" fill="#16321f"/>
        <circle cx="13" cy="49.5" r="2" fill="#ffd479"/>
        <circle cx="21" cy="48.4" r="2" fill="#ffd479"/>
      </svg>`,
  },

  esconder: {
    nome: "Esconder",
    cor: "#9fe8c4",
    resumo: "Achata no chão e fica translúcida. Trava o movimento: mexeu, apareceu.",
    alternavel: true,
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- a superfície atrás, para a translucidez ter no que se apoiar -->
        <path d="M4 40 L60 40 L60 58 L4 58 Z" fill="#232b3a"/>
        <path d="M4 40 L32 40 L32 58 L4 58 Z" fill="#1c2331"/>
        <path d="M12 46 L20 44 L22 52 L14 54 Z" fill="#2b3446" opacity="0.8"/>
        <path d="M40 44 L50 46 L48 54 L38 52 Z" fill="#2b3446" opacity="0.8"/>
        <!-- o bicho achatado, quase sumindo no fundo -->
        <path d="M10 44 L34 41 L48 45 L46 55 L12 56 Z" fill="#9fe8c4" opacity="0.32"/>
        <path d="M10 44 L34 41 L36 55 L12 56 Z" fill="#9fe8c4" opacity="0.2"/>
        <!-- as patas abertas em cruz, coladas -->
        <path d="M16 55 L12 60 L20 59 L21 55 Z" fill="#9fe8c4" opacity="0.28"/>
        <path d="M38 55 L44 60 L36 59 L35 55 Z" fill="#9fe8c4" opacity="0.28"/>
        <!-- só os olhos entregam -->
        <circle cx="18" cy="46" r="1.8" fill="#9fe8c4"/>
        <circle cx="25" cy="45.2" r="1.8" fill="#9fe8c4"/>
      </svg>`,
  },

  arranque: {
    nome: "Arranque",
    cor: "#c8a8ff",
    resumo: "Um pique curto e barulhento. Para quando já te viram.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- linhas de velocidade atrás -->
        <path d="M4 26 L20 26" stroke="#c8a8ff" stroke-width="2.6"
              stroke-linecap="round" opacity="0.3"/>
        <path d="M2 34 L18 34" stroke="#c8a8ff" stroke-width="2.6"
              stroke-linecap="round" opacity="0.5"/>
        <path d="M6 42 L22 42" stroke="#c8a8ff" stroke-width="2.6"
              stroke-linecap="round" opacity="0.3"/>
        <!-- o bicho esticado, disparando -->
        <path d="M22 30 L38 26 L52 30 L54 36 L38 40 L24 38 Z" fill="#3d8a5a"/>
        <path d="M38 26 L52 30 L54 36 L44 34 Z" fill="#4fa96f"/>
        <path d="M22 30 L28 29 L30 38 L24 38 Z" fill="#2f6b46"/>
        <!-- cauda esticada para trás -->
        <path d="M22 33 L12 30 L11 36 L22 37 Z" fill="#2a5c3d"/>
        <circle cx="49" cy="32" r="1.7" fill="#0b0e14"/>
        <!-- patas no impulso -->
        <path d="M30 40 L28 48 L33 47 L34 40 Z" fill="#2f6b46"/>
        <path d="M44 40 L43 49 L48 48 L48 39 Z" fill="#2f6b46"/>
      </svg>`,
  },
};

/**
 * Arte das poses.
 *
 * Cada ícone mostra a SILHUETA, porque é ela que a pose muda -- e é ela que
 * denuncia a lagartixa de longe, muito antes da cor. O chão aparece em todos
 * como uma linha, para dar a mesma referência de altura nos três e deixar a
 * comparação imediata: alta, comprida, compacta.
 */
export const ARTE_POSES = {
  EmPe: {
    nome: "Em pé",
    cor: "#ffc978",
    resumo: "Empinada nas traseiras. Enxerga por cima dos móveis, e é a silhueta mais visível.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M8 54 L56 54" stroke="#3f4759" stroke-width="2" stroke-linecap="round"/>
        <!-- corpo erguido, quase vertical -->
        <path d="M26 10 L38 12 L40 44 L28 46 Z" fill="#3d8a5a"/>
        <path d="M33 11 L38 12 L40 44 L34 45 Z" fill="#4fa96f"/>
        <!-- cabeça e olho -->
        <path d="M25 8 L39 10 L38 17 L26 16 Z" fill="#4fa96f"/>
        <circle cx="30" cy="12.5" r="1.8" fill="#0b0e14"/>
        <!-- dianteiras dobradas no peito -->
        <path d="M25 22 L20 28 L24 30 L28 25 Z" fill="#2f6b46"/>
        <path d="M40 22 L45 28 L41 30 L37 25 Z" fill="#2f6b46"/>
        <!-- traseiras firmes no chão -->
        <path d="M27 44 L24 54 L30 54 L32 45 Z" fill="#2f6b46"/>
        <path d="M38 44 L41 54 L35 54 L34 45 Z" fill="#2f6b46"/>
        <!-- a cauda descendo como tripé -->
        <path d="M39 40 L50 50 L46 54 L37 46 Z" fill="#2a5c3d"/>
      </svg>`,
  },

  Deitada: {
    nome: "Deitada",
    cor: "#78d0ff",
    resumo: "Espichada e baixa, patas ao longo do corpo. Some em rodapés e emendas do carpete.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M4 50 L60 50" stroke="#3f4759" stroke-width="2" stroke-linecap="round"/>
        <!-- corpo comprido e raso -->
        <path d="M12 38 L44 36 L46 46 L12 47 Z" fill="#3d8a5a"/>
        <path d="M12 38 L44 36 L45 41 L12 42 Z" fill="#4fa96f"/>
        <!-- cabeça na ponta -->
        <path d="M6 39 L14 37 L15 46 L6 46 Z" fill="#4fa96f"/>
        <circle cx="9.5" cy="41" r="1.8" fill="#0b0e14"/>
        <!-- cauda esticada, afinando -->
        <path d="M46 38 L57 40 L57 45 L46 45 Z" fill="#2a5c3d"/>
        <!-- patas AO LONGO do corpo, não abertas: é o que a diferencia -->
        <path d="M18 46 L15 49 L23 49 L24 46 Z" fill="#2f6b46"/>
        <path d="M36 46 L40 49 L32 49 L32 46 Z" fill="#2f6b46"/>
      </svg>`,
  },

  Encolhida: {
    nome: "Encolhida",
    cor: "#c69bff",
    resumo: "Enrolada, cabeça no flanco. Vira mais um objeto no meio da tralha.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M8 52 L56 52" stroke="#3f4759" stroke-width="2" stroke-linecap="round"/>
        <!-- corpo compacto, quase um seixo -->
        <path d="M20 26 L40 24 L46 34 L42 46 L22 47 L16 36 Z" fill="#3d8a5a"/>
        <path d="M30 25 L40 24 L46 34 L42 46 L34 46 Z" fill="#4fa96f"/>
        <!-- cabeça virada para dentro -->
        <path d="M20 34 L30 32 L31 42 L21 43 Z" fill="#4fa96f"/>
        <circle cx="24" cy="37" r="1.8" fill="#0b0e14"/>
        <!-- a cauda dando a volta por fora -->
        <path d="M44 30 C 56 32, 56 46, 44 48" stroke="#2a5c3d" stroke-width="6"
              fill="none" stroke-linecap="round"/>
        <path d="M44 30 C 53 32, 53 44, 45 46" stroke="#357049" stroke-width="2.6"
              fill="none" stroke-linecap="round"/>
      </svg>`,
  },
};

/** Ícone do botão que abre a paleta. */
export const ARTE_ACOES = `
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <!-- paleta -->
    <path d="M8 30 C 8 16, 22 8, 34 10 C 48 12, 56 22, 54 32
             C 52 42, 42 40, 40 46 C 38 52, 30 54, 22 50
             C 13 45, 8 38, 8 30 Z" fill="#2b3446"/>
    <path d="M34 10 C 48 12, 56 22, 54 32 C 52 42, 42 40, 40 46 L 34 34 Z"
          fill="#232b3a"/>
    <!-- furo do polegar -->
    <circle cx="26" cy="40" r="5" fill="#0b0e14"/>
    <!-- tintas -->
    <circle cx="20" cy="24" r="4.2" fill="#7ee0a8"/>
    <circle cx="32" cy="19" r="4.2" fill="#ffd166"/>
    <circle cx="43" cy="24" r="4.2" fill="#ff8fa3"/>
    <circle cx="46" cy="34" r="3.6" fill="#c89bff"/>
    <!-- pincel -->
    <path d="M40 56 L54 42 L58 46 L44 60 Z" fill="#8a6b4a"/>
    <path d="M54 42 L58 46 L61 43 L57 39 Z" fill="#b9c3d4"/>
    <path d="M40 56 L44 60 L37 62 Z" fill="#6ea8fe"/>
  </svg>`;

/**
 * Arte das habilidades de quem caça.
 *
 * Mesma gramática da lagartixa -- chapado, facetado, sem contorno fino --, mas
 * a paleta é fria e metálica de propósito: âmbar, aço e vermelho de aviso,
 * contra o verde orgânico do outro lado. Numa barra rápida, a cor decide antes
 * do desenho, e ninguém deve confundir de quem é o poder.
 */
export const ARTE_CACADOR = {
  lanterna: {
    nome: "Lanterna",
    cor: "#ffd166",
    resumo: "Cone de luz com bateria. Só recarrega com as luzes do prédio acesas.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- corpo da lanterna, apontando para a direita -->
        <path d="M8 26 L22 26 L22 38 L8 38 Z" fill="#39445a"/>
        <path d="M8 26 L22 26 L22 31 L8 31 Z" fill="#4b5872"/>
        <path d="M22 22 L30 26 L30 38 L22 42 Z" fill="#5a6a86"/>
        <path d="M22 22 L30 26 L30 30 L22 28 Z" fill="#78889f"/>
        <!-- lente -->
        <path d="M30 26 L30 38 L34 40 L34 24 Z" fill="#ffd166"/>
        <!-- o cone, em três camadas que abrem -->
        <path d="M34 24 L34 40 L60 52 L60 12 Z" fill="#ffd166" opacity="0.16"/>
        <path d="M34 27 L34 37 L58 45 L58 19 Z" fill="#ffd166" opacity="0.24"/>
        <path d="M34 30 L34 34 L56 38 L56 26 Z" fill="#ffe9a8" opacity="0.5"/>
      </svg>`,
  },

  batida: {
    nome: "Bater na parede",
    cor: "#ff9f43",
    resumo: "O estrondo tira o silêncio de quem está parada. Ela assobia quase na hora.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- a parede -->
        <path d="M40 6 L58 6 L58 58 L40 58 Z" fill="#39445a"/>
        <path d="M40 6 L49 6 L49 58 L40 58 Z" fill="#2c3547"/>
        <!-- o punho -->
        <path d="M6 24 L22 20 L30 26 L30 38 L20 42 L6 38 Z" fill="#c9a227"/>
        <path d="M22 20 L30 26 L30 38 L24 34 Z" fill="#ffd166"/>
        <path d="M6 24 L12 22 L13 40 L6 38 Z" fill="#9c7d1c"/>
        <!-- o impacto -->
        <path d="M32 32 L40 26 L38 32 L44 30 L36 40 L38 34 Z" fill="#ff9f43"/>
        <!-- ondas atravessando -->
        <path d="M50 22 A 12 12 0 0 1 50 42" stroke="#ff9f43" stroke-width="2.6"
              fill="none" stroke-linecap="round" opacity="0.85"/>
        <path d="M56 16 A 20 20 0 0 1 56 48" stroke="#ff9f43" stroke-width="2.6"
              fill="none" stroke-linecap="round" opacity="0.45"/>
      </svg>`,
  },

  armadilha: {
    nome: "Armadilha",
    cor: "#6ea8fe",
    resumo: "Apita se algo se mexer a 6 m, e FECHA em quem encostar. Some ao disparar; duas de cada vez.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- base no chão -->
        <path d="M14 48 L50 48 L44 56 L20 56 Z" fill="#2c3547"/>
        <path d="M14 48 L50 48 L46 52 L18 52 Z" fill="#39445a"/>
        <!-- corpo -->
        <path d="M22 26 L42 26 L44 48 L20 48 Z" fill="#4b5872"/>
        <path d="M22 26 L32 26 L32 48 L20 48 Z" fill="#39445a"/>
        <!-- olho -->
        <circle cx="32" cy="36" r="5.6" fill="#0b0e14"/>
        <circle cx="32" cy="36" r="3" fill="#6ea8fe"/>
        <!-- as garras, abertas dos dois lados: é o que diz "isto prende" -->
        <path d="M20 46 L10 34 L6 38 L14 50 Z" fill="#8fc0ff"/>
        <path d="M44 46 L54 34 L58 38 L50 50 Z" fill="#8fc0ff"/>
        <!-- leque de detecção -->
        <path d="M32 26 L12 10 L52 10 Z" fill="#6ea8fe" opacity="0.18"/>
        <path d="M24 18 A 12 12 0 0 1 40 18" stroke="#6ea8fe" stroke-width="2.4"
              fill="none" stroke-linecap="round" opacity="0.8"/>
        <path d="M18 12 A 20 20 0 0 1 46 12" stroke="#6ea8fe" stroke-width="2.4"
              fill="none" stroke-linecap="round" opacity="0.42"/>
      </svg>`,
  },

  rede: {
    nome: "Rede",
    cor: "#b0ffe0",
    resumo: "Tiro largo que prende por instantes. Não fere — é a resposta ao arranque.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- a malha, um losango de cordas -->
        <path d="M32 6 L58 32 L32 58 L6 32 Z" fill="#1c3a33" opacity="0.75"/>
        <path d="M32 6 L58 32 L32 58 L6 32 Z" fill="none"
              stroke="#b0ffe0" stroke-width="2.4"/>
        <path d="M19 19 L45 45 M45 19 L19 45" stroke="#b0ffe0" stroke-width="1.8"
              opacity="0.85"/>
        <path d="M32 6 L32 58 M6 32 L58 32" stroke="#b0ffe0" stroke-width="1.8"
              opacity="0.85"/>
        <!-- pesos nas pontas -->
        <circle cx="32" cy="6" r="3.2" fill="#7fe0c0"/>
        <circle cx="58" cy="32" r="3.2" fill="#7fe0c0"/>
        <circle cx="32" cy="58" r="3.2" fill="#7fe0c0"/>
        <circle cx="6" cy="32" r="3.2" fill="#7fe0c0"/>
      </svg>`,
  },

  disjuntor: {
    nome: "Religar o disjuntor",
    cor: "#ffe066",
    resumo: "Devolve a luz ao prédio. Leva um tempo parado, e faz barulho.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- quadro -->
        <path d="M14 8 L50 8 L50 56 L14 56 Z" fill="#39445a"/>
        <path d="M14 8 L32 8 L32 56 L14 56 Z" fill="#2c3547"/>
        <path d="M18 12 L46 12 L46 52 L18 52 Z" fill="#1b2130"/>
        <!-- as chaves, duas desligadas e uma subindo -->
        <path d="M22 18 L30 18 L30 26 L22 26 Z" fill="#5a6a86"/>
        <path d="M34 18 L42 18 L42 26 L34 26 Z" fill="#5a6a86"/>
        <path d="M22 32 L30 32 L30 40 L22 40 Z" fill="#5a6a86"/>
        <path d="M34 32 L42 32 L42 40 L34 40 Z" fill="#ffe066"/>
        <!-- o raio, saindo do quadro -->
        <path d="M36 42 L46 42 L40 50 L50 50 L32 62 L37 51 L30 51 Z" fill="#ffe066"/>
      </svg>`,
  },

  po: {
    nome: "Pó revelador",
    cor: "#e6d5ff",
    resumo: "Assenta num cômodo. Quem atravessar deixa pegadas por alguns segundos.",
    svg: `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <!-- a nuvem baixa -->
        <path d="M6 40 C 12 32, 22 34, 26 38 C 30 30, 44 30, 48 38
                 C 56 36, 60 44, 56 48 L 8 48 C 4 46, 4 42, 6 40 Z"
              fill="#e6d5ff" opacity="0.32"/>
        <!-- grãos suspensos -->
        <circle cx="18" cy="26" r="2" fill="#e6d5ff" opacity="0.8"/>
        <circle cx="34" cy="20" r="2.6" fill="#e6d5ff" opacity="0.65"/>
        <circle cx="47" cy="26" r="1.8" fill="#e6d5ff" opacity="0.55"/>
        <!-- as pegadas que ele revela -->
        <path d="M14 54 L20 52 L21 57 L15 59 Z" fill="#c8a8ff"/>
        <path d="M26 51 L32 49 L33 54 L27 56 Z" fill="#c8a8ff" opacity="0.8"/>
        <path d="M38 54 L44 52 L45 57 L39 59 Z" fill="#c8a8ff" opacity="0.55"/>
        <path d="M50 51 L56 49 L57 54 L51 56 Z" fill="#c8a8ff" opacity="0.3"/>
      </svg>`,
  },
};
