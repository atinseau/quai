# Quai — isolation réseau, résultats

Question : deux projets peuvent-ils se scanner et se parasiter sur le réseau,
et peut-on l'empêcher ?

**Le problème est réel, et il existe trois remèdes qui marchent.**

## Le problème, mesuré

Sans rien faire, les projets partagent la même pile réseau. Un projet voisin :

- **scanne** et trouve les ports ouverts (`OPEN PORTS: 3001`)
- **se connecte** et lit les données (`REACHED SECRET-OF-alpha`)

Les comptes UNIX n'y changent rien : ils protègent les fichiers, pas les
sockets TCP. C'est confirmé expérimentalement, pas supposé.

## Les trois remèdes, tous validés

### B1. Socket Unix dans le home du projet — *le bon défaut*

Le projet n'écoute pas sur un port TCP mais sur `/home/<projet>/app.sock`.
Le socket hérite des permissions du home (0750), donc :

- beta est bloqué : `EACCES`
- alpha atteint toujours son propre socket
- **le scan ne trouve plus rien** : il n'y a plus aucun port à découvrir

Aucune capability requise. Fonctionne dans un conteneur Docker nu.
C'est l'isolation réseau obtenue gratuitement par l'isolation fichiers déjà en
place — le routeur Quai parle aux projets par socket, jamais par port.

### B2. Pare-feu par uid (`iptables -m owner --uid-owner`)

Une règle d'égress ciblée sur l'uid du projet :

    iptables -A OUTPUT -p tcp -m owner --uid-owner quai-beta \
             -d 127.0.0.1 -j REJECT

- beta est bloqué (`ECONNREFUSED`), alpha n'est pas affecté
- utile pour la **sortie** : empêcher un projet d'appeler l'extérieur, ou de
  joindre la base de données d'un autre

Nécessite `NET_ADMIN`.

### B3. Namespace réseau par projet

`unshare --net` donne au projet sa propre pile : loopback vide, plus rien à
scanner. C'est l'isolation la plus forte des trois, et celle qui coûte le plus
cher (il faut créer une veth ou passer par socket activation pour le trafic
entrant).

Nécessite `NET_ADMIN` (+ `SYS_ADMIN` selon le montage de /proc).

## Recommandation

**B1 par défaut, B2 en option.** B1 supprime la classe entière du problème sans
demander la moindre permission : s'il n'y a pas de port ouvert, il n'y a ni
scan ni connexion possible. Ça impose une contrainte de design saine — un
projet Quai écoute sur le socket que le routeur lui donne via `$PORT`/`$SOCKET`,
comme sur Heroku ou Vercel.

B2 s'ajoute pour contrôler le trafic **sortant** (exfiltration, appels vers les
services voisins). B3 est réservé au cas « code tiers non fiable ».

Note : rien n'empêche un projet d'ouvrir quand même un port TCP en dur dans son
code. Le socket Unix est un défaut, pas une barrière. Pour rendre B1
contraignant il faut y ajouter B2 (bloquer tout `OUTPUT` vers loopback pour
l'uid du projet), ce qui referme la porte.

## Résultat

    7 passed, 2 failed

Les 2 échecs sont la section A : ils démontrent le problème, ils doivent
échouer.

Reproduire :

    docker build -t quai-probe .
    docker run --rm --cap-add=NET_ADMIN --cap-add=SYS_ADMIN \
      quai-probe bash /opt/net/probe-net.sh

Sans capabilities, seul B1 passe — ce qui est justement l'intérêt de B1.
