'use strict';
// Puente seguro entre la interfaz y el proceso principal: la página no tiene
// acceso a Node ni a archivos; solo puede pedir acciones concretas.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const PREFIXES = ['app:', 'settings:', 'accounts:', 'skins:', 'instances:', 'admin:', 'catalog:', 'modrinth:'];

const allowed = (channel) => typeof channel === 'string' && PREFIXES.some((p) => channel.startsWith(p));

contextBridge.exposeInMainWorld('vsl', {
  // Devuelve { ok, data } o { ok: false, error: { message, code, status } }. La página
  // rehace el error con su código (los errores que cruzan el puente pierden el código).
  async invoke(channel, ...args) {
    if (!allowed(channel)) return { ok: false, error: { message: 'Acción no permitida', code: 'EDENIED' } };
    return ipcRenderer.invoke('vsl', channel, ...args);
  },
  async call(channel, ...args) {
    if (!allowed(channel)) throw new Error('Acción no permitida');
    const r = await ipcRenderer.invoke('vsl', channel, ...args);
    if (r?.ok) return r.data;
    const e = new Error(r?.error?.message || 'Error desconocido');
    e.code = r?.error?.code || null;
    e.status = r?.error?.status || null;
    throw e;
  },
  on(fn) {
    const handler = (_, msg) => { try { fn(msg); } catch (e) { console.error(e); } };
    ipcRenderer.on('vsl:event', handler);
    return () => ipcRenderer.removeListener('vsl:event', handler);
  },
  // Ruta real de un archivo soltado en la ventana (arrastrar y soltar en el panel).
  // Solo funciona con archivos que el usuario soltó de verdad; el proceso principal
  // únicamente acepta rutas registradas aquí.
  pathFor(file) {
    let p = null;
    try { p = webUtils.getPathForFile(file) || null; } catch { p = null; }
    if (p) ipcRenderer.send('vsl-grant', p);
    return p;
  },
});
