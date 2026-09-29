'use strict';

const { EventEmitter } = require('node:events');

class TaskProgress extends EventEmitter {
  constructor(id, meta = {}) {
    super();
    this.id = id;
    this.meta = meta;
    this.phase = 'prepare';
    this.label = 'Preparando…';
    this.total = 0;
    this.done = 0;
    this.filesTotal = 0;
    this.filesDone = 0;
    this.speed = 0;
    this.startedAt = Date.now();
    this._lastDone = 0;
    this._lastT = Date.now();
    this._samples = [];
    this._timer = setInterval(() => this._sample(), 500);
    this._timer.unref?.();
  }

  setPhase(phase, label) {
    this.phase = phase;
    this.label = label;
    this.emit('update', this.snapshot());
  }

  addTotal(bytes, files = 0) {
    this.total += Math.max(0, bytes || 0);
    this.filesTotal += files;
  }

  addDone(bytes) {
    this.done += bytes;
    if (this.done < 0) this.done = 0;
  }

  fileDone(n = 1) { this.filesDone += n; }

  _sample() {
    const now = Date.now();
    const dt = (now - this._lastT) / 1000;
    if (dt <= 0) return;
    const inst = Math.max(0, (this.done - this._lastDone) / dt);
    this._lastDone = this.done;
    this._lastT = now;
    this._samples.push(inst);
    if (this._samples.length > 8) this._samples.shift();
    this.speed = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    this.emit('update', this.snapshot());
  }

  snapshot() {
    const remaining = Math.max(0, this.total - this.done);
    const eta = this.speed > 1024 && remaining > 0 ? Math.round(remaining / this.speed) : null;
    return {
      id: this.id,
      phase: this.phase,
      label: this.label,
      done: this.done,
      total: this.total,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      speed: Math.round(this.speed),
      eta,
      percent: this.total > 0 ? Math.min(100, (this.done / this.total) * 100) : null,
      elapsed: Math.round((Date.now() - this.startedAt) / 1000),
      ...this.meta,
    };
  }

  stop() {
    clearInterval(this._timer);
    this.removeAllListeners();
  }
}

module.exports = { TaskProgress };
