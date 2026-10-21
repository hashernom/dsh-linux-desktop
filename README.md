# DeepSeek Harness — app de escritorio

Envoltorio Electron de `dsh web`: arranca su propio servidor local, lo carga en
una ventana nativa y se lo lleva por delante al cerrar. No usa el navegador.

## Uso

- Menú de aplicaciones → **DeepSeek Harness**
- Icono del escritorio → **DeepSeek Harness**
- Terminal → `dsh-desktop`
- Bandeja del sistema → icono de la ballena junto al reloj

## Bandeja del sistema

Al cerrar la ventana la app **no se cierra**: se oculta a la bandeja y el
servidor sigue vivo, así que reabrir es instantáneo. El menú del icono tiene
*Abrir*, *Nueva sesión*, *Reiniciar servidor*, *Abrir registros* y *Salir*.

El interruptor **«Cerrar la ventana la oculta»** permite volver al
comportamiento clásico (cerrar = salir) sin tocar código. Se guarda en
`preferences.json` dentro del directorio de estado.

Si el escritorio no soporta bandeja, la app lo detecta y desactiva el modo
automáticamente para que cerrar la ventana siga saliendo.

## Cómo funciona

1. Resuelve el binario `dsh` (`DSH_BIN`, `~/.local/bin`, nvm, `PATH`).
2. Lanza `dsh web --no-open --port 0` con su propio grupo de procesos.
3. Lee del stdout la línea `dsh web: http://127.0.0.1:PUERTO/?token=…`.
4. Carga esa URL en la ventana; mientras tanto muestra un splash.
5. Al salir manda `SIGTERM` al grupo (servidor + MCPs) y `SIGKILL` si no cede.

Comparte `~/.dsh` con el CLI: mismas sesiones, MCPs, credenciales y perfiles.

## Rutas

| Qué | Dónde |
|---|---|
| App | `~/.local/share/deepseek-harness-desktop/` |
| Lanzador | `~/.local/bin/dsh-desktop` |
| Entrada de menú | `~/.local/share/applications/deepseek-harness.desktop` |
| Iconos | `~/.local/share/icons/hicolor/*/apps/deepseek-harness.*` |
| Estado, preferencias y logs | `~/.local/state/deepseek-harness/` |
| Perfil de Chromium | `~/.config/deepseek-harness/` |

## Actualizaciones

La app comprueba `@deepseek-ai/dsh` contra el registro de npm:

- **Manual**: menú *Ayuda → Buscar actualizaciones…* o el mismo ítem en la bandeja.
  Muestra versión instalada y disponible, con botones *Actualizar ahora*, *Ver novedades* y *Más tarde*.
- **Automática**: una comprobación silenciosa al arrancar, como mucho cada 12 h.
  Si hay versión nueva avisa con una notificación (una vez por versión) y no instala nada sola.

Actualizar ejecuta `npm install -g @deepseek-ai/dsh@latest` con el npm que corresponde
al `dsh` detectado (por ejemplo el de nvm) y, si tiene éxito, reinicia el servidor local.
Desmarcar *Ayuda → Comprobar al iniciar* desactiva la comprobación automática.

La app en sí (Electron) no se autoactualiza: para eso, haz `git pull` en el repo y
`npm install` si cambiaron dependencias.

## Variables

| Variable | Efecto |
|---|---|
| `DSH_BIN` | Ruta explícita al binario `dsh` |
| `DSH_DESKTOP_SANDBOX=1` | Fuerza el sandbox de Chromium |
| `DSH_DESKTOP_NO_SANDBOX=1` | Fuerza `--no-sandbox` (equipos sin namespaces de usuario) |
| `DSH_DESKTOP_CAPTURE` | Ruta PNG: captura la ventana y sale (pruebas) |
| `DSH_DESKTOP_CAPTURE_DELAY` | ms de espera antes de capturar (por defecto 6000) |
| `DSH_DESKTOP_TEST_HIDE` | Prueba: cierra la ventana y verifica que queda en la bandeja |
| `DSH_DESKTOP_TEST_UPDATE` | Prueba: ejecuta el comprobador de actualizaciones y sale |

## Diagnóstico

```bash
tail -f ~/.local/state/deepseek-harness/logs/desktop.log   # arranque y errores
tail -f ~/.local/state/deepseek-harness/logs/server.log    # salida de dsh web
```

El sandbox de Chromium necesita namespaces de usuario sin privilegios o un
`chrome-sandbox` setuid. Si ninguno está disponible, el lanzador cae a
`--no-sandbox` para que la app no muera en silencio.

## Desinstalar

```bash
./uninstall.sh
```
