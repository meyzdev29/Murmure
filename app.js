// Murmure v2 – client
const API = (window.API_URL || '').replace(/\/$/, '');
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');

function loadToken() {
  try { const t = localStorage.getItem('murmure_token'); if (t) return t; } catch {}
  const m = document.cookie.match(/(?:^|; )murmure_token=([^;]+)/);
  return m ? m[1] : null;
}
function saveToken(t) {
  try { t ? localStorage.setItem('murmure_token', t) : localStorage.removeItem('murmure_token'); } catch {}
  document.cookie = 'murmure_token=' + (t || '') + '; max-age=' + (t ? 31536000 : 0) + '; path=/; SameSite=Lax';
}
let token = loadToken();
let me = null;
let scope = 'all';
let unreadMsgs = 0, unreadNotifs = 0;
let pollTimer = null;
const openComments = new Set();

/* ---------- Thème ---------- */
const getTheme = () => { try { return localStorage.getItem('murmure_theme') || 'auto'; } catch { return 'auto'; } };
function applyTheme(t = getTheme()) {
  try { localStorage.setItem('murmure_theme', t); } catch {}
  t === 'auto' ? document.documentElement.removeAttribute('data-theme') : (document.documentElement.dataset.theme = t);
}
applyTheme();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgURL = (id) => API + '/uploads/' + id + '.jpg';

async function api(path, method = 'GET', body) {
  let r;
  try {
    r = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Serveur injoignable. Vérifie l\'adresse dans config.js'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Erreur ' + r.status), { status: r.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  return Math.floor(s / 86400) + ' j';
}
function avatar(name, img) {
  if (img) return `<img class="avatar" src="${imgURL(img)}" alt="" loading="lazy">`;
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<div class="avatar" style="background:hsl(${h} 62% 48%)">${esc(name[0])}</div>`;
}

/* ---------- Photos : réduites en JPEG avant envoi ---------- */
function toJpeg(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = url;
  });
}
function bindPhotoPicker(input, preview, holder) {
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      holder.data = await toJpeg(f);
      preview.innerHTML = `<img src="${holder.data}" alt="Aperçu"><button type="button" class="link rm">Retirer</button>`;
      preview.classList.remove('hidden');
      preview.querySelector('.rm').onclick = () => { holder.data = null; input.value = ''; preview.innerHTML = ''; preview.classList.add('hidden'); };
    } catch (er) { toast(er.message); }
  };
}
async function uploadData(data) { return (await api('/api/upload', 'POST', { data })).image; }
const uploadIfAny = (holder) => (holder.data ? uploadData(holder.data) : null);

/* ---------- Navigation ---------- */
const badge = (n) => (n ? `<b class="badge">${n > 99 ? '99+' : n}</b>` : '');
function renderNav() {
  const h = location.hash || '#/';
  $('#nav').innerHTML = me
    ? `<a href="#/" class="${h === '#/' ? 'on' : ''}"><i class="ni">🏠</i><span>Accueil</span></a>
       <a href="#/search" class="${h.startsWith('#/search') ? 'on' : ''}"><i class="ni">🔍</i><span>Recherche</span></a>
       <a href="#/notifs" class="${h.startsWith('#/notifs') ? 'on' : ''}"><i class="ni">🔔</i><span>Notifs</span>${badge(unreadNotifs)}</a>
       <a href="#/messages" class="${h.startsWith('#/m') ? 'on' : ''}"><i class="ni">✉️</i><span>Messages</span>${badge(unreadMsgs)}</a>
       <a href="#/u/${esc(me.username)}" class="${h === '#/u/' + me.username || h === '#/settings' ? 'on' : ''}"><i class="ni">👤</i><span>Profil</span></a>`
    : '';
}
async function refreshUnread() {
  if (!me) return;
  try {
    const d = await api('/api/unread');
    if (d.count !== unreadMsgs || (d.notifs || 0) !== unreadNotifs) { unreadMsgs = d.count; unreadNotifs = d.notifs || 0; renderNav(); }
  } catch {}
}
setInterval(refreshUnread, 15000);
async function logout() {
  try { await api('/api/logout', 'POST'); } catch {}
  token = null; me = null; unreadMsgs = unreadNotifs = 0; saveToken(null); location.hash = '#/'; route();
}

/* ---------- Connexion / inscription ---------- */
function authView(mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `<section class="auth">
    <h1>murmure</h1>
    <p class="lead">Dis ce que tu penses, partage des photos, écris en privé à tes amis.</p>
    <form id="authForm">
      <input name="username" placeholder="Pseudo" autocomplete="username" required minlength="3" maxlength="20">
      <input name="password" type="password" placeholder="Mot de passe" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="6">
      <p class="error" id="authErr"></p>
      <button class="btn">${reg ? 'Créer mon compte' : 'Se connecter'}</button>
    </form>
    <button class="switch" id="sw">${reg ? 'J\'ai déjà un compte' : 'Pas de compte ? Inscris-toi'}</button>
  </section>`;
  $('#sw').onclick = () => authView(reg ? 'login' : 'register');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const d = await api(reg ? '/api/register' : '/api/login', 'POST', { username: f.get('username'), password: f.get('password') });
      token = d.token; me = d.user; saveToken(token);
      location.hash = '#/'; route();
    } catch (er) { $('#authErr').textContent = er.message; }
  };
}

/* ---------- Messages publics ---------- */
function postHTML(p) {
  const open = openComments.has(p.id);
  return `<article class="card post" data-id="${p.id}">
    ${avatar(p.author, p.avatar)}
    <div>
      <div class="meta"><a class="author" href="#/u/${esc(p.author)}">@${esc(p.author)}</a><span>${ago(p.createdAt)}</span>
        ${p.mine ? '<button class="link" data-act="del">Supprimer</button>' : ''}</div>
      ${p.text ? `<p>${esc(p.text)}</p>` : ''}
      ${p.image ? `<a href="${imgURL(p.image)}" target="_blank" rel="noopener"><img class="photo" src="${imgURL(p.image)}" loading="lazy" alt="Photo de @${esc(p.author)}"></a>` : ''}
      <div class="actions">
        <button data-act="like" class="${p.liked ? 'on' : ''}" aria-label="J'aime">${p.liked ? '♥' : '♡'} ${p.likes}</button>
        <button data-act="toggle" aria-label="Commentaires">💬 ${p.comments.length}</button>
      </div>
      <div class="comments ${open ? '' : 'hidden'}">
        ${p.comments.map((c) => `<div class="comment"><b>@${esc(c.author)}</b> ${esc(c.text)}${c.mine || p.mine ? ` <button class="link x" data-act="delc" data-cid="${c.id}" aria-label="Supprimer le commentaire">✕</button>` : ''}</div>`).join('')}
        <form data-act="comment"><input maxlength="200" placeholder="Répondre…" required><button class="btn small">Envoyer</button></form>
      </div>
    </div>
  </article>`;
}
const postsHTML = (list, empty) => list.length ? list.map(postHTML).join('') : `<p class="empty">${empty}</p>`;

function composerHTML() {
  return `<form class="card composer" id="composer">
    <textarea maxlength="280" placeholder="Quoi de neuf ?"></textarea>
    <div id="preview" class="preview hidden"></div>
    <div class="row"><span class="count">0 / 280</span>
      <span class="rowbtns"><label class="btn ghost small photo-btn">📷 Photo<input type="file" accept="image/*" hidden id="photoIn"></label><button class="btn small">Publier</button></span></div>
  </form>`;
}
function bindComposer() {
  const ta = $('#composer textarea');
  const photo = { data: null };
  ta.oninput = () => { $('.count').textContent = ta.value.length + ' / 280'; };
  bindPhotoPicker($('#photoIn'), $('#preview'), photo);
  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    if (!ta.value.trim() && !photo.data) return toast('Écris un message ou ajoute une photo');
    try {
      const image = await uploadIfAny(photo);
      await api('/api/posts', 'POST', { text: ta.value, image });
      route();
    } catch (er) { toast(er.message); }
  };
}

async function feedView() {
  const posts = await api('/api/feed?scope=' + scope);
  app.innerHTML = composerHTML() + `<div class="tabs">
      <button data-scope="all" class="${scope === 'all' ? 'on' : ''}">Tout le monde</button>
      <button data-scope="following" class="${scope === 'following' ? 'on' : ''}">Abonnements</button></div>
    <div id="list">${postsHTML(posts, scope === 'all' ? 'Aucun message pour l\'instant. Publie le premier !' : 'Abonne-toi à des profils pour voir leurs messages ici.')}</div>`;
  bindComposer();
  app.querySelectorAll('[data-scope]').forEach((b) => (b.onclick = () => { scope = b.dataset.scope; route(); }));
  // Propose d'actualiser quand de nouveaux messages arrivent
  const topId = posts[0] ? posts[0].id : null;
  pollTimer = setInterval(async () => {
    try {
      const f = await api('/api/feed?scope=' + scope);
      if ((f[0] ? f[0].id : null) !== topId && !$('#newBanner')) {
        const b = document.createElement('button');
        b.id = 'newBanner'; b.className = 'btn small banner'; b.textContent = '↑ Nouveaux messages';
        b.onclick = route; app.prepend(b);
      }
    } catch {}
  }, 30000);
}

async function profileView(name) {
  const d = await api('/api/users/' + encodeURIComponent(name));
  const u = d.user, mine = u.id === me.id;
  app.innerHTML = `<section class="card profile">
      <div class="user-row">${avatar(u.username, u.avatar)}<h2>@${esc(u.username)}</h2></div>
      <p class="bio">${esc(u.bio) || '<span class="soft">Pas encore de bio.</span>'}</p>
      <div class="stats"><span><b>${u.followers}</b> abonnés</span><span><b>${u.following}</b> abonnements</span><span><b>${d.posts.length}</b> messages</span></div>
      ${mine
        ? `<a class="btn ghost" href="#/settings">⚙ Réglages</a>`
        : `<div class="rowbtns"><button class="btn ${d.isFollowing ? 'ghost' : ''}" id="follow">${d.isFollowing ? 'Se désabonner' : 'S\'abonner'}</button>
           <a class="btn ghost" href="#/m/${esc(u.username)}">✉ Message</a></div>`}
    </section>
    <div id="list">${postsHTML(d.posts, 'Aucun message.')}</div>`;
  if (!mine) $('#follow').onclick = async () => { try { await api('/api/users/' + u.username + '/follow', 'POST'); route(); } catch (er) { toast(er.message); } };
}

function searchView() {
  app.innerHTML = `<form class="card" id="sf"><input name="q" placeholder="Chercher un pseudo" maxlength="30" autofocus></form><div id="res"></div>`;
  const run = async (q) => {
    const list = await api('/api/search?q=' + encodeURIComponent(q));
    $('#res').innerHTML = list.length
      ? list.map((u) => `<a class="card user-row" href="#/u/${esc(u.username)}">${avatar(u.username, u.avatar)}<div><b>@${esc(u.username)}</b><br><small class="soft">${u.followers} abonnés</small></div></a>`).join('')
      : '<p class="empty">Aucun profil trouvé.</p>';
  };
  $('#sf').onsubmit = (e) => { e.preventDefault(); run(new FormData(e.target).get('q')).catch((er) => toast(er.message)); };
  run('').catch(() => {});
}

/* ---------- Notifications ---------- */
async function notifsView() {
  const list = await api('/api/notifications');
  unreadNotifs = 0; renderNav();
  const txt = { like: 'a aimé ton message', comment: 'a commenté ton message', follow: 's\'est abonné à toi' };
  app.innerHTML = `<h2 class="title">Notifications</h2>` + (list.length
    ? list.map((n) => `<a class="card user-row ${n.read ? '' : 'unread'}" href="${n.type === 'follow' ? '#/u/' + esc(n.from) : '#/u/' + esc(me.username)}">
        ${avatar(n.from, n.avatar)}
        <div class="grow"><b>@${esc(n.from)}</b> ${txt[n.type] || ''}${n.snippet ? `<small class="soft">« ${esc(n.snippet)} »</small>` : ''}</div>
        <small class="soft">${ago(n.createdAt)}</small></a>`).join('')
    : '<p class="empty">Rien pour l\'instant. Les j\'aime, commentaires et nouveaux abonnés apparaîtront ici.</p>');
}

/* ---------- Réglages ---------- */
async function settingsView() {
  me = await api('/api/me');
  const th = getTheme();
  app.innerHTML = `<h2 class="title">Réglages</h2>
    <section class="card set"><h3>Profil</h3>
      <div class="user-row">${avatar(me.username, me.avatar)}
        <label class="btn ghost small photo-btn">Changer la photo<input type="file" accept="image/*" hidden id="avIn"></label>
        ${me.avatar ? '<button class="link" id="avRm" type="button">Retirer</button>' : ''}</div>
      <form id="bioForm"><input name="bio" maxlength="160" placeholder="Ta bio (160 caractères)" value="${esc(me.bio)}"><button class="btn small">Enregistrer la bio</button></form>
    </section>
    <section class="card set"><h3>Apparence</h3>
      <div class="tabs" id="themes">
        ${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<button data-t="${k}" class="${th === k ? 'on' : ''}">${l}</button>`).join('')}
      </div></section>
    <section class="card set"><h3>Mot de passe</h3>
      <form id="pwForm"><input name="old" type="password" placeholder="Ancien mot de passe" autocomplete="current-password" required>
        <input name="new" type="password" placeholder="Nouveau (6 caractères min.)" autocomplete="new-password" minlength="6" required>
        <button class="btn small">Changer le mot de passe</button></form></section>
    <section class="card set"><h3>Compte</h3>
      <div class="rowbtns"><button class="btn ghost" id="lo">Se déconnecter</button><button class="link danger" id="del">Supprimer mon compte</button></div></section>`;
  $('#avIn').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const image = await uploadData(await toJpeg(f, 320)); await api('/api/me', 'PUT', { avatar: image }); toast('Photo mise à jour'); settingsView(); } catch (er) { toast(er.message); }
  };
  const rm = $('#avRm'); if (rm) rm.onclick = async () => { try { await api('/api/me', 'PUT', { avatar: null }); settingsView(); } catch (er) { toast(er.message); } };
  $('#bioForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/me', 'PUT', { bio: new FormData(e.target).get('bio') }); toast('Bio enregistrée'); } catch (er) { toast(er.message); }
  };
  $('#themes').onclick = (e) => { const t = e.target.dataset.t; if (t) { applyTheme(t); settingsView(); } };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('/api/me/password', 'POST', { old: f.get('old'), new: f.get('new') }); e.target.reset(); toast('Mot de passe changé'); } catch (er) { toast(er.message); }
  };
  $('#lo').onclick = logout;
  $('#del').onclick = async () => {
    if (!confirm('Supprimer définitivement ton compte, tes messages et tes photos ?')) return;
    const password = prompt('Entre ton mot de passe pour confirmer');
    if (!password) return;
    try { await api('/api/me', 'DELETE', { password }); token = null; me = null; saveToken(null); location.hash = '#/'; route(); } catch (er) { toast(er.message); }
  };
}

/* ---------- Messages privés ---------- */
async function messagesView() {
  const list = await api('/api/conversations');
  app.innerHTML = `<h2 class="title">Messages privés</h2>` + (list.length
    ? list.map((c) => `<a class="card user-row" href="#/m/${esc(c.user)}">${avatar(c.user, c.avatar)}
        <div class="grow"><b>@${esc(c.user)}</b><small class="soft">${esc(c.text)}</small></div>
        ${c.unread ? badge(c.unread) : ''}</a>`).join('')
    : '<p class="empty">Aucune conversation. Ouvre un profil et clique sur « Message ».</p>');
  refreshUnread();
}

async function threadView(name) {
  const path = '/api/messages/' + encodeURIComponent(name);
  const d = await api(path);
  app.innerHTML = `<div class="thread-head"><a href="#/messages" class="link">← Retour</a>${avatar(d.user.username, d.user.avatar)}<a class="author" href="#/u/${esc(d.user.username)}">@${esc(d.user.username)}</a></div>
    <div id="thread" class="thread"></div>
    <form id="dmForm" class="card dm">
      <div id="dmPreview" class="preview hidden"></div>
      <div class="dmrow"><label class="photo-btn ico" aria-label="Ajouter une photo">📷<input type="file" accept="image/*" hidden id="dmPhoto"></label>
        <input name="text" maxlength="1000" placeholder="Écrire un message…" autocomplete="off"><button class="btn small">Envoyer</button></div>
    </form>`;
  const box = $('#thread');
  let lastId = null;
  const draw = (msgs) => {
    const newest = msgs.length ? msgs[msgs.length - 1].id : null;
    box.innerHTML = msgs.length ? msgs.map((m) => `<div class="bubble ${m.mine ? 'mine' : ''}">
        ${m.image ? `<a href="${imgURL(m.image)}" target="_blank" rel="noopener"><img class="photo" src="${imgURL(m.image)}" alt="Photo"></a>` : ''}
        ${m.text ? `<span>${esc(m.text)}</span>` : ''}<small>${ago(m.createdAt)}</small></div>`).join('')
      : '<p class="empty">Aucun message. Dis bonjour !</p>';
    if (newest !== lastId) { lastId = newest; window.scrollTo(0, document.body.scrollHeight); }
  };
  draw(d.messages);
  const photo = { data: null };
  bindPhotoPicker($('#dmPhoto'), $('#dmPreview'), photo);
  $('#dmForm').onsubmit = async (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    if (!input.value.trim() && !photo.data) return;
    try {
      const image = await uploadIfAny(photo);
      await api(path, 'POST', { text: input.value, image });
      input.value = ''; photo.data = null; $('#dmPhoto').value = ''; $('#dmPreview').innerHTML = ''; $('#dmPreview').classList.add('hidden');
      draw((await api(path)).messages);
    } catch (er) { toast(er.message); }
  };
  pollTimer = setInterval(async () => {
    try { draw((await api(path)).messages); refreshUnread(); } catch {}
  }, 4000);
}

/* ---------- Actions sur les messages publics (délégation) ---------- */
app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('.post');
  if (!btn || !card || btn.tagName === 'FORM') return;
  const pid = card.dataset.id;
  try {
    if (btn.dataset.act === 'like') { await api(`/api/posts/${pid}/like`, 'POST'); route(); }
    else if (btn.dataset.act === 'del') { if (confirm('Supprimer ce message ?')) { await api('/api/posts/' + pid, 'DELETE'); route(); } }
    else if (btn.dataset.act === 'delc') { await api(`/api/posts/${pid}/comments/${btn.dataset.cid}`, 'DELETE'); openComments.add(pid); route(); }
    else if (btn.dataset.act === 'toggle') { openComments.has(pid) ? openComments.delete(pid) : openComments.add(pid); card.querySelector('.comments').classList.toggle('hidden'); }
  } catch (er) { toast(er.message); }
});
app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-act="comment"]');
  if (!form) return;
  e.preventDefault();
  const pid = form.closest('.post').dataset.id;
  try { await api(`/api/posts/${pid}/comments`, 'POST', { text: form.querySelector('input').value }); openComments.add(pid); route(); } catch (er) { toast(er.message); }
});

/* ---------- Routeur ---------- */
async function route() {
  clearInterval(pollTimer);
  try {
    if (!me && token) {
      try { me = await api('/api/me'); } catch (er) { if (er.status === 401) { token = null; saveToken(null); } else throw er; }
    }
    renderNav();
    if (!me) return authView();
    refreshUnread();
    const h = location.hash || '#/';
    if (h.startsWith('#/u/')) return await profileView(decodeURIComponent(h.slice(4)));
    if (h.startsWith('#/m/')) return await threadView(decodeURIComponent(h.slice(4)));
    if (h.startsWith('#/messages')) return await messagesView();
    if (h.startsWith('#/notifs')) return await notifsView();
    if (h.startsWith('#/settings')) return await settingsView();
    if (h.startsWith('#/search')) return searchView();
    return await feedView();
  } catch (er) {
    if (er.status === 401) { token = null; me = null; saveToken(null); renderNav(); return authView(); }
    const msg = er.message === 'Route inconnue' ? 'Le serveur n\'est pas à jour : remplace server.js par la dernière version puis redémarre-le.' : er.message;
    app.innerHTML = `<p class="empty">${esc(msg)}<br><br><button class="btn small" id="retry">Réessayer</button></p>`;
    $('#retry').onclick = route;
  }
}
window.addEventListener('hashchange', route);
route();
