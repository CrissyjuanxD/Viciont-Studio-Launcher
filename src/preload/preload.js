'use strict';
// Puente seguro entre la interfaz y el proceso principal: la página no tiene
// acceso a Node ni a archivos; solo puede pedir acciones concretas.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const PREFIXES = ['app:', 'settings:', 'accounts:', 'skins:', 'instances:', 'admin:', 'catalog:', 'modrinth:'];

contextBridge.exposeInMainWorld('vsl', {
  async call(channel, ...args) {
    if (typeof channel !== 'string' || !PREFIXES.some((p) => channel.startsWith(p))) throw new Error('Acción no permitida');
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
  pathFor(file) {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
});
