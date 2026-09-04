# CAPITAL · IPHONE-ARCH-01

Arnés técnico desechable autorizado por CENTRAL para FASE 2 de CAPITAL APP.

## Restricción principal

**Usar exclusivamente datos sintéticos.** No introducir información financiera real.

## Qué prueba

- P1: instalación Home Screen Web App.
- P2: apertura offline.
- P3: Storage API / persist() / quota.
- P4: persistencia IndexedDB tras cierre/reinicio.
- P5: atomicidad ante abort inducido.
- P6: backup cifrado exportado fuera del origen.
- P7: pérdida total del storage local.
- P8: restauración desde archivo externo.
- P9: rechazo de backup corrupto sin daño.
- P10: migración sintética v0→v1 y rollback por slots.

## Hosting

Debe servirse desde HTTPS. GitHub Pages es suficiente para este spike porque todo el contenido es estático y los datos de prueba son sintéticos.

No reutilizar automáticamente este código como código de producción.
