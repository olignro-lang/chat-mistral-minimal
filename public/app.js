const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const history = [];

const classifyForm = document.getElementById('classify-form');
const eleveSelect = document.getElementById('eleve');
const photoInput = document.getElementById('photo');
const commentInput = document.getElementById('comment');
const classifyBtn = document.getElementById('classify-btn');
const classifyResult = document.getElementById('classify-result');
const domainesList = document.getElementById('domaines');

async function loadDomaines() {
  try {
    const res = await fetch('/api/domaines');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    domainesList.replaceChildren(
      ...data.domaines.map((d) => {
        const li = document.createElement('li');
        li.textContent = d;
        return li;
      })
    );
  } catch (error) {
    domainesList.textContent = `Impossible de charger les domaines : ${error.message}`;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function classify(event) {
  event.preventDefault();
  const eleve = eleveSelect.value.trim();
  const comment = commentInput.value.trim();
  if (!eleve || !comment || !photoInput.files || !photoInput.files[0]) return;
  classifyBtn.disabled = true;
  classifyResult.hidden = false;
  classifyResult.className = 'result pending';
  classifyResult.textContent = 'Classification et envoi vers Google Drive en cours…';
  try {
    const body = {
      eleve,
      comment,
      imageDataUrl: await readFileAsDataUrl(photoInput.files[0]),
    };
    const res = await fetch('/api/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    classifyResult.className = 'result ok';
    classifyResult.replaceChildren();
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = data.domaine;
    const p = document.createElement('p');
    p.textContent = data.justification;
    classifyResult.append(badge, p);
    if (data.lienPartage) {
      const lien = document.createElement('p');
      const a = document.createElement('a');
      a.href = data.lienPartage;
      a.textContent = `${location.origin}${data.lienPartage}`;
      a.target = '_blank';
      a.rel = 'noopener';
      lien.append('Lien à partager avec les parents : ', a);
      classifyResult.append(lien);
    }
    if (data.photoLink) {
      const a = document.createElement('a');
      a.href = data.photoLink;
      a.textContent = 'Voir la photo dans Google Drive';
      a.target = '_blank';
      a.rel = 'noopener';
      classifyResult.append(a);
    }
    classifyForm.reset();
  } catch (error) {
    classifyResult.className = 'result error';
    classifyResult.textContent = `Erreur : ${error.message}`;
  } finally {
    classifyBtn.disabled = false;
  }
}

const nouvelEleveInput = document.getElementById('nouvel-eleve');
const ajouterEleveBtn = document.getElementById('ajouter-eleve');
const appView = document.getElementById('app');
const loginView = document.getElementById('login-view');

async function loadEleves() {
  try {
    const res = await fetch('/api/eleves');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    eleveSelect.replaceChildren();
    if (data.eleves.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Aucun élève — ajoutez-en un ci-dessous';
      option.disabled = true;
      option.selected = true;
      eleveSelect.append(option);
      return;
    }
    for (const nom of data.eleves) {
      const option = document.createElement('option');
      option.value = nom;
      option.textContent = nom;
      eleveSelect.append(option);
    }
  } catch (error) {
    eleveSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = `Erreur : ${error.message}`;
    eleveSelect.append(option);
  }
}

async function ajouterEleve() {
  const nom = nouvelEleveInput.value.trim();
  if (!nom) return;
  ajouterEleveBtn.disabled = true;
  try {
    const res = await fetch('/api/eleves', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nom }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    nouvelEleveInput.value = '';
    await loadEleves();
  } catch (error) {
    alert(`Erreur : ${error.message}`);
  } finally {
    ajouterEleveBtn.disabled = false;
  }
}

async function init() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error('non authentifié');
    const me = await res.json();
    document.getElementById('user-email').textContent = me.email;
    appView.hidden = false;
    await Promise.all([loadDomaines(), loadEleves()]);
  } catch {
    loginView.hidden = false;
  }
}

ajouterEleveBtn.addEventListener('click', () => void ajouterEleve());
classifyForm.addEventListener('submit', classify);
void init();

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const label = document.createElement('span');
  label.className = 'role';
  label.textContent = role === 'user' ? 'Vous' : 'Mistral';
  const body = document.createElement('p');
  body.textContent = text;
  div.append(label, body);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send.disabled = true;
  addMessage('user', text);
  history.push({ role: 'user', content: text });
  const pending = addMessage('assistant', '…');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    pending.querySelector('p').textContent = data.reply;
    history.push({ role: 'assistant', content: data.reply });
  } catch (error) {
    pending.querySelector('p').textContent = `Erreur : ${error.message}`;
    pending.classList.add('error');
  } finally {
    send.disabled = false;
    input.focus();
  }
});
