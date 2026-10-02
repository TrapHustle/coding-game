# ⚔️ Code Royale

QCM d'informatique multijoueur en temps réel, façon **battle royale**, avec **deux modes de jeu** :

- 🏁 **Course** — 20 questions = 20 cases. Chaque bonne réponse fait avancer ton avatar sur la piste, avec des checkpoints et un sprint final.
- 🥊 **Combat** — tout le monde a la même question en même temps. Bonne réponse = tu lances une bombe 💣 sur ceux qui se trompent et tu es immunisé 🛡️. 0 PV = K.O. Le dernier debout gagne.

Les sujets sont regroupés en **3 catégories** :

| Catégorie | Sujets |
|---|---|
| 💻 Développement | JavaScript, Python, Java, C#, PHP, SQL, HTML/CSS |
| ☁️ Systèmes & Cloud | Git, Linux, Docker, Kubernetes, AWS, Azure |
| 🛡️ IA & Cybersécurité | Intelligence Artificielle, Cybersécurité |

On peut jouer un sujet précis, le **Mix** d'une catégorie, ou le **Mix Tech** (tous les sujets).

## Lancer le jeu

```bash
npm install     # la première fois seulement
npm start
```

Le terminal affiche deux adresses :

- `http://localhost:3000` : pour jouer sur ce PC ;
- `http://192.168.x.x:3000` : à donner aux autres joueurs connectés au **même Wi-Fi** (téléphones, autres PC).

> Windows : à la première exécution, autoriser Node.js dans la fenêtre du pare-feu, sinon les autres appareils ne pourront pas se connecter.

Pour changer de port : `set PORT=8080 && npm start` (cmd) ou `$env:PORT=8080; npm start` (PowerShell).

## Déroulement

1. **Créer** : pseudo, avatar, couleur, **mode** (Course ou Combat), sujet du QCM, temps par question (10/15/20/30 s), et — en Course — le nombre de vies (1/3/5/∞).
2. **Inviter** : partager le code à 5 lettres ou le lien du salon. On peut aussi rejoindre en **spectateur** (pratique pour un vidéoprojecteur).
3. **Lancer** : l'hôte démarre et peut encore changer le mode et le sujet dans le salon avant de lancer.

## Règles — 🏁 Course

| Situation | Effet |
|---|---|
| Bonne réponse | +1 case, 100 pts + jusqu'à 100 pts de rapidité, bonus de série dès 3 bonnes réponses d'affilée |
| Mauvaise réponse / temps écoulé | −1 vie, on reste sur place, la question revient plus tard |
| Checkpoint 🚩 (cases 5, 10, 15) | +1 vie, bonus de 150/100/50 pts pour les 3 premiers |
| 0 vie | Éliminé 💀 (on continue à regarder) |
| 1re arrivée ou dernier survivant | Sprint final : 45 s pour les autres |

## Règles — 🥊 Combat

| Situation | Effet |
|---|---|
| Départ | 100 PV chacun |
| Bonne réponse | Tu es **immunisé** 🛡️ et tu lances une **bombe** 💣 sur chaque adversaire qui s'est trompé (plus tu réponds vite, plus elle fait mal) ; points + bonus par bombe placée + 200 pts par K.O. |
| Mauvaise réponse / temps écoulé | Tu encaisses les bombes des autres (dégâts plafonnés par manche) |
| 0 PV | **K.O.** 💥 (on continue à regarder) |
| Fin | Dernier debout, ou meilleur total de PV après 20 manches. Bonus de survie = PV restants ×2 |

## 🎙️ Chat vocal

Un bouton **🎧** apparaît en haut à droite dès que tu es dans un salon. Cliquer dessus te fait **rejoindre le chat vocal** (le navigateur demande l'autorisation du micro), et un bouton **🎙️** permet de couper/réactiver ton micro. L'audio circule en **pair-à-pair (WebRTC)** entre les joueurs ; le serveur ne fait que les mettre en relation. Un halo vert entoure celui qui parle, et un 🎙 marque qui est dans le vocal.

> **Le micro n'est autorisé qu'en HTTPS.** Le vocal marche donc via `http://localhost:3000` (sur ton PC) ou via un lien **https** (tunnel Cloudflare, Render…), mais **pas** via l'adresse `http://192.168.x.x` du Wi-Fi local — le navigateur y bloque le micro. Idéal jusqu'à ~6-8 joueurs en vocal (réseau maillé).

## Ajouter des questions ou un sujet

Tout est dans [questions.js](questions.js). **La première option est toujours la bonne réponse** (les options sont mélangées à chaque partie). Il faut au moins 20 questions par sujet.

```js
Q(`Quelle commande liste les fichiers ?`, [`ls`, `list`, `show`, `dir -all`]),
Q(`Qu'affiche ce code ?`, [`3`, `2`, `1`, `Erreur`], `print(len([1, 2, 3]))`),
```

Pour créer un **nouveau sujet** : ajoute un bloc dans `THEMES` (avec `name`, `icon`, `kind`, `questions`), puis range son id dans une des catégories de `CATEGORIES`, dans [server.js](server.js).

## Déploiement en ligne

Ce jeu est un **serveur Node.js temps réel (Socket.IO)** : il garde les salons, les minuteurs et la course **en mémoire**, et chaque joueur reste connecté en continu. Il faut donc un hébergeur qui fait tourner un **processus Node permanent** et accepte les **WebSockets**.

### ✅ Recommandé : Render (gratuit, en quelques clics)

1. Mets le dossier `code-royale` sur **GitHub** (voir plus bas).
2. Sur [render.com](https://render.com) → **New** → **Web Service** → connecte ton dépôt.
3. Réglages : Environment = **Node**, Build Command = `npm install`, Start Command = `npm start`. Laisse Render fournir le `PORT` (le serveur le lit déjà via `process.env.PORT`).
4. Déploie : tu obtiens une URL `https://…onrender.com` à partager avec le monde entier.

**Railway**, **Fly.io** ou **Koyeb** fonctionnent pareil (processus Node + WebSockets), avec `npm start` comme commande de démarrage.

Mettre sur GitHub :
```bash
cd code-royale
git init
git add .
git commit -m "Code Royale"
# crée un dépôt vide sur github.com puis :
git remote add origin https://github.com/<toi>/code-royale.git
git push -u origin main
```

### ⚠️ À propos de Vercel

**Vercel n'est pas adapté à ce jeu tel qu'il est.** Vercel exécute des **fonctions serverless** éphémères : pas de serveur WebSocket permanent, pas de mémoire partagée entre deux appels, et les `setTimeout` qui font tourner la course/le combat s'arrêtent dès la fin d'une requête. Or ici tout l'état (salons, PV, minuteurs) vit en mémoire dans un processus qui tourne en continu. Déployé tel quel sur Vercel, le jeu ne tiendrait pas une partie.

Pour y arriver **sur Vercel**, il faudrait réécrire l'architecture :
- déplacer le temps réel vers un service externe de WebSockets (Ably, Pusher, Supabase Realtime…) ;
- déplacer l'état partagé (salons, scores, minuteurs) dans une base externe type **Redis** (Upstash) ;
- transformer la logique du serveur en fonctions serverless déclenchées par événements.

C'est un vrai chantier. **Le plus simple pour mettre le jeu en ligne dès maintenant : Render (ou Railway/Fly.io).** Garde Vercel pour des sites statiques ou des API sans état.

### Tester vite sans rien déployer

Un tunnel depuis ton PC, par exemple :
```bash
cloudflared tunnel --url http://localhost:3000
```
puis partage l'URL `https://…` générée (ton PC doit rester allumé).

## Structure

- `server.js` : serveur Express + Socket.IO (salons, modes Course **et** Combat, minuteurs, classement). C'est le serveur qui fait foi : la bonne réponse n'est jamais envoyée avant que tu répondes.
- `questions.js` : banque de questions (15 sujets).
- `public/` : interface (HTML/CSS/JS sans framework) — piste SVG animée (Course) et arène avec bombes (Combat).
