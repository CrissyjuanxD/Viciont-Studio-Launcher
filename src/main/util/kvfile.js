'use strict';
// Archivos de ajustes "clave:valor" o "clave=valor" (options.txt, optionsof.txt, optionsshaders.txt…).
// Se fusionan por clave: al actualizar una instancia, el jugador recibe solo los ajustes que cambió
// el administrador y conserva todo lo demás (teclas, volumen, FOV…).

const LINE_RE = /^([^:=]+)([:=])(.*)$/;

// Ajustes que cada jugador suele cambiar a su gusto: al publicar salen desmarcados por defecto.
const PERSONAL_RE = /^(key_|soundCategory_)/;
const PERSONAL = new Set(['fov', 'gamma', 'mouseSensitivity', 'fullscreen', 'overrideWidth', 'overrideHeight', 'lastServer',
  'tutorialStep', 'joinedFirstServer', 'onboardAccessibility', 'skipMultiplayerWarning', 'version', 'maxFps',
  'renderDistance', 'simulationDistance', 'guiScale', 'chatScale', 'chatWidth', 'chatHeightFocused', 'chatHeightUnfocused']);

const isPersonal = (key) => PERSONAL_RE.test(key) || PERSONAL.has(key);

function parse(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const trailing = /\r?\n$/.test(src);
  const lines = src.replace(/\r?\n$/, '').split(/\r?\n/);
  const entries = [];
  const index = new Map();
  for (const raw of src ? lines : []) {
    const m = LINE_RE.exec(raw);
    if (!m || !m[1].trim()) { entries.push({ key: null, raw }); continue; }
    const key = m[1];
    if (index.has(key)) { entries[index.get(key)] = { key, sep: m[2], value: m[3] }; continue; }
    index.set(key, entries.length);
    entries.push({ key, sep: m[2], value: m[3] });
  }
  return { entries, index, trailing };
}

const get = (doc, key) => (doc.index.has(key) ? doc.entries[doc.index.get(key)].value : undefined);

function set(doc, key, value, sep) {
  if (doc.index.has(key)) {
    const e = doc.entries[doc.index.get(key)];
    e.value = value;
    return;
  }
  doc.index.set(key, doc.entries.length);
  doc.entries.push({ key, sep: sep || ':', value });
}

function serialize(doc) {
  const out = doc.entries.map((e) => (e.key == null ? e.raw : `${e.key}${e.sep}${e.value}`)).join('\n');
  return doc.entries.length && doc.trailing !== false ? `${out}\n` : out;
}

// Fusión al actualizar. base = lo que recibió el jugador la última vez (null si no se sabe).
// Con base: se aplican las claves que el administrador cambió o añadió desde entonces.
// Sin base: solo se añaden las claves que el jugador no tiene (no se pisa nada suyo).
function merge3(playerText, baseText, newText) {
  const P = parse(playerText);
  if (!P.entries.some((e) => e.key != null)) return String(newText ?? ''); // no tiene ajustes propios: el archivo entero
  const N = parse(newText);
  const B = baseText == null ? null : parse(baseText);
  for (const e of N.entries) {
    if (e.key == null) continue;
    if (B) {
      if (get(B, e.key) === e.value) continue;
      set(P, e.key, e.value, e.sep);
    } else if (!P.index.has(e.key)) {
      set(P, e.key, e.value, e.sep);
    }
  }
  return serialize(P);
}

// Claves que cambian entre lo publicado (base) y el archivo local del administrador.
function changedKeys(baseText, localText, ignore = []) {
  const B = parse(baseText);
  const L = parse(localText);
  const skip = new Set(ignore);
  const out = [];
  for (const e of L.entries) {
    if (e.key == null || skip.has(e.key)) continue;
    const from = get(B, e.key);
    if (from === e.value) continue;
    out.push({ key: e.key, from: from ?? null, to: e.value, personal: isPersonal(e.key) });
  }
  return out;
}

// Archivo que se publica: lo publicado antes + solo las claves elegidas del archivo local.
function compose(baseText, localText, keys) {
  if (baseText == null) return String(localText ?? '');
  const B = parse(baseText);
  const L = parse(localText);
  for (const k of keys) {
    const e = L.index.has(k) ? L.entries[L.index.get(k)] : null;
    if (e) set(B, k, e.value, e.sep);
  }
  return serialize(B);
}

// ¿Se puede fusionar por claves? (texto con al menos una línea clave:valor o clave=valor)
function looksLikeKv(text) {
  const doc = parse(text);
  const keyed = doc.entries.filter((e) => e.key != null).length;
  return keyed > 0 && keyed >= doc.entries.filter((e) => e.key == null && e.raw.trim()).length;
}

module.exports = { parse, serialize, merge3, changedKeys, compose, looksLikeKv, isPersonal };
