(() => {
  'use strict';

  // ---------- Configuración ----------
  const DATA_PATH = 'data/notes.json';               // archivo del repo donde se guardan los post-its
  const LS_KEY = 'postits-github-config';            // clave de Local Storage (solo datos de conexión)
  const DEFAULT_MESSAGE = 'chore: actualizar post-its';
  const COLORS = ['#ece08f', '#7ad7cb', '#3ec5f5', '#a9c1de', '#dcaacd', '#f7b98b'];
  const NOTE_W = 150;
  const NOTE_H = 150;

  // ---------- Estado ----------
  let notes = [];
  let selectedColor = COLORS[0];
  let dirty = false;
  let remoteSha = null;   // sha del archivo tal como lo trajimos de GitHub (para detectar cambios ajenos)
  let drag = null;

  // ---------- Elementos ----------
  const $ = (s) => document.querySelector(s);
  const board = $('#board');
  const wrap = $('#board-wrap');
  const emptyHint = $('#empty-hint');
  const statusEl = $('#status');
  const dialog = $('#git-dialog');
  const form = $('#git-form');
  const msgEl = $('#git-msg');
  const toastEl = $('#toast');
  const busyButtons = ['#btn-pull', '#btn-commit', '#btn-download'].map($);

  // ---------- Utilidades ----------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const randRot = () => Math.round((Math.random() * 6 - 3) * 10) / 10;
  const getNote = (id) => notes.find((n) => n.id === id);
  const noteEl = (id) => board.querySelector(`.note[data-id="${CSS.escape(id)}"]`);

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function fromBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function normalize(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : []);
    return list.map((n) => ({
      id: String(n.id || uid()),
      text: String(n.text ?? ''),
      color: typeof n.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(n.color) ? n.color : COLORS[0],
      x: Math.max(0, Math.round(Number(n.x) || 0)),
      y: Math.max(0, Math.round(Number(n.y) || 0)),
      rot: Number.isFinite(Number(n.rot)) ? Number(n.rot) : 0,
    }));
  }

  function serialize() {
    return JSON.stringify({
      updatedAt: new Date().toISOString(),
      notes: notes.map(({ id, text, color, x, y, rot }) => ({ id, text, color, x, y, rot })),
    }, null, 2) + '\n';
  }

  // ---------- Local Storage (solo la conexión con GitHub) ----------
  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* navegador sin storage */ }
  }
  function forgetConfig() {
    try { localStorage.removeItem(LS_KEY); } catch { /* nada */ }
  }

  // Si la página está publicada en usuario.github.io/repo, adivinamos usuario y repo.
  function guessConfig() {
    const host = location.hostname;
    let owner = '', repo = '';
    if (host.endsWith('.github.io')) {
      owner = host.slice(0, -'.github.io'.length);
      const seg = location.pathname.split('/').filter(Boolean)[0];
      repo = seg && !seg.includes('.') ? seg : `${owner}.github.io`;
    }
    return { owner, repo, branch: 'main', token: '' };
  }

  // ---------- Estado de guardado ----------
  function setDirty(value) {
    dirty = value;
    statusEl.dataset.state = value ? 'dirty' : 'saved';
    statusEl.textContent = value ? 'Cambios sin guardar' : 'Todo guardado';
  }
  const markDirty = () => setDirty(true);

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- Aviso flotante ----------
  let toastTimer;
  function toast(text, action) {
    toastEl.replaceChildren();
    const span = document.createElement('span');
    span.textContent = text;
    toastEl.append(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { action.fn(); hideToast(); });
      toastEl.append(b);
    }
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
  }
  function hideToast() { toastEl.classList.remove('show'); }

  // ---------- Selector de color ----------
  function makeSwatch(color, onPick, checked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.setProperty('--c', color);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Color ${color}`);
    b.setAttribute('aria-checked', String(!!checked));
    b.addEventListener('click', onPick);
    return b;
  }
  function buildSwatches() {
    const box = $('#swatches');
    box.replaceChildren(...COLORS.map((c) => makeSwatch(c, () => {
      selectedColor = c;
      box.querySelectorAll('.swatch').forEach((s) =>
        s.setAttribute('aria-checked', String(s.style.getPropertyValue('--c') === c)));
    }, c === selectedColor)));
  }

  // ---------- Dibujo de los post-its ----------
  function iconBtn(label, title, cls, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'note-btn ' + cls;
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function createNoteEl(note, index) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.id = note.id;
    el.tabIndex = 0;
    el.style.left = note.x + 'px';
    el.style.top = note.y + 'px';
    el.style.zIndex = index + 1;
    el.style.setProperty('--note-bg', note.color);
    el.style.setProperty('--rot', note.rot + 'deg');

    const text = document.createElement('div');
    text.className = 'note-text';
    text.textContent = note.text;

    const actions = document.createElement('div');
    actions.className = 'note-actions';
    actions.append(
      iconBtn('✎', 'Editar', 'edit', () => startEdit(el)),
      iconBtn('●', 'Cambiar color', 'color', () => {
        const open = el.classList.contains('palette-open');
        closePalettes();
        el.classList.toggle('palette-open', !open);
      }),
      iconBtn('×', 'Borrar', 'del', () => deleteNote(note.id)),
    );

    const palette = document.createElement('div');
    palette.className = 'note-palette';
    palette.append(...COLORS.map((c) => makeSwatch(c, (e) => {
      e.stopPropagation();
      setColor(note.id, c);
    }, c === note.color)));

    el.append(text, actions, palette);
    return el;
  }

  function render() {
    board.replaceChildren(...notes.map(createNoteEl));
    updateBoardSize();
    emptyHint.hidden = notes.length > 0;
  }

  function updateBoardSize() {
    const maxX = notes.reduce((m, n) => Math.max(m, n.x), 0);
    const maxY = notes.reduce((m, n) => Math.max(m, n.y), 0);
    board.style.width = Math.max(wrap.clientWidth, maxX + NOTE_W + 240) + 'px';
    board.style.height = Math.max(wrap.clientHeight, maxY + NOTE_H + 240) + 'px';
  }
  window.addEventListener('resize', updateBoardSize);

  function closePalettes() {
    board.querySelectorAll('.note.palette-open').forEach((n) => n.classList.remove('palette-open'));
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.note-palette, .note-btn.color')) closePalettes();
  });

  // ---------- Crear, editar, colorear, borrar ----------
  function addNote(x, y) {
    const note = {
      id: uid(),
      text: '',
      color: selectedColor,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      rot: randRot(),
    };
    notes.push(note);
    render();
    markDirty();
    startEdit(noteEl(note.id));
  }

  function startEdit(el) {
    if (!el || el.classList.contains('editing')) return;
    closePalettes();
    const t = el.querySelector('.note-text');
    el.classList.add('editing');
    try { t.contentEditable = 'plaintext-only'; } catch { /* navegador viejo */ }
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.focus();

    // Cursor al final del texto
    const range = document.createRange();
    range.selectNodeContents(t);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const onKey = (ev) => {
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) {
        ev.preventDefault();
        t.blur();
      }
    };
    const finish = () => {
      t.removeEventListener('blur', finish);
      t.removeEventListener('keydown', onKey);
      t.contentEditable = 'false';
      el.classList.remove('editing');
      const note = getNote(el.dataset.id);
      if (!note) return;
      const text = t.innerText.replace(/\n$/, '');
      if (text !== note.text) { note.text = text; markDirty(); }
      t.textContent = note.text;
    };
    t.addEventListener('blur', finish);
    t.addEventListener('keydown', onKey);
  }

  function setColor(id, color) {
    const note = getNote(id);
    if (!note) return;
    note.color = color;
    const el = noteEl(id);
    el.style.setProperty('--note-bg', color);
    el.querySelectorAll('.note-palette .swatch').forEach((s) =>
      s.setAttribute('aria-checked', String(s.style.getPropertyValue('--c') === color)));
    el.classList.remove('palette-open');
    markDirty();
  }

  function deleteNote(id) {
    const idx = notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [removed] = notes.splice(idx, 1);
    render();
    markDirty();
    toast('Post-it borrado', {
      label: 'Deshacer',
      fn: () => {
        notes.splice(Math.min(idx, notes.length), 0, removed);
        render();
        markDirty();
      },
    });
  }

  function bringToFront(el, note) {
    const i = notes.indexOf(note);
    if (i > -1 && i < notes.length - 1) {
      notes.splice(i, 1);
      notes.push(note);
      notes.forEach((n, k) => { const e = noteEl(n.id); if (e) e.style.zIndex = k + 1; });
    }
  }

  $('#btn-add').addEventListener('click', () => {
    const jitter = () => Math.random() * 80 - 40;
    addNote(
      wrap.scrollLeft + wrap.clientWidth / 2 - NOTE_W / 2 + jitter(),
      wrap.scrollTop + wrap.clientHeight / 2 - NOTE_H / 2 + jitter(),
    );
  });

  board.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.note');
    if (el) {
      if (!e.target.closest('.note-actions, .note-palette')) startEdit(el);
      return;
    }
    const rect = board.getBoundingClientRect();
    addNote(e.clientX - rect.left - NOTE_W / 2, e.clientY - rect.top - 30);
  });

  board.addEventListener('keydown', (e) => {
    const el = e.target.closest('.note');
    if (!el || el.classList.contains('editing') || e.target !== el) return;
    if (e.key === 'Enter') { e.preventDefault(); startEdit(el); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteNote(el.dataset.id); }
  });

  // ---------- Arrastrar (mouse y pantalla táctil) ----------
  board.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.note');
    if (!el || e.button !== 0) return;
    if (e.target.closest('.note-actions, .note-palette')) return;
    if (el.classList.contains('editing')) return;
    const note = getNote(el.dataset.id);
    if (!note) return;
    bringToFront(el, note);
    const rect = board.getBoundingClientRect();
    drag = {
      el, note,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      offX: e.clientX - rect.left - note.x,
      offY: e.clientY - rect.top - note.y,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  });

  board.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      closePalettes();
    }
    const rect = board.getBoundingClientRect();
    drag.note.x = Math.max(0, Math.round(e.clientX - rect.left - drag.offX));
    drag.note.y = Math.max(0, Math.round(e.clientY - rect.top - drag.offY));
    drag.el.style.left = drag.note.x + 'px';
    drag.el.style.top = drag.note.y + 'px';
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.moved) {
      drag.el.classList.remove('dragging');
      updateBoardSize();
      markDirty();
    }
    drag = null;
  }
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);

  // ---------- API de GitHub ----------
  const enc = encodeURIComponent;
  const repoUrl = (c) => `https://api.github.com/repos/${enc(c.owner)}/${enc(c.repo)}`;
  const contentsUrl = (c) => `${repoUrl(c)}/contents/${DATA_PATH}`;

  async function gh(cfg, url, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}` };
    if (opts.body) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(url, { ...opts, headers, cache: 'no-store' });
    } catch {
      throw new Error('No se pudo conectar con GitHub. Revisá tu conexión a internet.');
    }
  }

  async function ghError(res) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* sin cuerpo */ }
    if (res.status === 403 && /rate limit/i.test(detail)) {
      return new Error('Se alcanzó el límite de solicitudes de GitHub. Esperá unos minutos y probá de nuevo.');
    }
    const known = {
      401: 'El token no es válido o venció. Generá uno nuevo en GitHub.',
      403: 'El token no tiene permiso para escribir en este repositorio (necesita “Contents: Read and write”).',
      404: 'No se encontró el repositorio o el token no tiene acceso a él.',
      409: 'El archivo cambió en GitHub mientras guardabas. Probá de nuevo.',
      422: 'GitHub rechazó los datos enviados.',
    };
    const base = known[res.status] || `GitHub respondió con el error ${res.status}.`;
    return new Error(detail ? `${base} (${detail})` : base);
  }

  // Si el archivo no existe, revisamos si falla el repo o la rama para dar un error claro.
  async function ensureRepoAndBranch(cfg) {
    const r = await gh(cfg, repoUrl(cfg));
    if (r.status === 404) throw new Error(`No se encontró el repositorio “${cfg.owner}/${cfg.repo}” o el token no tiene acceso a él.`);
    if (!r.ok) throw await ghError(r);
    const b = await gh(cfg, `${repoUrl(cfg)}/branches/${enc(cfg.branch)}`);
    if (b.status === 404) throw new Error(`La rama “${cfg.branch}” no existe en ${cfg.owner}/${cfg.repo}.`);
    if (!b.ok) throw await ghError(b);
  }

  // Devuelve { sha, text } o null si el archivo todavía no existe.
  async function getRemoteFile(cfg) {
    const res = await gh(cfg, `${contentsUrl(cfg)}?ref=${enc(cfg.branch)}`);
    if (res.status === 404) { await ensureRepoAndBranch(cfg); return null; }
    if (!res.ok) throw await ghError(res);
    const data = await res.json();
    return { sha: data.sha, text: fromBase64(data.content || '') };
  }

  async function putFile(cfg, message, sha) {
    const body = { message, content: toBase64(serialize()), branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await gh(cfg, contentsUrl(cfg), { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) throw await ghError(res);
    return res.json();
  }

  // ---------- Popup ----------
  function setMsg(text, type = 'info') {
    msgEl.textContent = text;
    msgEl.dataset.type = type;
  }
  function setBusy(on) { busyButtons.forEach((b) => { b.disabled = on; }); }

  function readForm() {
    return {
      owner: form.owner.value.trim(),
      repo: form.repo.value.trim(),
      branch: form.branch.value.trim() || 'main',
      token: form.token.value.trim(),
    };
  }
  function validate(cfg) {
    const missing = [];
    if (!cfg.owner) missing.push('usuario u organización');
    if (!cfg.repo) missing.push('repositorio');
    if (!cfg.token) missing.push('token');
    if (missing.length) { setMsg(`Completá: ${missing.join(', ')}.`, 'error'); return false; }
    return true;
  }

  function openGitDialog() {
    const cfg = loadConfig() || guessConfig();
    form.owner.value = cfg.owner || '';
    form.repo.value = cfg.repo || '';
    form.branch.value = cfg.branch || 'main';
    form.token.value = cfg.token || '';
    form.message.value = DEFAULT_MESSAGE;
    setMsg(loadConfig() ? 'Usando los datos de conexión guardados en este navegador.' : '', 'info');
    dialog.showModal();
    const first = ['owner', 'repo', 'token'].find((k) => !form[k].value);
    (first ? form[first] : $('#btn-commit')).focus();
  }

  $('#btn-open-git').addEventListener('click', openGitDialog);
  $('#btn-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  $('#btn-commit').addEventListener('click', async () => {
    const cfg = readForm();
    if (!validate(cfg)) return;
    const message = form.message.value.trim() || DEFAULT_MESSAGE;
    setBusy(true);
    setMsg('Haciendo commit…');
    try {
      const current = await getRemoteFile(cfg);
      if (current && remoteSha && current.sha !== remoteSha) {
        const ok = confirm('Alguien guardó cambios en GitHub después de que cargaste la página.\n\nSi continuás, se reemplazan por tu versión. ¿Continuar?');
        if (!ok) { setMsg('Commit cancelado. Podés traer los últimos datos primero.'); return; }
      }
      const res = await putFile(cfg, message, current && current.sha);
      remoteSha = res.content.sha;
      const firstTime = !loadConfig();
      saveConfig(cfg);  // la combinación funcionó: la recordamos en este navegador
      setDirty(false);
      setMsg(`✓ Commit ${res.commit.sha.slice(0, 7)} hecho en ${cfg.owner}/${cfg.repo} (${cfg.branch}).`
        + (firstTime ? ' Los datos de conexión quedaron guardados en este navegador.' : ''), 'ok');
      toast('Cambios guardados en GitHub');
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('#btn-pull').addEventListener('click', async () => {
    const cfg = readForm();
    if (!validate(cfg)) return;
    if (dirty && !confirm('Tenés cambios sin guardar. Si traés los datos de GitHub, se pierden. ¿Continuar?')) return;
    setBusy(true);
    setMsg('Trayendo datos…');
    try {
      const file = await getRemoteFile(cfg);
      if (!file) {
        setMsg(`Todavía no existe ${DATA_PATH} en el repo. Hacé tu primer commit para crearlo.`);
        return;
      }
      notes = normalize(JSON.parse(file.text));
      remoteSha = file.sha;
      render();
      setDirty(false);
      setMsg(`✓ Se cargaron ${notes.length} post-it${notes.length === 1 ? '' : 's'} desde GitHub.`, 'ok');
    } catch (err) {
      setMsg(err instanceof SyntaxError ? `${DATA_PATH} no tiene un JSON válido.` : err.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('#btn-download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([serialize()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'notes.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#btn-forget').addEventListener('click', () => {
    forgetConfig();
    form.token.value = '';
    setMsg('Se borraron los datos de conexión de este navegador.');
  });

  // ---------- Inicio ----------
  async function init() {
    buildSwatches();
    let loaded = false;
    const cfg = loadConfig();

    // Con conexión guardada, leemos directo de la API: es lo más actualizado.
    if (cfg && cfg.token) {
      try {
        const file = await getRemoteFile(cfg);
        if (file) { notes = normalize(JSON.parse(file.text)); remoteSha = file.sha; }
        loaded = true;
      } catch (err) {
        console.warn(err);
        toast('No se pudo leer desde GitHub; se muestra la versión publicada.');
      }
    }

    // Sin conexión guardada, leemos el archivo publicado en GitHub Pages.
    if (!loaded) {
      try {
        const r = await fetch(`${DATA_PATH}?v=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) notes = normalize(await r.json());
      } catch { /* abierto como archivo local: empezamos vacío */ }
    }

    render();
    setDirty(false);
  }

  init();
})();
