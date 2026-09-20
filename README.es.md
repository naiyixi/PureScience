# PureScience · Español

> [中文](README.md) · [English](README.en.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [繁體中文](README.zh-Hant.md)

![Gráfico de potencia obtenido en una ejecución real — inhibidores de EGFR T790M, ordenados](docs/demo-verification/egfr_t790m_ic50.png)

*De una ejecución real, no de una simulación comercial: el código, los parámetros y la huella del entorno que hay detrás de este gráfico están archivados paso a paso en [`docs/demo-verification/`](docs/demo-verification/).*

PureScience es un entorno de trabajo científico de código abierto: se ejecuta en su propio equipo (macOS, Windows, Linux), funciona con el proveedor de modelos que ya tenga y convierte una tarea escrita en lenguaje natural en una sesión de agentes que lee archivos, ejecuta Python y R, busca en la web y consulta fuentes de datos científicas. Lo que devuelve es reproducible: informes, tablas y figuras enlazados al historial de actividad que los produjo.

La documentación completa — capacidades, configuración de modelos, permisos y la sección sincera de madurez con sus límites conocidos — está en inglés en [README.en.md](README.en.md) y en chino en [README.md](README.md). Esta página es la entrada corta.

## Empezar en tres pasos

1. **Descargar** — [última versión](https://github.com/naiyixi/PureScience/releases/latest): macOS (Apple Silicon, 268 MB · Intel, 284 MB), Windows (instalador, 220 MB), Linux (AppImage, 288 MB · `.deb`, 216 MB). Todos los paquetes incluyen sus sumas de comprobación en `SHA256SUMS.txt`, en la misma versión.
2. **Primer arranque** — al abrir por primera vez se eligen idioma y proveedor de modelos; sin clave no se ejecuta nada y nada se envía a ningún sitio.
3. **Primera tarea** — cree un proyecto, describa la tarea en lenguaje natural y déjela correr. El resultado aparece como artefacto con versión, procedencia e historial de actividad.

## En qué se diferencia

Cada ejecución es comprobable, no solo verosímil: las ejecuciones del cuaderno se auditan, las figuras se contrastan con reglas de publicación, cada recuerdo lleva su fuente y nada sale de su equipo sin su permiso. Hoy es más potente en bioinformática, biología computacional, genómica, biología estructural y descubrimiento de fármacos, con una arquitectura extensible a otras disciplinas.
