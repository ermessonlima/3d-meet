/**
 * Painel de conversa com o NPC.
 *
 * O histórico vive aqui e vai inteiro em cada requisição -- a API de chat não
 * guarda estado entre chamadas, então "memória" é literalmente reenviar o que
 * já foi dito. `MAX_TURNOS` limita isso: sem teto, uma conversa longa cresce o
 * custo de cada mensagem indefinidamente.
 */
const MAX_TURNOS = 20;

export class Chat {
  constructor({ persona, nome }) {
    this.persona = persona;
    this.nome = nome;
    this.mensagens = [];
    this.ocupado = false;

    this.el = document.getElementById("chat");
    this.elLog = this.el.querySelector(".log");
    this.elForm = this.el.querySelector("form");
    this.elEntrada = this.el.querySelector("input");
    this.elNome = this.el.querySelector(".nome");
    this.elFechar = this.el.querySelector(".fechar");

    this.elNome.textContent = nome;
    this.aoFechar = () => {};

    this.elForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.enviar(this.elEntrada.value);
    });
    this.elFechar.addEventListener("click", () => this.aoFechar());

    // As teclas de movimento não podem vazar para o jogo enquanto se digita,
    // senão o personagem sai andando a cada "w" da frase.
    for (const evento of ["keydown", "keyup", "keypress"]) {
      this.el.addEventListener(evento, (e) => {
        if (e.key === "Escape") {
          this.aoFechar();
          return;
        }
        e.stopPropagation();
      });
    }
  }

  get aberto() {
    return !this.el.hidden;
  }

  abrir() {
    this.el.hidden = false;
    this.elEntrada.disabled = false;
    this.elEntrada.focus();
    if (!this.mensagens.length) {
      this._pintar("npc", `Oi. Precisa de alguma coisa?`);
      this.mensagens.push({
        role: "assistant",
        content: "Oi. Precisa de alguma coisa?",
      });
    }
  }

  fechar() {
    this.el.hidden = true;
    this.elEntrada.blur();
  }

  _pintar(quem, texto) {
    const linha = document.createElement("p");
    linha.className = `msg ${quem}`;
    if (quem === "npc") {
      const rotulo = document.createElement("strong");
      rotulo.textContent = `${this.nome}: `;
      linha.append(rotulo);
    }
    linha.append(document.createTextNode(texto));
    this.elLog.append(linha);
    this.elLog.scrollTop = this.elLog.scrollHeight;
    return linha;
  }

  async enviar(bruto) {
    const texto = bruto.trim();
    if (!texto || this.ocupado) return;

    this.elEntrada.value = "";
    this._pintar("eu", texto);
    this.mensagens.push({ role: "user", content: texto });

    this.ocupado = true;
    this.elEntrada.disabled = true;
    const pensando = this._pintar("npc pensando", "…");

    try {
      const resposta = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persona: this.persona,
          mensagens: this.mensagens.slice(-MAX_TURNOS * 2),
        }),
      });

      const dados = await resposta.json().catch(() => ({}));
      pensando.remove();

      if (!resposta.ok) {
        this._pintar("erro", dados.erro ?? `falha ${resposta.status}`);
      } else {
        this._pintar("npc", dados.texto);
        this.mensagens.push({ role: "assistant", content: dados.texto });
      }
    } catch (erro) {
      pensando.remove();
      this._pintar("erro", `sem resposta do servidor: ${erro.message}`);
    } finally {
      this.ocupado = false;
      this.elEntrada.disabled = false;
      this.elEntrada.focus();
    }
  }
}
