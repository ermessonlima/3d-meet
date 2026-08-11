/**
 * Ícones da interface (Lucide).
 *
 * Importamos ícone a ícone, não o pacote inteiro: o Lucide tem 3500+ e o
 * bundler só carrega os que estão nomeados aqui.
 *
 * Cada ícone é um `<svg>` com `currentColor`, então a cor vem do CSS do
 * elemento pai -- é isso que permite um botão inteiro mudar de cor no hover
 * ou no estado ativo sem que o ícone precise saber de nada.
 *
 * Substituíram emoji. Emoji são renderizados pela fonte do sistema: mudam de
 * desenho entre macOS, Windows e Android, não herdam cor, não alinham com o
 * texto ao lado e não têm peso de traço consistente.
 */
import {
  Camera,
  CameraOff,
  ChevronRight,
  CornerDownLeft,
  Copy,
  Check,
  LogIn,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MonitorUp,
  Users,
  X,
  createElement,
} from "lucide";

const CATALOGO = {
  camera: Camera,
  "camera-off": CameraOff,
  chevron: ChevronRight,
  enviar: CornerDownLeft,
  copiar: Copy,
  ok: Check,
  entrar: LogIn,
  chat: MessageSquare,
  mic: Mic,
  "mic-off": MicOff,
  monitor: Monitor,
  "monitor-off": MonitorOff,
  "compartilhar-tela": MonitorUp,
  pessoas: Users,
  fechar: X,
};

/**
 * Cria o SVG de um ícone.
 *
 * `tamanho` em px acompanha a caixa; a espessura sobe um pouco nos tamanhos
 * pequenos, senão o traço some contra o fundo escuro.
 */
export function icone(nome, { tamanho = 16, classe = "" } = {}) {
  const definicao = CATALOGO[nome];
  if (!definicao) {
    console.warn("[ícones] desconhecido:", nome);
    return document.createComment(`ícone ${nome}`);
  }

  const svg = createElement(definicao);
  svg.setAttribute("width", String(tamanho));
  svg.setAttribute("height", String(tamanho));
  svg.setAttribute("stroke-width", tamanho <= 16 ? "2" : "1.75");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (classe) svg.setAttribute("class", classe);
  return svg;
}

/**
 * Preenche os `<i data-icone="nome">` do HTML.
 *
 * Deixa o markup declarativo: o HTML diz qual ícone quer, e este módulo
 * resolve tudo de uma vez, sem espalhar chamadas de criação pelo código.
 */
export function montarIcones(raiz = document) {
  for (const marca of raiz.querySelectorAll("[data-icone]")) {
    const tamanho = Number(marca.dataset.tamanho) || 16;
    marca.replaceChildren(icone(marca.dataset.icone, { tamanho }));
  }
}

/** Troca o ícone de um elemento já montado (mic ↔ mic-off, por exemplo). */
export function trocarIcone(elemento, nome, tamanho = 16) {
  if (!elemento) return;
  elemento.dataset.icone = nome;
  elemento.replaceChildren(icone(nome, { tamanho }));
}
