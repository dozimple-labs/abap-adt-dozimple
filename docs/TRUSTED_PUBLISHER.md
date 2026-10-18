# Publicación en npm: estado del trusted publishing

Estado al 18-10-2026. Versión publicada: **1.6.1** (`latest`); `next` apunta a `1.0.0-rc.1`, una prueba antigua.

## Cómo se publica una versión

1. Un PR `release: X.Y.Z` sube `package.json`, `package-lock.json`, el CHANGELOG (cabecera de la versión) y los
   READMEs. Se fusiona en `main` con el CI en verde.
2. Se crea la etiqueta `vX.Y.Z` sobre ese commit y se empuja. El flujo `release.yml` arranca solo con etiquetas `v*`.
3. **Job `build`** (sin aprobación): comprueba que la etiqueta coincide con `package.json`, `npm ci --ignore-scripts`,
   pruebas, build, `npm audit` (falla desde **alto**; los moderados aceptados están en `SECURITY.md`),
   `npm audit signatures`, escáner de datos sensibles, `npm pack`, SBOM CycloneDX y **atestación de procedencia**
   (Sigstore, `actions/attest-build-provenance`). Todo queda como artefacto 30 días.
4. **Job `publish`** (entorno `release`, **aprobación manual** en GitHub → Actions → Release → Review deployments):
   publica el tarball ya construido con `npm publish --provenance` por **OIDC**: no hay token de npm guardado en
   ningún sitio. Si la versión ya existe en npm, no republica. Después comprueba las etiquetas (`latest` o `next`
   según sea versión final o pre-release) y crea la release de GitHub con el tarball, el bundle de la atestación y el SBOM.

Quién aprueba: el entorno `release` solo acepta aprobadores configurados en el repositorio.

## Qué garantiza

- **Procedencia verificable**: `npm view @dozimple/abap-adt@X.Y.Z dist.attestations` muestra la atestación SLSA v1, y
  `gh attestation verify dozimple-abap-adt-X.Y.Z.tgz --repo dozimple-labs/abap-adt-dozimple` la comprueba.
- **Sin secretos de larga duración**: ni token de npm ni clave de firma; OIDC de GitHub Actions en los dos jobs.
- **Lo publicado es lo probado**: el tarball se construye y se prueba en `build` y `publish` solo lo sube.
- **Acciones fijadas por commit**, permisos mínimos por job (`read-all` por defecto).

## Historial

| Versión | Fecha | Notas |
|---|---|---|
| 1.6.1 | 18-10-2026 | Primera publicación con la auditoría en nivel «alto» en el flujo de release (#70). El primer intento de la 1.6.0 falló por el nivel «moderado» con un hallazgo aceptado. |
| 1.6.0 | 06-10-2026 | |
| 1.5.0 | 04-10-2026 | |
| 1.0.0 → 1.4.0 | sep-2026 | Trusted publishing configurado desde la 1.0.0. |

## Pendientes

- Decidir qué hacer con la etiqueta `next` (`1.0.0-rc.1`): dejarla o moverla a la siguiente pre-release.
- Documentar en el README cómo verificar la atestación (ya está en la sección de instalación).
