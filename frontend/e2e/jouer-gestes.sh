#!/usr/bin/env bash
# Joue e2e/gestes.spec.ts dans le conteneur `lab-runner`, contre le backend en
# service, avec le compte de test e2edev (son espace personnel sert de bac à
# sable ; tout ce qui est créé est préfixé zz- et supprimé à la fin).
#
#   LAB_ROOT=/chemin/du/depot/parent bash e2e/jouer-gestes.sh            # build local (dist/) servi à la place du frontend déployé
#   LAB_ROOT=…                     bash e2e/jouer-gestes.sh --deploye   # frontend réellement déployé
#   LAB_ROOT=…                     bash e2e/jouer-gestes.sh "rectangle" # un seul test (filtre sur le titre)
#   CAPTURES=/un/dossier …                                              # garde des captures d'écran
#
# Avant : `npm run build` (sauf --deploye). Un seul navigateur à la fois dans
# le runner (machine à 2 vCPU) : le script attend qu'il soit libre.
set -euo pipefail

LAB_ROOT="${LAB_ROOT:?LAB_ROOT doit pointer sur le dépôt parent (celui qui contient sso-lab/ et storage/)}"
FRONT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=/tmp/zz-storage-gestes
DEPLOYE=0
[[ "${1:-}" == "--deploye" ]] && { DEPLOYE=1; shift; }
FILTRE="${1:-}"

if [[ $DEPLOYE -eq 0 && ! -f "$FRONT/dist/storage-frontend/browser/index.html" ]]; then
  echo "Pas de build dans dist/ : lancer « npm run build » d'abord, ou passer --deploye." >&2; exit 2
fi

for _ in $(seq 1 90); do
  occupe=$(docker exec lab-runner sh -c "ps -eo pid,stat,args | awk '\$1!=1 && \$2 !~ /^Z/' | grep -E 'playwright|chrome|headless' | grep -v grep" || true)
  [[ -z "$occupe" ]] && break
  echo "runner occupé, attente…" >&2; sleep 10
done
[[ -n "${occupe:-}" ]] && { echo "runner toujours occupé, abandon" >&2; exit 3; }

DOMAINE=$(grep -E '^DOMAIN=' "$LAB_ROOT/storage/.env" | cut -d= -f2-)
MDP=$(grep -E '^E2EDEV_PASSWORD=' "$LAB_ROOT/sso-lab/.env" | cut -d= -f2-)

docker exec lab-runner rm -rf "$WORK"
docker exec lab-runner mkdir -p "$WORK/e2e" "$WORK/captures"
docker cp -q "$FRONT/e2e/gestes.spec.ts" "lab-runner:$WORK/e2e/"
ENV_DIST=()
if [[ $DEPLOYE -eq 0 ]]; then
  docker cp -q "$FRONT/dist/storage-frontend/browser" "lab-runner:$WORK/dist"
  ENV_DIST=(-e "E2E_GESTES_DIST=$WORK/dist")
fi

set +e
docker exec -w /app \
  -e E2E_GESTES=1 -e "E2E_APP_URL=https://$DOMAINE/storage/" -e E2E_USER=e2edev -e "E2E_PASSWORD=$MDP" \
  -e "E2E_DOMAIN=$DOMAINE" -e "E2E_TEST_DIR=$WORK/e2e" -e NODE_PATH=/app/node_modules \
  -e "E2E_GESTES_SHOTS=$WORK/captures" "${ENV_DIST[@]}" \
  lab-runner npx playwright test --config /app/playwright.config.ts --reporter=list ${FILTRE:+-g "$FILTRE"}
code=$?
set -e
if [[ -n "${CAPTURES:-}" ]]; then mkdir -p "$CAPTURES"; docker cp -q "lab-runner:$WORK/captures/." "$CAPTURES/" || true; fi
docker exec lab-runner rm -rf "$WORK"
exit $code
