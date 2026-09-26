// Acceso al proceso principal y estado global de la interfaz.

const bridge = window.vsl;

export const call = (channel, ...args) => bridge.call(channel, ...args);
export const pathFor = (file) => bridge.pathFor(file);

// ---------- Estado + eventos ----------
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

export function emit(type, data) {
  for (const fn of listeners.get(type) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

export const state = {
  info: null,
  settings: null,
  accounts: { active: null, list: [] },
  instances: [],
  instancesMeta: { error: null, configured: false },
  progress: new Map(),
  studio: null,
  update: null,
  route: { name: 'home' },
  focused: true,
};

export function instance(id) {
  return state.instances.find((i) => i.id === id) || null;
}

export function setInstances(list) {
  state.instances = list.instances || [];
  state.instancesMeta = { error: list.error || null, configured: Boolean(list.configured), at: list.at };
  emit('instances', state.instances);
}

export function upsertInstance(d) {
  if (!d) return;
  const i = state.instances.findIndex((x) => x.id === d.id);
  if (i >= 0) state.instances[i] = d;
  else state.instances.push(d);
  emit('instances', state.instances);
  emit(`instance:${d.id}`, d);
}

// Eventos que llegan del proceso principal
bridge.on((msg) => {
  const { type, data } = msg || {};
  switch (type) {
    case 'instance': upsertInstance(data); break;
    case 'instances': setInstances(data); break;
    case 'progress':
      state.progress.set(data.id, data);
      emit('progress', data);
      emit(`progress:${data.id}`, data);
      break;
    case 'task-done':
      state.progress.delete(data.id);
      emit('task-done', data);
      break;
    case 'accounts': state.accounts = data; emit('accounts', data); break;
    case 'update': state.update = data; emit('update', data); break;
    case 'focus': state.focused = data; emit('focus', data); break;
    default: emit(type, data);
  }
});
