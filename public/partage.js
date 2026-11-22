const contenu = document.getElementById('contenu');
const titre = document.getElementById('titre');
const sousTitre = document.getElementById('sous-titre');

const ORDRE_DOMAINES = [
  'Appartenance et contribution',
  'Autorégulation et bien-être',
  'Manifestation des habiletés en littératie et en mathématiques',
  'Résolution de problèmes et innovation',
];

const segments = location.pathname.split('/').filter(Boolean);
const eleve = segments.length > 1 ? decodeURIComponent(segments[1]) : '';
const code = new URLSearchParams(location.search).get('code') || '';

function afficherMessage(msg, classe) {
  contenu.replaceChildren();
  const p = document.createElement('p');
  p.className = `result ${classe}`;
  p.textContent = msg;
  contenu.append(p);
}

async function main() {
  if (!eleve || !code) {
    afficherMessage("Lien invalide : il manque le nom de l'élève ou le code d'accès.", 'error');
    return;
  }
  titre.textContent = `Compte de ${eleve}`;
  sousTitre.textContent = 'Observations classées par domaine PMJE';
  try {
    const res = await fetch(
      `/api/eleves/${encodeURIComponent(eleve)}/observations?code=${encodeURIComponent(code)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
    const observations = data.observations || [];
    if (observations.length === 0) {
      afficherMessage('Aucune observation pour le moment.', 'pending');
      return;
    }
    contenu.replaceChildren();
    for (const domaine of ORDRE_DOMAINES) {
      const liste = observations.filter((o) => o.domaine === domaine);
      if (liste.length === 0) continue;
      const section = document.createElement('section');
      section.className = 'domaine-section';
      const h2 = document.createElement('h2');
      h2.textContent = domaine;
      section.append(h2);
      for (const o of liste) {
        const card = document.createElement('article');
        card.className = 'obs-card';
        if (o.photoUrl) {
          const img = document.createElement('img');
          img.src = o.photoUrl;
          img.alt = o.commentaire || "Photo de l'observation";
          img.loading = 'lazy';
          card.append(img);
        }
        const date = document.createElement('p');
        date.className = 'date';
        date.textContent = o.date ? new Date(o.date).toLocaleDateString('fr-CA') : '';
        const commentaire = document.createElement('p');
        commentaire.className = 'commentaire';
        commentaire.textContent = o.commentaire || '';
        const justification = document.createElement('p');
        justification.className = 'justification';
        justification.textContent = o.justification || '';
        card.append(date, commentaire, justification);
        section.append(card);
      }
      contenu.append(section);
    }
  } catch (error) {
    afficherMessage(`Erreur : ${error.message}`, 'error');
  }
}

void main();
