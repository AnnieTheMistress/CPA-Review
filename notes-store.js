/* Personal notes live only in IndexedDB and the explicitly connected private repository. */
(function (root) {
  'use strict';
  const API = 'https://api.github.com';
  const REPO = '/repos/AnnieTheMistress/CPA-Study';
  const AUTH_KEY = 'review-notes-github-v1';
  const MAX_FILE = 20 * 1024 * 1024;
  const MAX_BACKUP = 200 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HASH = /^[a-f0-9]{64}$/;
  const EXAMS = new Set(['cpa', 'intermediate', 'fund']);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const clone = value => structuredClone(value);
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function exam(value) { assert(EXAMS.has(value), 'Invalid examId'); return value; }
  function id(value) { assert(typeof value === 'string' && UUID.test(value), 'Invalid note/attachment ID'); return value; }
  function text(value, fallback = '') { assert(value === undefined || typeof value === 'string', 'Invalid text field'); return value === undefined ? fallback : value; }
  function strings(value) {
    assert(value === undefined || (Array.isArray(value) && value.every(x => typeof x === 'string')), 'Invalid string list');
    return value ? [...value] : [];
  }
  function date(value, fallback) {
    const result = value === undefined ? fallback : value;
    assert(typeof result === 'string' && Number.isFinite(Date.parse(result)), 'Invalid note date');
    return result;
  }
  function meta(value) {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid attachment');
    assert(HASH.test(value.sha256), 'Invalid attachment hash');
    assert(typeof value.name === 'string' && typeof value.type === 'string', 'Invalid attachment metadata');
    assert(Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_FILE, 'Attachment exceeds 20MB or has invalid size');
    assert(typeof value.path === 'string' && new RegExp('^个人笔记/attachments/' + value.sha256 + '\\.[a-z0-9]{1,10}$').test(value.path), 'Invalid attachment path');
    return { id: id(value.id), name: value.name, type: value.type, size: value.size, sha256: value.sha256, path: value.path };
  }
  function normalize(value, crypto, defaults = true) {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid note');
    if (!defaults) {
      for (const key of ['id', 'examId', 'title', 'body', 'subject', 'chapter', 'tags', 'questionIds', 'attachments', 'createdAt', 'updatedAt']) {
        assert(Object.hasOwn(value, key), 'Incomplete note: ' + key);
      }
    }
    const now = new Date().toISOString();
    assert(value.attachments === undefined || Array.isArray(value.attachments), 'Invalid attachments');
    assert(value.deleted === undefined || typeof value.deleted === 'boolean', 'Invalid deletion state');
    return {
      id: id(value.id || (defaults && crypto.randomUUID())), examId: exam(value.examId),
      title: text(value.title), body: text(value.body), subject: text(value.subject), chapter: text(value.chapter),
      tags: strings(value.tags), questionIds: strings(value.questionIds), attachments: (value.attachments || []).map(meta),
      createdAt: date(value.createdAt, now), updatedAt: date(value.updatedAt, now), deleted: value.deleted === true,
      syncState: 'pending'
    };
  }
  function publicNote(note) { const result = clone(note); delete result.syncState; delete result._draftVersion; return result; }
  function draftView(record) {
    const note = clone(record.note);
    note._draftVersion = record.editEpoch || 'legacy';
    return note;
  }
  function same(a, b) { return JSON.stringify(publicNote(a)) === JSON.stringify(publicNote(b)); }
  function notePath(note) { return '个人笔记/' + exam(note.examId) + '/' + id(note.id) + '/note.json'; }
  function base64(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 24576) result += btoa(String.fromCharCode(...bytes.subarray(i, i + 24576)));
    return result;
  }
  function unbase64(value) {
    // Avoid repeated regex groups: 20MB base64 inputs overflow some engines' regex stacks.
    assert(typeof value === 'string' && value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value), 'Invalid base64');
    const padding = value.indexOf('=');
    assert(padding === -1 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding))), 'Invalid base64');
    const decoded = atob(value);
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
  }
  function requestValue(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }

  async function createStore(options = {}) {
    const crypto = options.crypto || root.crypto;
    const indexedDB = options.indexedDB || root.indexedDB;
    const fetcher = options.fetch || ((...args) => root.fetch(...args));
    assert(crypto && indexedDB, 'IndexedDB and Web Crypto are required');
    const request = indexedDB.open(options.dbName || 'exam-review-personal-notes-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('notes', { keyPath: 'note.id' });
      db.createObjectStore('attachments', { keyPath: 'path' });
    };
    const db = await requestValue(request);
    function browserStorage(name) {
      try { return options[name] === undefined ? root[name] : options[name]; } catch (_) { return null; }
    }
    const session = browserStorage('sessionStorage');
    const local = browserStorage('localStorage');
    let auth = null;
    try {
      const stored = session?.getItem(AUTH_KEY) || local?.getItem(AUTH_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.token === 'string' && typeof parsed.login === 'string' && typeof parsed.remember === 'boolean') auth = parsed;
      }
    } catch (_) { /* Storage may be unavailable in private mode. */ }
    let syncQueue = Promise.resolve();
    function transaction(names, mode, work) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(names, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        const fail = error => { reject(error); tx.abort(); };
        try { work(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
      });
    }
    const getRecord = key => requestValue(db.transaction('notes').objectStore('notes').get(key));
    const getBlobRecord = path => requestValue(db.transaction('attachments').objectStore('attachments').get(path));
    const allRecords = () => requestValue(db.transaction('notes').objectStore('notes').getAll());
    const putBlob = record => transaction(['attachments'], 'readwrite', (tx) => tx.objectStore('attachments').put(record));
    // All read/modify/write note operations use a single IndexedDB transaction.
    function mutate(key, update) {
      return transaction(['notes'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('notes');
        const req = store.get(key);
        req.onsuccess = () => {
          try {
            const next = update(req.result, store);
            if (next) { store.put(next); done(draftView(next)); }
          } catch (error) { fail(error); }
        };
      });
    }
    async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); }
    async function api(path, init = {}, optional = false, credentials = auth) {
      assert(credentials?.token, 'Connect GitHub before syncing');
      let response;
      try {
        response = await fetcher(API + path, {
          ...init, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + credentials.token },
          redirect: 'error'
        });
      } catch (_) { throw new Error('GitHub network request failed; local drafts are retained'); }
      if (optional && response.status === 404) return null;
      if (!response.ok) { const error = new Error('GitHub request failed (HTTP ' + response.status + ')'); error.status = response.status; throw error; }
      try { return await response.json(); } catch (_) { throw new Error('Invalid GitHub response'); }
    }
    function contentsPath(path) { return REPO + '/contents/' + path.split('/').map(encodeURIComponent).join('/'); }
    async function readContent(path) {
      const result = await api(contentsPath(path) + '?ref=main', {}, true);
      if (result === null) return null;
      assert(result && typeof result.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(result.sha), 'Invalid remote SHA');
      if (result.encoding === 'base64' && typeof result.content === 'string') {
        return { sha: result.sha, bytes: unbase64(result.content.replace(/\s/g, '')) };
      }
      // Contents omits large file contents. Resolve the Git blob only by verified SHA, never download_url.
      const blob = await api(REPO + '/git/blobs/' + result.sha);
      assert(blob.encoding === 'base64' && typeof blob.content === 'string', 'Remote file content is unavailable');
      return { sha: result.sha, bytes: unbase64(blob.content.replace(/\s/g, '')) };
    }
    async function writeContent(path, bytes, sha) {
      const body = { message: 'Sync personal notes', branch: 'main', content: base64(bytes) };
      if (sha) body.sha = sha;
      const result = await api(contentsPath(path), { method: 'PUT', body: JSON.stringify(body) });
      assert(result?.content?.sha, 'GitHub did not confirm file write');
      return result.content.sha;
    }
    function remoteNote(content, expectedId, expectedExam) {
      let value;
      try { value = JSON.parse(decoder.decode(content.bytes)); } catch (_) { throw new Error('Invalid remote note JSON'); }
      const note = normalize(value, crypto, false);
      assert(note.id === expectedId && note.examId === expectedExam, 'Remote note path does not match note');
      note.syncState = 'synced';
      return note;
    }
    async function ensureAttachment(value) {
      const attachment = meta(value);
      const remote = await readContent(attachment.path);
      if (remote) {
        assert(remote.bytes.length === attachment.size && await digest(remote.bytes) === attachment.sha256, 'Remote attachment integrity check failed');
        return;
      }
      const blob = await store.getAttachment(attachment);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try { await writeContent(attachment.path, bytes); }
      catch (error) {
        if (error.status !== 409 && error.status !== 422) throw error;
        const existing = await readContent(attachment.path);
        assert(existing && existing.bytes.length === attachment.size && await digest(existing.bytes) === attachment.sha256, 'Attachment upload conflict');
      }
    }
    async function acceptRemote(remote, sha, counters) {
      await mutate(remote.id, (current, objectStore) => {
        assert(!current || current.note.examId === remote.examId, 'Remote note ID belongs to another exam');
        if (current?.baseSha === sha) return current;
        if (current?.note.syncState === 'pending' && current.baseSha !== sha && !same(current.note, remote)) {
          const copy = clone(current.note);
          copy.id = crypto.randomUUID(); copy.title += '（冲突副本）'; copy.deleted = false;
          copy.createdAt = copy.updatedAt = new Date().toISOString(); copy.syncState = 'pending';
          objectStore.put({ note: copy, baseSha: null, revision: 1, editEpoch: crypto.randomUUID() }); counters.conflicts++;
        }
        counters.pulled++;
        return { note: remote, baseSha: sha, revision: (current?.revision || 0) + 1,
          editEpoch: current && same(current.note, remote) ? (current.editEpoch || 'legacy') : crypto.randomUUID() };
      });
    }
    async function runSync(examId) {
      exam(examId); assert(auth, 'Connect GitHub before syncing');
      const counters = { pulled: 0, uploaded: 0, conflicts: 0 };
      const tree = await api(REPO + '/git/trees/main?recursive=1');
      assert(tree && Array.isArray(tree.tree) && tree.truncated === false, 'Repository tree is incomplete; sync stopped');
      const pattern = new RegExp('^个人笔记/' + examId + '/([0-9a-f-]+)/note\\.json$', 'i');
      for (const entry of tree.tree) {
        const match = typeof entry.path === 'string' && entry.path.match(pattern);
        if (!match || entry.type !== 'blob') continue;
        id(match[1]);
        const current = await getRecord(match[1]);
        if (current?.baseSha === entry.sha) continue;
        const content = await readContent(entry.path);
        assert(content, 'Remote note disappeared during sync');
        const remote = remoteNote(content, match[1], examId);
        await acceptRemote(remote, content.sha, counters);
      }
      const pending = (await allRecords()).filter(record => record.note.examId === examId && record.note.syncState === 'pending');
      for (const snapshot of pending) {
        // Recheck the individual file: the tree snapshot is not a write precondition.
        const before = await readContent(notePath(snapshot.note));
        if ((before?.sha || null) !== snapshot.baseSha) {
          if (before) { await acceptRemote(remoteNote(before, snapshot.note.id, examId), before.sha, counters); continue; }
          throw new Error('Remote note was removed outside the app; local draft is retained');
        }
        for (const attachment of snapshot.note.attachments) await ensureAttachment(attachment);
        let sha;
        try { sha = await writeContent(notePath(snapshot.note), encoder.encode(JSON.stringify(publicNote(snapshot.note))), snapshot.baseSha); }
        catch (error) {
          if (error.status !== 409 && error.status !== 422) throw error;
          const latest = await readContent(notePath(snapshot.note));
          assert(latest, 'Remote version changed; retry sync');
          await acceptRemote(remoteNote(latest, snapshot.note.id, examId), latest.sha, counters); continue;
        }
        // Read back before claiming success, and advance the base without overwriting concurrent edits.
        const verified = await readContent(notePath(snapshot.note));
        assert(verified, 'Unable to verify uploaded note');
        const verifiedNote = remoteNote(verified, snapshot.note.id, examId);
        if (verified.sha !== sha || !same(verifiedNote, snapshot.note)) {
          await acceptRemote(verifiedNote, verified.sha, counters); continue;
        }
        await mutate(snapshot.note.id, current => {
          if (!current) return null;
          current.baseSha = sha;
          if (current.revision === snapshot.revision) current.note.syncState = 'synced';
          return current;
        });
        counters.uploaded++;
      }
      return counters;
    }
    const store = {
      async list(examId, options = {}) {
        exam(examId);
        return (await allRecords()).filter(record => record.note.examId === examId && (options.includeDeleted || !record.note.deleted)).map(draftView);
      },
      async get(noteId) { id(noteId); const record = await getRecord(noteId); return record ? draftView(record) : null; },
      async save(value) {
        const note = normalize(value, crypto);
        const draftVersion = value._draftVersion;
        assert(draftVersion === undefined || typeof draftVersion === 'string', 'Invalid draft version');
        note.updatedAt = new Date().toISOString();
        return mutate(note.id, current => {
          assert(!current || current.note.examId === note.examId, 'Cannot change note examId');
          if (current && draftVersion !== undefined && draftVersion !== (current.editEpoch || 'legacy')) {
            const error = new Error('The remote note changed; preserve these edits as a conflict copy');
            error.code = 'STALE_DRAFT';
            throw error;
          }
          if (current) note.createdAt = current.note.createdAt;
          return { note, baseSha: current?.baseSha || null, revision: (current?.revision || 0) + 1, editEpoch: current ? (current.editEpoch || 'legacy') : crypto.randomUUID() };
        });
      },
      async remove(noteId) {
        id(noteId);
        return mutate(noteId, current => {
          if (!current) return null;
          current.note.deleted = true; current.note.updatedAt = new Date().toISOString(); current.note.syncState = 'pending'; current.revision++;
          return current;
        });
      },
      async addAttachment(file) {
        assert(file && typeof file.arrayBuffer === 'function' && Number.isSafeInteger(file.size) && file.size <= MAX_FILE, 'Attachment exceeds 20MB or is invalid');
        const bytes = new Uint8Array(await file.arrayBuffer());
        assert(bytes.length === file.size, 'Attachment size mismatch');
        const hash = await digest(bytes);
        const name = typeof file.name === 'string' ? file.name : 'attachment.bin';
        const suffix = name.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
        const path = '个人笔记/attachments/' + hash + '.' + (suffix ? suffix[1] : 'bin');
        const attachment = meta({ id: crypto.randomUUID(), name, type: file.type || '', size: file.size, sha256: hash, path });
        await putBlob({ path, blob: new Blob([bytes], { type: attachment.type }) });
        return attachment;
      },
      async getAttachment(value) {
        const attachment = meta(value);
        const cached = await getBlobRecord(attachment.path);
        if (cached) {
          const bytes = new Uint8Array(await cached.blob.arrayBuffer());
          assert(bytes.length === attachment.size && await digest(bytes) === attachment.sha256, 'Cached attachment integrity check failed');
          return cached.blob.slice(0, cached.blob.size, attachment.type);
        }
        const remote = await readContent(attachment.path);
        assert(remote && remote.bytes.length === attachment.size && await digest(remote.bytes) === attachment.sha256, 'Remote attachment missing or corrupt');
        const blob = new Blob([remote.bytes], { type: attachment.type });
        await putBlob({ path: attachment.path, blob });
        return blob;
      },
      async connect(token, { remember = false } = {}) {
        assert(typeof token === 'string' && token.trim() && !/[\r\n]/.test(token), 'Invalid GitHub token');
        const next = { token: token.trim(), login: '', remember: remember === true };
        const user = await api('/user', {}, false, next);
        const repo = await api(REPO, {}, false, next);
        assert(typeof user.login === 'string' && repo.permissions?.push === true, 'Repository Contents write permission is required');
        await api(REPO + '/branches/main', {}, false, next);
        next.login = user.login;
        try {
          session?.removeItem(AUTH_KEY); local?.removeItem(AUTH_KEY);
          const storage = next.remember ? local : session;
          assert(storage, 'Connection storage is unavailable');
          storage.setItem(AUTH_KEY, JSON.stringify(next));
        } catch (_) { throw new Error('Unable to store GitHub connection in this browser'); }
        auth = next;
        return { login: next.login };
      },
      async disconnect() {
        auth = null;
        session?.removeItem(AUTH_KEY); local?.removeItem(AUTH_KEY);
      },
      connection() { return { connected: !!auth, login: auth?.login || null, remember: auth?.remember || false }; },
      sync(examId) {
        const task = syncQueue.then(() => runSync(examId));
        syncQueue = task.catch(() => {});
        return task;
      },
      async exportBackup(examId) {
        const notes = (await store.list(examId, { includeDeleted: true })).map(publicNote);
        const attachments = [];
        const seen = new Set();
        let estimated = encoder.encode(JSON.stringify(notes)).length;
        for (const note of notes) for (const attachment of note.attachments) {
          if (seen.has(attachment.path)) continue;
          seen.add(attachment.path);
          estimated += Math.ceil(attachment.size / 3) * 4 + 1024;
          assert(estimated <= MAX_BACKUP, 'Backup exceeds 200MB');
          const blob = await store.getAttachment(attachment);
          attachments.push({ path: attachment.path, sha256: attachment.sha256, size: attachment.size, data: base64(new Uint8Array(await blob.arrayBuffer())) });
        }
        const blob = new Blob([JSON.stringify({ format: 'review-notes-backup', version: 1, examId, notes, attachments })], { type: 'application/json' });
        assert(blob.size <= MAX_BACKUP, 'Backup exceeds 200MB');
        return blob;
      },
      async importBackup(file) {
        assert(file && typeof file.text === 'function' && Number.isSafeInteger(file.size) && file.size <= MAX_BACKUP, 'Invalid backup or backup exceeds 200MB');
        let backup;
        try { backup = JSON.parse(await file.text()); } catch (_) { throw new Error('Invalid backup JSON'); }
        assert(backup?.format === 'review-notes-backup' && backup.version === 1 && Array.isArray(backup.notes) && Array.isArray(backup.attachments), 'Not a personal notes backup');
        exam(backup.examId);
        const notes = backup.notes.map(value => normalize(value, crypto, false));
        const ids = new Set();
        const needed = new Map();
        for (const note of notes) {
          assert(note.examId === backup.examId && !ids.has(note.id), 'Backup exam mismatch or duplicate note ID'); ids.add(note.id);
          for (const attachment of note.attachments) {
            const previous = needed.get(attachment.path);
            assert(!previous || (previous.size === attachment.size && previous.sha256 === attachment.sha256), 'Inconsistent attachment metadata');
            needed.set(attachment.path, attachment);
          }
        }
        const blobs = new Map();
        for (const item of backup.attachments) {
          const attachment = needed.get(item.path);
          assert(attachment && !blobs.has(item.path) && item.sha256 === attachment.sha256 && item.size === attachment.size, 'Unexpected backup attachment');
          assert(typeof item.data === 'string' && item.data.length <= Math.ceil(MAX_FILE / 3) * 4, 'Invalid backup attachment size');
          const bytes = unbase64(item.data);
          assert(bytes.length === attachment.size && await digest(bytes) === attachment.sha256, 'Backup attachment integrity check failed');
          blobs.set(item.path, new Blob([bytes], { type: attachment.type }));
        }
        assert(blobs.size === needed.size, 'Backup is missing original attachments');
        return transaction(['notes', 'attachments'], 'readwrite', (tx, done) => {
          const noteStore = tx.objectStore('notes');
          const result = { imported: 0, copies: 0 };
          for (const [path, blob] of blobs) tx.objectStore('attachments').put({ path, blob });
          for (const note of notes) {
            const req = noteStore.get(note.id);
            req.onsuccess = () => {
              const current = req.result;
              if (current && same(current.note, note)) return;
              if (current) {
                note.id = crypto.randomUUID(); note.title += '（恢复副本）'; result.copies++;
              }
              noteStore.put({ note, baseSha: null, revision: 1, editEpoch: crypto.randomUUID() }); result.imported++;
            };
          }
          done(result);
        });
      },
      close() { db.close(); }
    };
    return store;
  }
  const exported = Object.freeze({ createStore });
  root.ReviewNotes = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(globalThis);
