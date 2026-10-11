const bridge = window.vsl;

export async function call(channel, ...args) {
  const r = await bridge.invoke(channel, ...args);
  if (r?.ok) return r.data;
  const e = new Error(r?.error?.message || 'Error desconocido');
  e.code = r?.error?.code || null;
  e.status = r?.error?.status || null;
  throw e;
}
export const pathFor = (file) => bridge.pathFor(file);

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
  admin: { access: false, unlocked: false, perms: [] },
  route: { name: 'home' },
  focused: true,
};

export function instance(id) {
  return state.instances.find((i) => i.id === id) || null;
}

export function setInstances(list) {
  const before = new Map(state.instances.map((i) => [i.id, JSON.stringify(i)]));
  const next = list.instances || [];
  const metaChanged = state.instancesMeta.error !== (list.error || null)
    || state.instancesMeta.configured !== Boolean(list.configured);
  const changed = next.filter((i) => metaChanged || before.get(i.id) !== JSON.stringify(i));
  const ids = new Set(next.map((i) => i.id));
  const removed = state.instances.filter((i) => !ids.has(i.id));
  const different = changed.length || state.instances.length !== next.length
    || state.instances.some((i, n) => i.id !== next[n]?.id)
    || metaChanged;
  state.instances = next;
  state.instancesMeta = { error: list.error || null, configured: Boolean(list.configured), at: list.at };
  if (different) emit('instances', state.instances);
  for (const d of changed) emit(`instance:${d.id}`, d);
  for (const d of removed) emit(`instance:${d.id}`, null);
}

export function upsertInstance(d) {
  if (!d) return;
  const i = state.instances.findIndex((x) => x.id === d.id);
  if (i >= 0) state.instances[i] = d;
  else state.instances.push(d);
  emit('instances', state.instances);
  emit(`instance:${d.id}`, d);
}

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
