/**
 * Tela inicial: identidade do jogador e escolha de sala.
 *
 * Guarda o perfil no localStorage para não obrigar a reescrever nome e
 * personagem a cada partida. Senha de sala NÃO é guardada: seria persistir
 * credencial de outra pessoa em disco por conveniência de digitação.
 */

export const PERSONAGENS = [
  { id: "Business_Male_01", rotulo: "Executivo" },
  { id: "Business_Female_01", rotulo: "Executiva" },
  { id: "Developer_Male_01", rotulo: "Dev" },
  { id: "Developer_Female_01", rotulo: "Dev" },
  { id: "Boss_Male_01", rotulo: "Chefe" },
  { id: "Security_Female_01", rotulo: "Segurança" },
];

// Precisa bater com CORES_VALIDAS em tools/multiplayer.js: o servidor recusa
// qualquer outra e cai no padrão.
export const CORES = [
  "#6ea8fe", "#7ee0a8", "#ffd166", "#ff8fa3", "#c89bff", "#5fe0d8",
];

const CHAVE = "poligono.perfil";

function carregarPerfil() {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
    return {
      nome: typeof salvo.nome === "string" ? salvo.nome.slice(0, 20) : "",
      personagem: PERSONAGENS.some((p) => p.id === salvo.personagem)
        ? salvo.personagem
        : PERSONAGENS[0].id,
      cor: CORES.includes(salvo.cor) ? salvo.cor : CORES[0],
    };
  } catch {
    return { nome: "", personagem: PERSONAGENS[0].id, cor: CORES[0] };
  }
}

function salvarPerfil(perfil) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(perfil));
  } catch {
    // Modo privado do navegador pode recusar; não é motivo para travar o jogo.
  }
}

export class Lobby {
  constructor() {
    this.perfil = carregarPerfil();
    this.el = document.getElementById("lobby");
    this.elNome = this.el.querySelector("#lb-nome");
    this.elPersonagens = this.el.querySelector("#lb-personagens");
    this.elCores = this.el.querySelector("#lb-cores");
    this.elSalaNome = this.el.querySelector("#lb-sala-nome");
    this.elSenhaCriar = this.el.querySelector("#lb-senha-criar");
    this.elCodigo = this.el.querySelector("#lb-codigo");
    this.elSenhaEntrar = this.el.querySelector("#lb-senha-entrar");
    this.elErro = this.el.querySelector("#lb-erro");
    this.elBotoes = [...this.el.querySelectorAll("button")];

    this.aoConfirmar = async () => {};

    this._montarPersonagens();
    this._montarCores();
    this.elNome.value = this.perfil.nome;

    this.el.querySelectorAll("[data-aba]").forEach((botao) => {
      botao.addEventListener("click", () => this._trocarAba(botao.dataset.aba));
    });

    this.el.querySelector("#lb-criar").addEventListener("click", () => {
      this._confirmar({
        tipo: "criar",
        nome: this.elSalaNome.value,
        senha: this.elSenhaCriar.value,
      });
    });

    this.el.querySelector("#lb-entrar").addEventListener("click", () => {
      this._confirmar({
        tipo: "entrar",
        codigo: this.elCodigo.value,
        senha: this.elSenhaEntrar.value,
      });
    });

    // Enter em qualquer campo aciona o botão da aba visível.
    this.el.addEventListener("keydown", (evento) => {
      if (evento.key !== "Enter") return;
      evento.preventDefault();
      const aba = this.el.querySelector(".painel:not([hidden])");
      aba?.querySelector("button[id^='lb-']")?.click();
    });

    // Um código na URL (?sala=ABC123) pré-preenche o convite.
    const daUrl = new URLSearchParams(location.search).get("sala");
    if (daUrl) {
      this.elCodigo.value = daUrl.toUpperCase().slice(0, 12);
      this._trocarAba("entrar");
    }
  }

  _trocarAba(qual) {
    for (const botao of this.el.querySelectorAll("[data-aba]")) {
      botao.setAttribute("aria-selected", String(botao.dataset.aba === qual));
    }
    for (const painel of this.el.querySelectorAll(".painel")) {
      painel.hidden = painel.dataset.painel !== qual;
    }
    this._erro("");
  }

  _montarPersonagens() {
    for (const personagem of PERSONAGENS) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "carta";
      botao.dataset.id = personagem.id;
      botao.setAttribute(
        "aria-pressed",
        String(personagem.id === this.perfil.personagem),
      );

      const img = document.createElement("img");
      img.src = `/retratos/${personagem.id}.png`;
      img.alt = "";
      img.loading = "lazy";

      const rotulo = document.createElement("span");
      rotulo.textContent = personagem.rotulo;

      botao.append(img, rotulo);
      botao.addEventListener("click", () => {
        this.perfil.personagem = personagem.id;
        for (const outro of this.elPersonagens.children) {
          outro.setAttribute("aria-pressed", String(outro.dataset.id === personagem.id));
        }
      });
      this.elPersonagens.append(botao);
    }
  }

  _montarCores() {
    for (const cor of CORES) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "cor";
      botao.style.setProperty("--c", cor);
      botao.dataset.cor = cor;
      botao.setAttribute("aria-label", `Cor ${cor}`);
      botao.setAttribute("aria-pressed", String(cor === this.perfil.cor));
      botao.addEventListener("click", () => {
        this.perfil.cor = cor;
        for (const outro of this.elCores.children) {
          outro.setAttribute("aria-pressed", String(outro.dataset.cor === cor));
        }
      });
      this.elCores.append(botao);
    }
  }

  _erro(texto) {
    this.elErro.textContent = texto;
    this.elErro.hidden = !texto;
  }

  _ocupado(sim) {
    for (const botao of this.elBotoes) botao.disabled = sim;
  }

  async _confirmar(pedido) {
    const nome = this.elNome.value.trim();
    if (!nome) {
      this._erro("Escolha um nome.");
      this.elNome.focus();
      return;
    }
    if (pedido.tipo === "entrar" && !pedido.codigo.trim()) {
      this._erro("Informe o código da sala.");
      this.elCodigo.focus();
      return;
    }

    this.perfil.nome = nome;
    salvarPerfil(this.perfil);

    this._erro("");
    this._ocupado(true);
    try {
      await this.aoConfirmar({ ...pedido, perfil: { ...this.perfil } });
    } catch (erro) {
      this._erro(erro.message);
    } finally {
      this._ocupado(false);
    }
  }

  mostrar() {
    this.el.hidden = false;
    this.elNome.focus();
  }

  esconder() {
    this.el.hidden = true;
  }
}
