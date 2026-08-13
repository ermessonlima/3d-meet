/**
 * Registro de salas em memória.
 *
 * Separado do transporte de propósito: aqui não há WebSocket nenhum, só as
 * regras (criar, entrar, expirar). Isso deixa as decisões de segurança em um
 * lugar só e testáveis sem subir servidor.
 *
 * Estado em memória significa que reiniciar o servidor apaga as salas. Para um
 * jogo de sessão isso é o comportamento certo -- sala é efêmera por natureza.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);

const MAX_SALAS = 200;
const MAX_JOGADORES = 12;
const TEMPO_VAZIA_MS = 5 * 60 * 1000;   // sala sem ninguém morre em 5 min
const CODIGO_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I/O/0/1

export const LIMITES = {
  nome: 20,
  nomeSala: 32,
  senha: 64,
  jogadores: MAX_JOGADORES,
};

/**
 * A senha é guardada como scrypt(salt), nunca em texto puro.
 *
 * Alguém poderia argumentar que senha de sala de jogo não vale o esforço. Vale:
 * as pessoas reciclam senhas, e um dump de memória ou log acidental não deve
 * entregar nada reutilizável em outro lugar.
 */
async function derivar(senha, salt) {
  return scrypt(senha, salt, 32, { N: 16384, r: 8, p: 1 });
}

async function criarHash(senha) {
  const salt = randomBytes(16);
  return { salt, hash: await derivar(senha, salt) };
}

async function conferir(senha, guardada) {
  if (!guardada) return true; // sala sem senha
  const tentativa = await derivar(senha, guardada.salt);
  // timingSafeEqual em vez de === : comparar byte a byte com saída antecipada
  // vaza, pelo tempo de resposta, quantos bytes iniciais estavam certos.
  return (
    tentativa.length === guardada.hash.length &&
    timingSafeEqual(tentativa, guardada.hash)
  );
}

function gerarCodigo() {
  let saida = "";
  const bytes = randomBytes(6);
  for (const b of bytes) saida += CODIGO_ALFABETO[b % CODIGO_ALFABETO.length];
  return saida;
}

function texto(valor, max) {
  return String(valor ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export class RegistroDeSalas {
  constructor() {
    this.salas = new Map();
    this._limpeza = setInterval(() => this.expirarVazias(), 60_000);
    this._limpeza.unref?.();
  }

  expirarVazias() {
    const agora = Date.now();
    for (const [codigo, sala] of this.salas) {
      if (sala.jogadores.size === 0 && agora - sala.vaziaDesde > TEMPO_VAZIA_MS) {
        this.salas.delete(codigo);
      }
    }
  }

  async criar({ nome, senha }) {
    if (this.salas.size >= MAX_SALAS) {
      throw new ErroDeSala("limite de salas atingido, tente mais tarde");
    }

    const rotulo = texto(nome, LIMITES.nomeSala) || "Sala sem nome";
    const bruta = String(senha ?? "");
    if (bruta.length > LIMITES.senha) {
      throw new ErroDeSala("senha longa demais");
    }

    let codigo;
    do {
      codigo = gerarCodigo();
    } while (this.salas.has(codigo));

    const sala = {
      codigo,
      nome: rotulo,
      protegida: bruta.length > 0,
      senha: bruta.length > 0 ? await criarHash(bruta) : null,
      jogadores: new Map(),
      vaziaDesde: Date.now(),
      criadaEm: Date.now(),
      // Ciclo da partida. Quem cuida das trocas é o multiplayer; aqui só
      // nasce parado, porque uma sala vazia não tem rodada em andamento.
      fase: "espera",
      faseAte: 0,
      // Quem manda começar a rodada. Definido na primeira entrada e repassado
      // se essa pessoa sair -- sem isso a sala ficaria sem ninguém que possa
      // dar a partida.
      anfitriao: null,
    };
    this.salas.set(codigo, sala);
    return sala;
  }

  /**
   * Valida a entrada. Devolve a sala ou lança ErroDeSala.
   *
   * Sala inexistente e senha errada dão a MESMA mensagem de propósito: separá-las
   * transformaria o endpoint num oráculo para descobrir quais códigos existem.
   */
  async entrar({ codigo, senha }) {
    const chave = texto(codigo, 12).toUpperCase();
    const sala = this.salas.get(chave);

    const generico = "sala não encontrada ou senha incorreta";
    if (!sala) {
      // Gasta um scrypt mesmo sem sala, para o tempo de resposta não denunciar
      // a diferença entre "não existe" e "senha errada".
      await derivar(String(senha ?? ""), randomBytes(16));
      throw new ErroDeSala(generico);
    }
    if (!(await conferir(String(senha ?? ""), sala.senha))) {
      throw new ErroDeSala(generico);
    }
    if (sala.jogadores.size >= MAX_JOGADORES) {
      throw new ErroDeSala("sala cheia");
    }
    return sala;
  }

  adicionar(sala, jogador) {
    sala.jogadores.set(jogador.id, jogador);
  }

  remover(sala, id) {
    sala.jogadores.delete(id);
    if (sala.jogadores.size === 0) sala.vaziaDesde = Date.now();
  }

  encerrar() {
    clearInterval(this._limpeza);
  }
}

export class ErroDeSala extends Error {}

export const _internos = { texto, gerarCodigo, conferir, criarHash };
