# Quai — prototype d'isolation, résultats

Question posée : dans **un seul conteneur Debian géré par Coolify**, peut-on
créer un compte UNIX par projet à la volée, empêcher un projet de lire le home
d'un autre, et plafonner sa mémoire pour qu'un projet fou n'emporte pas ses
voisins ?

**Réponse : oui, à une condition de lancement précise.**

## Résultat

    12 passed, 0 failed
    VERDICT: the Quai single-container model holds.

Reproduire :

    docker build -t quai-probe .
    docker run --rm --cgroupns=host \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw quai-probe

## Ce qui marche sans rien demander

L'isolation fichiers fonctionne dans un `docker run` nu, sans capability
supplémentaire, sans `--privileged` :

- `useradd` à la volée : OK (uid 1000, 1001, …)
- beta ne peut ni lire, ni lister, ni écrire dans le home d'alpha
- la traversée par `..` ne contourne pas le `chmod 0750`
- alpha garde l'accès à ses propres fichiers
- `node` tourne bien sous l'uid du projet via `setpriv`

Autrement dit : **le cœur de l'idée « un compte par projet » tient debout.**

## Le point dur : le plafond mémoire

Trois configurations testées :

| Lancement | Isolation fichiers | Cap mémoire |
|---|---|---|
| `docker run` nu (défaut Coolify) | OK | **NON** — /sys/fs/cgroup en lecture seule |
| `-v /sys/fs/cgroup:rw` seul | OK | **NON** — le cap s'écrit mais reste inopérant |
| `--cgroupns=host` + montage rw | OK | **OUI** — OOM kill à 64 Mi |

Le cas du milieu est un piège : `memory.max` s'écrit sans erreur, on croit que
c'est bon, et le hog alloue quand même 512 Mi. La cause est que le conteneur,
dans son propre cgroup namespace, se voit à la racine `0::/` et ne peut pas
déplacer un pid ailleurs — `cgroup.procs` renvoie `No such file or directory`.
Rien dans `memory.events` : le process n'était jamais entré dans le cgroup.
Il faut `--cgroupns=host` pour que le conteneur voie son vrai chemin
(`/docker/<id>`) et puisse y créer des enfants.

Deuxième subtilité : un cgroup ne peut pas à la fois héberger des processus et
déléguer des contrôleurs à ses enfants (règle « no internal process »). Le
superviseur doit donc d'abord se déplacer dans une feuille à lui avant
d'activer `+memory`. Sans ça, `subtree_control` échoue.

`--privileged` **ne suffit pas** et n'est pas la solution : testé, il échoue là
où le montage explicite réussit. Inutile d'élargir les privilèges.

## Conséquence pour Coolify

Quai ne peut pas être un conteneur Coolify tout à fait ordinaire : il lui faut
`--cgroupns=host` et le montage rw de `/sys/fs/cgroup`, donc un déploiement par
Docker Compose avec ces options, pas un simple « déployer une image ».
C'est plus intrusif qu'un conteneur standard, mais bien moins que de donner le
Docker de l'hôte comme le réclameraient Dokku ou CapRover.

Si ces options s'avéraient indisponibles, le repli est de plafonner par
processus (`--max-old-space-size`, `RLIMIT_AS` via ulimit), moins robuste car un
projet peut les contourner, mais suffisant contre l'accident.

## Limite assumée

Ceci valide l'isolation **fichiers et mémoire**, pas une frontière de sécurité
contre du code hostile : noyau partagé, pas de filtrage de syscalls, pas
d'isolation réseau entre projets. Pour tes propres projets c'est le bon
compromis. Pour héberger du code tiers non fiable, il faudrait descendre vers
nsjail (seccomp) ou des microVM.

## Fichiers

- `Dockerfile` — Debian bookworm + Node 22
- `probe.sh` — la sonde complète, 12 vérifications
- `hog.js` — allocateur de 512 Mi, doit se faire tuer
- `cgroup-check.sh` — sonde réduite au seul problème cgroup, utile au débogage
