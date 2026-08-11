/**
 * Chat lateral da sala.
 *
 * Diferente do balão sobre a cabeça, que é efêmero: aqui fica o histórico, e
 * quem entra no meio da conversa recebe as últimas mensagens do servidor. Os
 * dois vivem juntos de propósito -- o balão diz *quem* falou no espaço, o
 * painel diz *o que* foi dito.
 */

const HORA = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
});

export class PainelChat {
  constructor() {
    this.el = document.getElementById("chat-sala");
    this.elLog = this.el.querySelector(".log");
    this.elForm = this.el.querySelector("form");
    this.elEntrada = this.el.querySelector("input");
    this.elAlternar = document.getElementById("alternar-chat");
    this.elNaoLidas = this.elAlternar.querySelector(".nao-lidas");

    this.aoEnviar = () => {};
    this.naoLidas = 0;

    this.elForm.addEventListener("submit", (evento) => {
      evento.preventDefault();
      const texto = this.elEntrada.value.trim();
      if (texto) this.aoEnviar(texto);
      this.elEntrada.value = "";
    });

    this.elAlternar.addEventListener("click", () => this.alternar());

    // Teclas de movimento não podem vazar para o jogo enquanto se digita.
    for (const tipo of ["keydown", "keyup", "keypress"]) {
      this.el.addEventListener(tipo, (evento) => {
        if (evento.key === "Escape") {
          this.elEntrada.blur();
          return;
        }
        evento.stopPropagation();
      });
    }

    // O jogo precisa saber se o foco está no campo, para congelar o teclado.
    this.elEntrada.addEventListener("focus", () => {
      this.digitando = true;
    });
    this.elEntrada.addEventListener("blur", () => {
      this.digitando = false;
    });
    this.digitando = false;
  }

  get aberto() {
    return !this.el.hidden;
  }

  alternar(forcar) {
    const abrir = forcar === undefined ? !this.aberto : forcar;
    this.el.hidden = !abrir;
    this.elAlternar.setAttribute("aria-pressed", String(abrir));
    // O painel ocupa a faixa direita da tela; sem isto a barra de mídia fica
    // por baixo dele e os botões viram alvos inclicáveis.
    document.body.classList.toggle("chat-aberto", abrir);
    if (abrir) {
      this.naoLidas = 0;
      this._pintarContador();
      this.elLog.scrollTop = this.elLog.scrollHeight;
    }
  }

  focar() {
    this.alternar(true);
    this.elEntrada.focus();
  }

  _pintarContador() {
    this.elNaoLidas.textContent = this.naoLidas > 9 ? "9+" : String(this.naoLidas);
    this.elNaoLidas.hidden = this.naoLidas === 0;
  }

  /** Preenche o histórico recebido ao entrar na sala. */
  carregarHistorico(mensagens, meuId) {
    for (const m of mensagens) this.adicionar(m, meuId, true);
    this.elLog.scrollTop = this.elLog.scrollHeight;
  }

  adicionar(fala, meuId, silencioso = false) {
    // Só rola junto se já estava no fim: senão, ler o histórico ficaria
    // impossível com gente falando.
    const noFim =
      this.elLog.scrollHeight - this.elLog.scrollTop - this.elLog.clientHeight < 40;

    const linha = document.createElement("div");
    linha.className = "msg" + (fala.id === meuId ? " eu" : "");

    const cabeca = document.createElement("div");
    cabeca.className = "cabeca";

    const nome = document.createElement("span");
    nome.className = "quem";
    nome.textContent = fala.id === meuId ? "você" : fala.nome;
    nome.style.color = fala.cor ?? "var(--acento)";

    const hora = document.createElement("time");
    hora.textContent = HORA.format(fala.em ? new Date(fala.em) : new Date());

    cabeca.append(nome, hora);

    const corpo = document.createElement("p");
    corpo.textContent = fala.texto;

    linha.append(cabeca, corpo);
    this.elLog.append(linha);

    if (noFim) this.elLog.scrollTop = this.elLog.scrollHeight;

    if (!silencioso && !this.aberto && fala.id !== meuId) {
      this.naoLidas += 1;
      this._pintarContador();
    }
  }

  avisoDoSistema(texto) {
    const linha = document.createElement("p");
    linha.className = "sistema";
    linha.textContent = texto;
    this.elLog.append(linha);
    this.elLog.scrollTop = this.elLog.scrollHeight;
  }
}
