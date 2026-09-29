<p align="center">
  <img src="docs/banner.png" alt="Viciont Studios Launcher" width="760">
</p>

<h1 align="center">Viciont Studios Launcher</h1>

<p align="center">
  El launcher de Minecraft oficial de <b>Viciont Studios</b>, creado por <b>CrissyjuanxD</b>.<br>
  Instancias públicas y privadas, cuentas premium y no premium, skins, y descargas rápidas y seguras.
</p>

<p align="center">
  <a href="https://github.com/CrissyjuanxD/Viciont-Studio-Launcher/releases/latest"><b>⬇ Descargar para Windows</b></a>
  ·
  <a href="https://viciontstudios.pages.dev/#launcher">Web de Viciont Studios</a>
</p>

---

## Descargar

1. Entra en **[Releases](https://github.com/CrissyjuanxD/Viciont-Studio-Launcher/releases/latest)** y descarga `Viciont-Studios-Launcher-Setup-X.Y.Z.exe`.
2. Si el navegador avisa de que el archivo *"no se descarga habitualmente"*, no es un virus: el instalador es nuevo y no está firmado con un certificado de pago, así que Microsoft todavía no lo conoce.
   - **Edge:** en Descargas, pulsa la flecha **⌄** junto a *Eliminar* → **Conservar** → **Mostrar más** → **Conservar de todas formas**.
   - **Chrome:** en Descargas, pulsa **Conservar** (o *Descargar archivo no seguro*).
3. Ábrelo. Si Windows muestra *"Windows protegió tu PC"*, pulsa **Más información → Ejecutar de todas formas**.
4. Elige dónde instalarlo y listo. El launcher se **actualiza solo**: cuando hay una versión nueva, arriba a la izquierda sale el botón **Hay una versión disponible** (con el progreso de la descarga). Cuando termina, al pulsarlo el launcher se cierra unos segundos y se vuelve a abrir ya actualizado, sin abrir ningún instalador; si no, se actualiza solo la próxima vez que lo cierres. Cada versión nueva cambia su nombre, por ejemplo *Viciont Studios Launcher 1.0.1*.

Requisitos: Windows 10 u 11 de 64 bits. No necesitas tener Java instalado: el launcher descarga el Java oficial que necesita cada versión de Minecraft.

## Capturas

| | |
|---|---|
| ![Inicio de sesión](docs/screens/login.webp) | ![Inicio](docs/screens/inicio.webp) |
| ![Instancia](docs/screens/instancia.webp) | ![Descargando](docs/screens/descargando.webp) |
| ![Jugando](docs/screens/jugando.webp) | ![Skins](docs/screens/skins.webp) |
| ![Ajustes](docs/screens/ajustes.webp) | |

## Qué hace

**Para los jugadores**
- **Iniciar sesión** con una cuenta de Microsoft (premium) o solo con un nick (no premium). Con Microsoft funciona igual que Modrinth App y el launcher oficial: la contraseña se escribe **solo en la página oficial de Microsoft** y el launcher nunca la ve. No deja usar un nick de una cuenta premium: lo comprueba en la misma base de datos de Mojang que usa NameMC.
- Cada nick no premium queda **reservado** con un código de recuperación, para que nadie se haga pasar por otro. El launcher lo recuerda en tu PC (cifrado), así que puedes cerrar sesión y volver a entrar sin escribirlo.
- **Skins** para las dos cuentas, con visor 3D, biblioteca y "copiar skin de un nick", como en Modrinth:
  - Premium: la skin y la capa se cambian en tu cuenta de Minecraft y se ven en todas partes.
  - No premium: la skin se guarda en el servidor de Viciont Studios y la ven quienes juegan con este launcher, gracias a CustomSkinLoader, que se añade solo a las instancias con mods. Quien use otro launcher te verá con la skin por defecto.
- **Inicio** con todas las instancias que puedes jugar: en cada una se ve cuándo jugaste por última vez y cuánto tiempo llevas jugado. Abajo siempre queda el pie con las redes de Viciont Studios, aunque haya muchas instancias.
- **Barra lateral** con las instancias que tienes permiso para ver, la casita para volver al inicio, las skins, los ajustes, tu cabeza de la skin (al pasar el cursor dice qué cuenta tienes) y el botón de cerrar sesión.
- **Un solo botón** que cambia según el estado: **Descargar → Actualizar → Jugar → Jugando**. Mientras descarga se convierte en una tarjeta con la imagen de la instancia, el progreso, los MB/s y el tiempo que queda.
- Cada instancia tiene su **fondo propio**: imagen, GIF o vídeo.
- **Descargas rápidas**: varias a la vez, más conexiones para los archivos pequeños y desde los CDN oficiales (Mojang, Modrinth, Forge, NeoForge, Fabric y Quilt, más Cloudflare para los archivos de Viciont Studios).
- **Sin archivos dañados**: todo se descarga a un archivo temporal, se comprueba con SHA-1 y solo entonces se coloca en su sitio. Si cierras el launcher o se va la luz a mitad, la próxima vez se verifica y **continúa donde se quedó**. Al cerrar durante una descarga te pregunta y la pausa de forma segura.
- **Ajustes** de RAM (con la memoria de tu PC), argumentos de Java, resolución, pantalla completa, Java propio por versión, descargas simultáneas, efectos visuales, carpeta de datos (se puede mover) y qué hacer al abrir el juego.
- **Opciones por instancia**: RAM, Java, resolución y entrar directo al servidor.
- **Discord**: en tu perfil se ve «Jugando a Viciont Studios Launcher», la instancia que miras o descargas y a cuál juegas (con el tiempo de partida). Se puede desactivar en **Ajustes → Launcher**, donde también puedes ocultar el nombre de las instancias privadas.

**Para Viciont Studios (administración en dos pasos: nick autorizado desde el panel web + clave personal)**
- Solo los nicks a los que se les da acceso desde el **panel web privado** ven **Ajustes → Administración**, y además tienen que escribir su **clave personal**. Cada uno tiene sus permisos: crear instancias, editar y publicar, eliminar, nicks no premium (y se puede limitar a algunas instancias).
- Crear instancias **Vanilla, Fabric, Quilt, Forge o NeoForge** en cualquier versión de Minecraft, snapshots incluidas.
- **Tu carpeta es la instancia**: cada instancia se sincroniza con una carpeta de tu PC. La cambias desde el launcher, desde el Explorador de Windows o jugando, y al publicar solo se sube lo que cambió (lo nuevo, lo modificado y lo que quitaste). A los jugadores solo se les actualizan esos archivos. Si otro administrador publica antes, **Traer cambios** respeta lo tuyo.
- Añadir **mods, resource packs y shaders de Modrinth** (se descargan a tu carpeta con sus dependencias) o **archivos propios**: mods, `config`, `options.txt`, `kubejs`, mapas, etc.
- **Importar desde Modrinth App** sin exportar nada: sale la lista de tus instancias de Modrinth App con su versión, su cargador y su icono. También se puede importar un modpack `.mrpack` o una carpeta de CurseForge, Prism o `.minecraft`. Al publicar, los mods que existen en Modrinth se enlazan a su CDN en vez de subirlos.
- **Icono, fondo y banner** (la imagen de la tarjeta en *Instancias disponibles*): PNG, JPG, WEBP o GIF, y el fondo también en vídeo MP4/WEBM. Las imágenes se optimizan solas. El banner necesita el servidor v6.
- Instancias **públicas** o **privadas** (solo para los nicks que elijas).
- **Publicar versiones**: solo se suben los archivos nuevos o cambiados (los pequeños en lotes, así que publicar miles de archivos es rápido). Los jugadores ven **Actualizar** y el texto de novedades.
- **Qué cambió exactamente**: antes de publicar, **Ver cambios** lista los archivos nuevos, modificados y los que se quitan, y los textos o permisos que cambiaste. En las configs se ven las **líneas que cambiaron** (lo nuevo en verde, lo quitado en rojo), como en Git.
- Cada archivo elige cómo se actualiza: se reemplaza siempre, solo la primera vez o, en `options.txt` y parecidos, **se fusionan los ajustes**: el jugador recibe solo los que cambiaste (por ejemplo, el resource pack activado) y conserva los suyos (teclas, volumen, FOV…). Al publicar eliges qué ajustes se aplican.
- **Copia de prueba**: instala la instancia como la vería un jugador cualquiera, para probar cada actualización. El aviso de que es una copia de prueba va arriba, junto a su etiqueta, así la descripción se ve exactamente como la verán los jugadores.
- **Qué ven los jugadores** (todo viene desactivado): se puede quitar el botón «Carpeta» y ocultar:
  - los **mods** (con Fabric o Quilt): la carpeta `mods` se ve vacía y el juego los carga desde otro sitio del PC;
  - el contenido de **`config`** y los **resource packs**: se guardan aparte y el launcher los pone en su sitio solo mientras se juega (con enlaces duros: no ocupan el doble ni tardan). Al cerrar el juego se quitan y se guarda lo que el jugador cambió. Los resource packs y las carpetas de config quedan ocultos en el Explorador incluso mientras se juega.

  Dificulta copiar el contenido privado o ver antes de tiempo las sorpresas de un evento (nada de lo que se instala en un PC se puede proteger al 100%).
- Gestionar los nicks no premium registrados, por ejemplo liberar el de alguien que perdió su código.
- **Panel web** para el equipo de confianza (usuario, contraseña y verificación en dos pasos): permisos por nick y **registros** de todo lo que pasa (quién entra, quién está jugando, cambios de skin, descargas, actualizaciones y errores) para ayudar a los jugadores cuando algo falla. Los crashes del juego llevan su **informe completo** (crash report de Minecraft + registro del juego), que se lee, se copia o se descarga entero.

**Si el juego se cierra con un error**, el launcher enseña el **crash report completo** y el registro del juego (y el error de Java si lo hubo), con botones para copiarlo todo, guardarlo o abrir la carpeta de informes.

**Optimizado**
- Las descargas y las comprobaciones de archivos (SHA-1) van en un **hilo aparte**: la ventana sigue fluida aunque se descargue o compruebe una instancia muy pesada.
- El fondo animado (espiral, figuras flotantes, partículas y glitch) se dibuja a media resolución y con límite de FPS. Se **detiene por completo** cuando la ventana está minimizada, tapada o en segundo plano.
- Con la opción **"Cerrar la ventana"** al jugar, el launcher libera casi toda su memoria mientras juegas, se queda en la bandeja y vuelve a abrirse al cerrar el juego.

## Carpetas (como Modrinth App)

```
%APPDATA%\ViciontStudioLauncher\
├─ settings.json · accounts.dat (cifrado) · launcher_logs\
├─ meta\          ← compartido entre instancias
│  ├─ versions\  libraries\  assets\  natives\  java\
├─ instances\
│  └─ <instancia>\   mods · config · saves · resourcepacks · shaderpacks · …
├─ skins\  ·  caches\  ·  admin\  ·  backups\
```

La carpeta de datos se puede mover desde **Ajustes → Almacenamiento**.

## Desinstalar

Desde **Configuración de Windows → Aplicaciones → Viciont Studios Launcher**. El desinstalador pregunta:

- **Conservar** instancias, mundos, cuentas y skins, si vas a reinstalar.
- **Borrarlo todo**: instancias, mundos, cuentas, skins, Java y caché.

Las actualizaciones automáticas nunca borran datos.

## Servidor

Las instancias, los permisos, los archivos privados, las skins no premium, los registros y los administradores viven en un servidor de Viciont Studios en Cloudflare (Workers + R2 + D1). Su código es privado. Su dirección está en [`remote/launcher.json`](remote/launcher.json): todos los launchers la leen de ahí.

## Seguridad

- **Tu contraseña de Microsoft** solo se escribe en la página oficial de Microsoft, en una ventana aparte que solo puede abrir páginas de Microsoft (como Modrinth App). El launcher nunca la ve ni la guarda. Al cerrar sesión, Microsoft también olvida la cuenta en esa ventana.
- Las sesiones se guardan **cifradas con Windows (DPAPI)** en tu PC. Las cuentas premium se verifican con Mojang sin enviar su token al servidor de Viciont Studios: como un servidor de Minecraft (`join`) y, si Mojang no le contesta al servidor, con el certificado de jugador y las texturas **firmados por Mojang** (el launcher firma un desafío con la clave del certificado).
- La interfaz no tiene acceso a Node ni a tus archivos (Electron con `contextIsolation`, `sandbox` y CSP estricta). La versión instalada lleva los "fusibles" de seguridad de Electron activados: no se puede arrancar como Node, ni con depuradores, ni cargar código que no sea el suyo.
- **Sin servidores falsos**: en la versión instalada el servidor de Viciont Studios sale siempre de la configuración oficial de este repositorio y no se puede cambiar a mano, así que nadie puede engañarte para conectarte a otro con mods maliciosos.
- La administración necesita **dos llaves** (nick autorizado desde el panel + clave personal vinculada a su cuenta) y el servidor comprueba los permisos en cada acción.
- Todo lo que se descarga se comprueba con **SHA-1**. Rutas peligrosas (`../`), la carpeta interna del launcher, enlaces sin HTTPS, archivos alterados y enlaces caducados se rechazan tanto en el launcher como en el servidor.
- Java solo se puede elegir entre ejecutables `java.exe`/`javaw.exe` reales, y al subir archivos al servidor solo se aceptan los que eliges tú en el diálogo o arrastras a la ventana.

### Privacidad

Para poder ayudarte si algo falla, el launcher envía al servidor de Viciont Studios un **registro de actividad** básico: cuándo abres el launcher, entras o sales, cambios de skin, descargas y actualizaciones, cuándo juegas y los errores (con tu nick, la versión del launcher, tu versión de Windows y tu RAM). Si el juego se cierra con un error, también su informe (crash report y registro del juego). **Nunca** se envían contraseñas, tokens, códigos de recuperación, tus archivos ni tu IP, y las rutas de tu PC se acortan (`C:\Users\tu-usuario` → `~`). Solo lo ve el equipo de Viciont Studios en su panel privado y se borra a los 30 días. Está explicado también en **Ajustes → Acerca de**.

## Desarrollo

```bash
npm install
npm run vendor   # copia fuentes y el visor 3D de skins a src/renderer
npm start        # abre el launcher (desde el código es siempre modo desarrollo)
npm run dist     # crea el instalador en dist/
```

Para publicar una versión nueva: sube el número de `version` en `package.json` y crea una etiqueta `vX.Y.Z`. GitHub Actions compila el instalador y lo publica en Releases, y los launchers instalados se actualizan solos.

## Créditos

Creado por **CrissyjuanxD** para **Viciont Studios**. El funcionamiento está inspirado en [Modrinth App](https://github.com/modrinth/code), que es de código abierto.

Usa [CustomSkinLoader](https://github.com/xfl03/MCCustomSkinLoader) (GPL-3.0, se descarga desde Modrinth), [skinview3d](https://github.com/bs-community/skinview3d) (MIT), la API pública de [Modrinth](https://docs.modrinth.com/), Electron (MIT) y las fuentes Bebas Neue, Chakra Petch y Share Tech Mono (SIL OFL 1.1).

Minecraft es una marca de Mojang Studios y Microsoft. Este proyecto no está afiliado a Mojang ni a Microsoft.
