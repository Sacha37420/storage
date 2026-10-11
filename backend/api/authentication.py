import jwt
from jwt import PyJWKClient, PyJWKClientError, InvalidTokenError
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed
from django.conf import settings

from .models import KnownUser


class KeycloakUser:
    """Minimal user object constructed from Keycloak JWT claims."""

    is_authenticated = True
    is_active = True
    is_service_account = False

    def __init__(self, claims: dict) -> None:
        self.email: str = claims.get('email', '')
        self.username: str = claims.get('preferred_username', self.email)
        self.claims = claims
        # Required by some DRF internals
        self.pk = self.email

    def __str__(self) -> str:
        return self.username


class KeycloakServiceUser:
    """Identité machine (client_credentials, pas d'utilisateur humain derrière).

    Construite pour un azp présent dans settings.KEYCLOAK_SERVICE_WRITE_SHARES
    et/ou KEYCLOAK_SERVICE_WRITE_PREFIXES — typiquement le compte de service
    '<app>-admin' d'une autre app du lab (même mécanisme que lab-admin/
    restauration pour administrer Keycloak, réutilisé ici pour écrire dans
    storage sans utilisateur connecté, ex. un worker Celery ou une décision
    d'autorisation déjà prise côté app appelante). Porte une ou deux
    capacités : lecture/écriture sur le partage exact `write_share` et/ou sur
    tout partage dont le nom commence par `write_prefix` (avec création
    automatique, cf. api.permissions.resolve_namespace) — jamais de namespace
    personnel, jamais de claim 'email'/'groups' à vérifier.
    """

    is_authenticated = True
    is_active = True
    is_service_account = True

    def __init__(self, client_id: str, write_share: str | None, write_prefix: str | None) -> None:
        self.client_id = client_id
        self.write_share = write_share
        self.write_prefix = write_prefix
        self.username = f'service:{client_id}'
        self.email = f'{client_id}@service.local'
        self.claims: dict = {}
        self.pk = self.username

    def __str__(self) -> str:
        return self.username


class KeycloakJWTAuthentication(BaseAuthentication):
    """
    Validates Keycloak Bearer JWT tokens using the realm's JWKS endpoint.

    The JWKS client is cached at the class level so keys are fetched once
    per process start-up and reused for all subsequent requests.
    """

    _jwks_client: PyJWKClient | None = None

    @classmethod
    def _get_jwks_client(cls) -> PyJWKClient:
        if cls._jwks_client is None:
            jwks_uri = (
                f'{settings.KEYCLOAK_ISSUER_URI}'
                '/protocol/openid-connect/certs'
            )
            cls._jwks_client = PyJWKClient(jwks_uri, cache_keys=True)
        return cls._jwks_client

    def authenticate(self, request):
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:]
        else:
            # Ni une balise <img src="…"> ni le fetch() interne d'un GLTFLoader
            # ne peuvent poser d'en-tête Authorization — sans ce fallback,
            # aucun média servi par storage ne pourrait être affiché en accès
            # direct depuis le frontend d'une autre app (objectif « accès
            # direct frontend → storage », cf. .claude/plans/
            # sharing-model-orchestration.md). Le même JWT Keycloak est alors
            # accepté en ?token=, et repasse PAR EXACTEMENT LES MÊMES contrôles
            # ci-dessous (signature JWKS, expiration, azp de confiance,
            # groupes) — seul l'emplacement du jeton change, jamais la
            # politique. Même pattern que atelier-3d/arbre-genealogique
            # (api/authentication.py et api/auth_extra.py respectivement) ;
            # contrairement à arbre-genealogique, qui isole ce fallback dans
            # une classe d'authentification séparée réutilisée sur une seule
            # vue (et qui, ce faisant, avait ré-implémenté le décodage JWT
            # SANS le contrôle azp/groupes — un point de divergence à ne pas
            # reproduire ici), on l'intègre directement dans l'unique classe
            # d'auth de storage : cette API a plusieurs vues qui doivent
            # toutes rester lisibles en <img>/GLTFLoader (tout /api/files/.../
            # content/...), dupliquer la classe aurait un jour fini par
            # oublier azp ou groups sur l'une d'elles.
            token = request.GET.get('token', '')
            if not token:
                return None

        try:
            client = self._get_jwks_client()
            signing_key = client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=['RS256'],
                options={
                    'verify_exp': True,
                    # Audience varies by Keycloak client configuration
                    'verify_aud': False,
                },
            )
        except InvalidTokenError as exc:
            raise AuthenticationFailed(f'Token invalide : {exc}') from exc
        except PyJWKClientError as exc:
            # Clé `kid` absente du JWKS, ou JWKS injoignable : PyJWKClientError
            # n'hérite pas d'InvalidTokenError. Sans cette branche, un jeton
            # forgé avec un `kid` quelconque provoquait une erreur 500.
            raise AuthenticationFailed('Token invalide : clé de signature introuvable.') from exc

        # Le token doit avoir été émis pour un client DE CONFIANCE. Sans ce
        # contrôle, n'importe quel token du realm est accepté : le realm expose
        # 'admin-cli' en client public autorisant le password grant, donc tout
        # compte — y compris un compte auto-inscrit — pourrait s'en servir pour
        # appeler cette API. On vérifie 'azp' plutôt que 'aud' car Keycloak ne
        # place pas le clientId dans 'aud' sans mapper d'audience dédié.
        #
        # Généralisation du pattern habituel (azp == KEYCLOAK_CLIENT_ID unique) :
        # cette API doit aussi être appelable par d'autres apps du lab, au nom de
        # leurs utilisateurs — leur frontend obtient un token dont 'azp' est SON
        # PROPRE client_id, jamais celui de 'storage'. KEYCLOAK_TRUSTED_CLIENTS
        # (liste blanche explicite, cf. CLAUDE.md) remplace l'égalité stricte
        # tout en conservant la même propriété de sécurité : 'admin-cli' n'y
        # figure jamais. Voir storage/.env pour l'ajout d'un nouveau client.
        azp = claims.get('azp')
        if azp not in settings.KEYCLOAK_TRUSTED_CLIENTS:
            raise AuthenticationFailed(
                f"Ce token a été émis par un client non autorisé : '{azp}'."
            )

        # Compte de service (client_credentials, cf. KeycloakServiceUser) : pas
        # d'utilisateur humain, donc pas de claim 'email'/'groups' à exiger — on
        # retourne immédiatement, avant les contrôles humains ci-dessous et sans
        # toucher à KnownUser (qui n'a de sens que pour de vrais comptes Keycloak).
        write_share = settings.KEYCLOAK_SERVICE_WRITE_SHARES.get(azp)
        write_prefix = settings.KEYCLOAK_SERVICE_WRITE_PREFIXES.get(azp)
        if write_share is not None or write_prefix is not None:
            return KeycloakServiceUser(azp, write_share, write_prefix), token

        # Cloisonnement par groupe. KEYCLOAK_REQUIRED_GROUPS vide ⇒ aucun filtre :
        # toute personne authentifiée sur ce client passe.
        required = {
            g.strip()
            for g in settings.KEYCLOAK_REQUIRED_GROUPS.split(',')
            if g.strip()
        }
        if required and not required & set(claims.get('groups') or []):
            raise AuthenticationFailed(
                'Accès réservé aux membres du/des groupe(s) : '
                f"{', '.join(sorted(required))}."
            )

        if not claims.get('email'):
            raise AuthenticationFailed(
                "Le token ne contient pas de claim 'email'. "
                "Vérifiez que le mapper 'email' est activé dans Keycloak."
            )

        user = KeycloakUser(claims)
        # Alimente le registre des comptes connus à chaque requête authentifiée
        # (pas seulement /api/me/) : c'est ce qui permet à la création d'un
        # partage de détecter une collision avec un username, cf. views.py.
        KnownUser.objects.update_or_create(
            email=user.email, defaults={'username': user.username},
        )

        return user, token
