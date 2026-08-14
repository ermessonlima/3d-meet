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

export const PAPEIS = [
  { id: "pessoa", rotulo: "Pessoa", nota: "Anda pelo escritório com uma arma de brinquedo." },
  { id: "lagartixa", rotulo: "Lagartixa", nota: "Pequena e rápida. Esconde-se e muda de cor." },
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
      papel: PAPEIS.some((p) => p.id === salvo.papel) ? salvo.papel : "pessoa",
    };
  } catch {
    return { nome: "", personagem: PERSONAGENS[0].id, cor: CORES[0], papel: "pessoa" };
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

    this.elPapeis = this.el.querySelector("#lb-papeis");
    this.elBlocoPersonagem = this.el.querySelector("#lb-bloco-personagem");
    this.elSemCorpo = this.el.querySelector("#lb-sem-corpo");
    this.elEcoNome = this.el.querySelector("#lb-eco-nome");
    this.elEcoCor = this.el.querySelector("#lb-eco-cor");
    this.elEcoPapel = this.el.querySelector("#lb-eco-papel");
    this.elEcoNota = this.el.querySelector("#lb-eco-nota");
    /** Prévia 3D; preenchida por `montarPalco`, opcional se o WebGL falhar. */
    this.cena = null;

    this._montarPapeis();
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
    this.elNome.addEventListener("input", () => this._ecoar());

    const daUrl = new URLSearchParams(location.search).get("sala");
    if (daUrl) {
      this.elCodigo.value = daUrl.toUpperCase().slice(0, 12);
      this._trocarAba("entrar");
    }
  }

  /**
   * Volta à escolha de personagem já apontando para uma sala.
   *
   * Usado pela "nova partida": o código não é segredo (ele vai no link de
   * convite), então prefixá-lo poupa digitação. A SENHA não vem junto de
   * propósito -- guardá-la em qualquer canto do navegador para evitar um
   * campo a preencher é exatamente o que não se faz com senha.
   */
  prepararEntrada(codigo) {
    if (!codigo) return;
    this.elCodigo.value = String(codigo).toUpperCase().slice(0, 12);
    this._trocarAba("entrar");
  }

  /**
   * Deixa um papel já marcado na volta à escolha.
   *
   * Usado pelo "trocar de lado" da tela de fim: depois de uma rodada, querer
   * experimentar o outro papel é o pedido mais comum, e fazer disso um clique
   * em vez de dois é o que separa "trocar de lado" de "escolher time".
   */
  prepararPapel(papel) {
    const botao = this.el.querySelector(`[data-papel="${papel}"]`);
    if (botao) botao.click();
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

  /**
   * Papel: pessoa ou lagartixa.
   *
   * Escolher lagartixa esconde a grade de personagens -- ela não usa nenhum
   * dos seis corpos, e deixar a grade visível sugeriria que a escolha ali
   * ainda vale para alguma coisa.
   */
  _montarPapeis() {
    for (const papel of PAPEIS) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "papel";
      botao.dataset.papel = papel.id;
      botao.setAttribute("aria-pressed", String(papel.id === this.perfil.papel));

      const titulo = document.createElement("strong");
      titulo.textContent = papel.rotulo;
      const nota = document.createElement("span");
      nota.textContent = papel.nota;
      botao.append(titulo, nota);

      botao.addEventListener("click", () => {
        this.perfil.papel = papel.id;
        for (const outro of this.elPapeis.children) {
          outro.setAttribute("aria-pressed", String(outro.dataset.papel === papel.id));
        }
        this._aplicarPapel();
      });
      this.elPapeis.append(botao);
    }
    this._aplicarPapel();
  }

  _aplicarPapel() {
    const ehPessoa = this.perfil.papel === "pessoa";
    this.elBlocoPersonagem.hidden = !ehPessoa;
    // A lagartixa não usa nenhum dos seis corpos; no lugar da grade entra a
    // explicação, senão a seção "corpo" ficaria vazia sem dizer por quê.
    this.elSemCorpo.hidden = ehPessoa;
    this.cena?.trocarPapel(this.perfil.papel);
    this._ecoar();
  }

  /**
   * Espelha as escolhas na coluna do personagem.
   *
   * O formulário fica à direita e o corpo à esquerda; sem o eco, quem olha o
   * modelo não vê de quem ele é.
   */
  _ecoar() {
    const papel = PAPEIS.find((p) => p.id === this.perfil.papel) ?? PAPEIS[0];
    this.elEcoNome.textContent = this.elNome.value.trim() || "Sem nome";
    this.elEcoPapel.textContent = papel.rotulo;
    this.elEcoNota.textContent = papel.nota;
    this.elEcoCor.style.background = this.perfil.cor;
  }

  /**
   * Liga a prévia 3D.
   *
   * Falha em silêncio de propósito: sem WebGL, ou com o modelo faltando, o
   * lobby continua sendo um formulário que funciona. Travar a entrada no jogo
   * porque a vitrine não carregou seria trocar o essencial pelo enfeite.
   */
  async montarPalco() {
    try {
      const { montarLobbyCena } = await import("./lobbyCena.js");
      this.cena = await montarLobbyCena(this.el.querySelector("#lb-palco"), {
        personagem: this.perfil.personagem,
        papel: this.perfil.papel,
      });
      this.cena.pintar(this.perfil.cor);
    } catch (erro) {
      console.warn("[lobby] prévia 3D indisponível:", erro);
    }
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
        this.cena?.trocarPersonagem(personagem.id);
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
        // A cor de destaque é também a cor da lagartixa; pintar a prévia deixa
        // isso óbvio sem precisar de legenda.
        this.cena?.pintar(cor);
        this._ecoar();
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
    this._ecoar();
    if (!this.cena) this.montarPalco();
  }

  esconder() {
    this.el.hidden = true;
    // Dois renderizadores WebGL vivos é desperdício, e o do jogo é que importa.
    this.cena?.encerrar();
    this.cena = null;
  }
}
