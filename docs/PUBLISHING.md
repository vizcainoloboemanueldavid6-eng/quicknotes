# Cómo publicar QuickNotes en la Chrome Web Store

Guía paso a paso para publicar la versión 1.0.0 y las actualizaciones siguientes. Todo lo que hay que
pegar en el panel ya está escrito en el repositorio:

| Qué                                               | Dónde                                                           |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Paquete para subir                                | `quicknotes-v1.0.0.zip` (se genera con `npm run zip`)           |
| Título, resumen y descripción larga               | [`store-assets/description.md`](../store-assets/description.md) |
| Icono, 3 capturas 1280×800 y promo 440×280        | carpeta [`store-assets/`](../store-assets/)                     |
| Propósito único, justificación de permisos, datos | [`PRIVACY.md`](../PRIVACY.md), segunda mitad                    |
| Política de privacidad (texto público)            | [`PRIVACY.md`](../PRIVACY.md), primera mitad                    |

> Los textos de la ficha están en inglés porque la interfaz principal de la extensión es inglés.
> El paquete incluye también español (`_locales/es`), y Chrome muestra el nombre y el resumen en
> español a quien tenga el navegador en español.

---

## 1. Preparar y comprobar el paquete

En la carpeta del proyecto:

```bash
npm ci
npm run lint
npm test
npm run test:e2e
npm run zip
```

`npm run zip` compila y genera `quicknotes-v1.0.0.zip` en la raíz del proyecto. Ábrelo y comprueba
que `manifest.json` está **en la raíz del zip** (no dentro de una carpeta `dist/`), junto a
`_locales/`, `icons/`, `src/` y `assets/`. Si cambiaste textos o estilos visibles, regenera también
las imágenes con `npm run store-assets`.

Antes de subirlo, pruébalo una vez a mano: `chrome://extensions` → modo de desarrollador →
**Cargar descomprimida** → carpeta `dist/`, y úsalo en `npm run demo`
(<http://127.0.0.1:4323/article.html>).

## 2. Crear la cuenta de desarrollador (una sola vez)

1. Usa una cuenta de Google con **verificación en dos pasos** activada: la Chrome Web Store la exige
   para publicar. Mejor una cuenta dedicada a publicar, no la personal del día a día.
2. Entra en el panel de desarrollador: <https://chrome.google.com/webstore/devconsole>.
3. Acepta el acuerdo para desarrolladores y paga la **tarifa de registro única de 5 US$** con
   tarjeta. No hay pagos anuales ni por extensión.
4. En **Cuenta**:
   - escribe el **nombre del editor** (aparece en la ficha como autor);
   - añade y **verifica el correo de contacto** (Google envía un enlace; sin verificarlo no deja
     publicar);
   - completa la **declaración de comerciante / no comerciante** (exigida por la normativa de la
     Unión Europea). Si publicas QuickNotes gratis como proyecto personal o de portafolio, lo normal
     es declararte "no comerciante"; si la usas para vender servicios, elige "comerciante" y rellena
     los datos que pide.

## 3. Crear el elemento y subir el zip

1. En el panel: **Elementos → + Nuevo elemento**.
2. Arrastra `quicknotes-v1.0.0.zip`. El panel lee el `manifest.json`: nombre, versión, descripción,
   iconos y permisos. Si muestra un error de manifiesto, corrígelo, vuelve a ejecutar
   `npm run zip` y sube el nuevo archivo.

## 4. Ficha de Chrome Web Store ("Store listing")

Copia de [`store-assets/description.md`](../store-assets/description.md):

- **Título** y **resumen**: vienen del paquete (`extName` y `extDescription`) y el panel los muestra
  sin editar. Título: 37/45 caracteres; resumen: 126/132.
- **Descripción**: pega el bloque "Description (long)".
- **Categoría**: Productividad → _Workflow & Planning_.
- **Idioma**: inglés.
- **Icono de la tienda**: `store-assets/icon-128.png` (128×128).
- **Capturas de pantalla**: las tres `store-assets/screenshot-*.png` (1280×800), en ese orden.
- **Mosaico promocional pequeño**: `store-assets/promo-small-440x280.png` (440×280, obligatorio).
  El mosaico grande (1400×560) es opcional; no hace falta.
- **Sitio web / URL de asistencia** (opcionales): si subes el proyecto a un repositorio público,
  puedes poner la URL del repositorio o de su página de _issues_.

Guarda el borrador (**Guardar borrador**) antes de pasar a la pestaña siguiente.

## 5. Prácticas de privacidad ("Privacy practices")

Esta pestaña es la que más se revisa. Todo el texto está en la segunda mitad de
[`PRIVACY.md`](../PRIVACY.md); cópialo campo por campo:

1. **Propósito único**: el párrafo "Single purpose".
2. **Justificación de cada permiso**: un campo por permiso (`storage`, `activeTab`, `scripting`,
   `contextMenus`, `sidePanel`) y otro para los **permisos de host**.
3. **Código remoto**: "No, no uso código remoto".
4. **Uso de datos**: no marques ninguna categoría (QuickNotes no transmite nada fuera del
   dispositivo) y marca las **tres certificaciones** del final.
5. **URL de la política de privacidad**: ver el paso 6.

### Por qué `activeTab`, `scripting` y los permisos de host opcionales reciben más atención

Los revisores de Google miran con lupa los permisos que permiten leer o modificar páginas web:

- **`scripting`** permite ejecutar código dentro de las páginas. Hay que dejar claro que el código
  que se inyecta es el del propio paquete (`src/content/index.js`) y que no se descarga código
  remoto. La justificación lo dice explícitamente.
- **`activeTab`** da acceso temporal a la pestaña en la que el usuario actúa (clic en el botón, menú
  contextual o <kbd>Alt</kbd>+<kbd>N</kbd>). Es la forma recomendada por Google de evitar permisos
  amplios, pero igualmente hay que explicar para qué se usa.
- **Permisos de host `http://*/*` y `https://*/*`** equivalen a "leer y cambiar todos tus datos en
  todos los sitios web", que es lo que más escrutinio recibe y lo que más alarga la revisión cuando
  es obligatorio. En QuickNotes son **opcionales** (`optional_host_permissions`): la instalación no
  los pide, Chrome no muestra esa advertencia al instalar, y solo se solicitan si el usuario activa
  "Restore my notes automatically on every site" en Opciones. Menciona siempre que son opcionales y
  que desactivar la opción anula el registro del script. Si un revisor pide reducirlos, la extensión
  funciona igual sin ellos (con `activeTab`).

Consejos para que no la rechacen:

- que cada justificación describa **lo que hace el código**, sin frases genéricas;
- no pedir permisos que no se usan (el paquete ya pide solo estos cinco más los opcionales);
- que la descripción de la ficha no prometa nada que la extensión no haga.

## 6. Publicar la política de privacidad en una URL

El panel pide una **URL pública** con la política. Opciones, de la más sencilla a la más cuidada:

1. **GitHub Gist**: crea un gist público con el contenido de la primera mitad de `PRIVACY.md`
   (hasta la línea `---`) y copia su URL.
2. **Repositorio público en GitHub**: si subes el proyecto, la URL de `PRIVACY.md` en GitHub sirve
   directamente.
3. **Tu propio sitio** (por ejemplo, tu portafolio): una página con el mismo texto.

Pega esa URL en **Prácticas de privacidad → URL de la política de privacidad**. Si en el futuro la
extensión cambia lo que guarda, actualiza primero la política y luego publica la versión nueva.

## 7. Distribución

En la pestaña **Distribución**:

- **Pago**: gratis.
- **Visibilidad**: _Público_ para que cualquiera la encuentre, o _No listado_ si solo quieres
  compartir el enlace (útil para un portafolio o para clientes).
- **Regiones**: todas.

## 8. Instrucciones para el revisor (opcional pero recomendable)

Si el panel muestra el campo **Instrucciones de prueba**, pega algo así:

> No account or login is needed. Open any article (for example a news or Wikipedia page), click the
> QuickNotes toolbar button, then select text: a toolbar appears to highlight it or add a note.
> Reload the page and click the button again: highlights and notes come back. The side panel
> ("Open side panel" in the popup) lists them and exports them to Markdown. The optional host
> permission is only requested from Options → "Restore my notes automatically on every site".

## 9. Enviar a revisión

1. Revisa que las pestañas **Paquete**, **Ficha**, **Privacidad** y **Distribución** no tengan
   avisos pendientes.
2. Pulsa **Enviar para revisión**.
3. Elige si se publica **automáticamente** al aprobarse o si prefieres **publicarla tú** después
   (publicación diferida). Con la publicación diferida tienes 30 días desde la aprobación para
   pulsar **Publicar**; si no, vuelve a borrador.

## 10. Tiempos de revisión y estados

- La mayoría de envíos se revisan en **pocos días hábiles** (a menudo 1–3). La primera versión de
  una cuenta nueva y las extensiones con permisos sensibles pueden pasar a **revisión en
  profundidad** y tardar **una o varias semanas**.
- Estados habituales: _Pendiente de revisión_ → _Aprobado_ / _Publicado_, o _Rechazado_. Google
  avisa por correo en cada cambio.
- Si la rechazan, el correo indica la política incumplida (por ejemplo, "permisos excesivos",
  "falta la política de privacidad" o "descripción engañosa"). Corrige lo indicado y vuelve a
  enviar; si crees que es un error, responde desde el enlace de apelación del propio correo
  explicando el uso de cada permiso con los textos de `PRIVACY.md`.

## 11. Publicar actualizaciones

1. Sube la versión en `package.json` (por ejemplo `1.0.1`); el `manifest.json` toma la versión de
   ahí. La Chrome Web Store exige que cada paquete tenga una versión **mayor** que la anterior.
2. Ejecuta de nuevo `npm test`, `npm run test:e2e` y `npm run zip` (el zip se llamará
   `quicknotes-v1.0.1.zip`).
3. En el panel: abre el elemento → **Paquete** → **Subir nuevo paquete** → elige el zip.
4. Actualiza la ficha o las capturas si cambió algo visible (`npm run store-assets`).
5. **Enviar para revisión**. Los usuarios reciben la actualización automáticamente en unas horas
   después de publicarla.

Ojo con los permisos: si una versión nueva **añade permisos obligatorios** que muestran advertencias,
Chrome desactiva la extensión a cada usuario hasta que acepte los nuevos permisos. Por eso los
permisos de host de QuickNotes son opcionales: se pueden pedir en tiempo de ejecución sin afectar a
quien ya la tiene instalada.
