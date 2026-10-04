const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "cotizaciones.db");
const db = new Database(DB_PATH);

db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

console.log("Base:", DB_PATH);

/* =========================================================
   FASE 2A - CICLOS DE COTIZACIÓN MERCALDAS
   ========================================================= */

db.exec(`
CREATE TABLE IF NOT EXISTS ciclos_cotizacion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    codigo_ciclo TEXT NOT NULL UNIQUE,

    anio INTEGER NOT NULL,
    semana_recepcion INTEGER NOT NULL,

    fecha_inicio_recepcion TEXT NOT NULL,
    fecha_fin_recepcion TEXT NOT NULL,

    fecha_inicio_vigencia TEXT NOT NULL,
    fecha_fin_vigencia TEXT NOT NULL,

    estado TEXT NOT NULL DEFAULT 'BORRADOR'
        CHECK (
            estado IN (
                'BORRADOR',
                'ABIERTO',
                'POR_CERRAR',
                'CERRADO',
                'EN_VIGENCIA',
                'FINALIZADO'
            )
        ),

    creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cerrado_en TEXT,
    usuario_cierre TEXT,

    observaciones TEXT
);

CREATE INDEX IF NOT EXISTS idx_ciclos_anio
ON ciclos_cotizacion(anio);

CREATE INDEX IF NOT EXISTS idx_ciclos_semana
ON ciclos_cotizacion(semana_recepcion);

CREATE INDEX IF NOT EXISTS idx_ciclos_estado
ON ciclos_cotizacion(estado);

CREATE INDEX IF NOT EXISTS idx_ciclos_vigencia
ON ciclos_cotizacion(
    fecha_inicio_vigencia,
    fecha_fin_vigencia
);
`);

function dateUTC(y, m, d) {
    return new Date(Date.UTC(y, m, d));
}

function parseDateOnly(value) {
    const [y, m, d] = value.split("-").map(Number);
    return dateUTC(y, m - 1, d);
}

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

/*
 ISO week:
 lunes = inicio de semana ISO
 jueves determina el año ISO.
*/
function isoWeek(date) {
    const d = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
    ));

    const day = d.getUTCDay() || 7;

    d.setUTCDate(d.getUTCDate() + 4 - day);

    const yearStart = new Date(Date.UTC(
        d.getUTCFullYear(),
        0,
        1
    ));

    const week = Math.ceil(
        (((d - yearStart) / 86400000) + 1) / 7
    );

    return {
        year: d.getUTCFullYear(),
        week
    };
}

/*
 Busca el jueves más reciente respecto a una fecha.

 Ejemplo:
 2026-09-24 jueves -> mismo día
 2026-09-25 viernes -> jueves anterior
 2026-09-27 domingo -> jueves anterior

 Esto representa el ciclo de recepción más reciente.
*/
function mostRecentThursday(referenceDate) {
    const day = referenceDate.getUTCDay();

    // Domingo=0, lunes=1 ... jueves=4
    let diff = (day - 4 + 7) % 7;

    return addDays(referenceDate, -diff);
}

function buildCycleFromThursday(thursday) {
    const inicioRecepcion = thursday;
    const finRecepcion = addDays(thursday, 2);

    const inicioVigencia = addDays(thursday, 3);
    const finVigencia = addDays(thursday, 8);

    const iso = isoWeek(thursday);

    const codigo = `COT-${iso.year}-${String(iso.week).padStart(2, "0")}`;

    return {
        codigo_ciclo: codigo,
        anio: iso.year,
        semana_recepcion: iso.week,

        fecha_inicio_recepcion: formatDate(inicioRecepcion),
        fecha_fin_recepcion: formatDate(finRecepcion),

        fecha_inicio_vigencia: formatDate(inicioVigencia),
        fecha_fin_vigencia: formatDate(finVigencia)
    };
}

function estadoParaCiclo(ciclo, hoy) {
    const fechaHoy = formatDate(hoy);

    if (
        fechaHoy >= ciclo.fecha_inicio_recepcion &&
        fechaHoy < ciclo.fecha_fin_recepcion
    ) {
        return "ABIERTO";
    }

    if (fechaHoy === ciclo.fecha_fin_recepcion) {
        return "POR_CERRAR";
    }

    if (
        fechaHoy >= ciclo.fecha_inicio_vigencia &&
        fechaHoy <= ciclo.fecha_fin_vigencia
    ) {
        return "EN_VIGENCIA";
    }

    if (fechaHoy > ciclo.fecha_fin_vigencia) {
        return "FINALIZADO";
    }

    return "BORRADOR";
}

const insertCycle = db.prepare(`
INSERT INTO ciclos_cotizacion (
    codigo_ciclo,
    anio,
    semana_recepcion,
    fecha_inicio_recepcion,
    fecha_fin_recepcion,
    fecha_inicio_vigencia,
    fecha_fin_vigencia,
    estado
)
VALUES (
    @codigo_ciclo,
    @anio,
    @semana_recepcion,
    @fecha_inicio_recepcion,
    @fecha_fin_recepcion,
    @fecha_inicio_vigencia,
    @fecha_fin_vigencia,
    @estado
)
ON CONFLICT(codigo_ciclo) DO UPDATE SET
    anio = excluded.anio,
    semana_recepcion = excluded.semana_recepcion,
    fecha_inicio_recepcion = excluded.fecha_inicio_recepcion,
    fecha_fin_recepcion = excluded.fecha_fin_recepcion,
    fecha_inicio_vigencia = excluded.fecha_inicio_vigencia,
    fecha_fin_vigencia = excluded.fecha_fin_vigencia
`);

function ensureCycle(thursday, hoy) {
    const ciclo = buildCycleFromThursday(thursday);
    ciclo.estado = estadoParaCiclo(ciclo, hoy);

    insertCycle.run(ciclo);

    return ciclo;
}

/*
 Permite probar con una fecha:

 node scripts/fase2a_ciclos.js 2026-09-24

 Si no se indica fecha, usa hoy.
*/

let hoy;

if (process.argv[2]) {
    hoy = parseDateOnly(process.argv[2]);
} else {
    const now = new Date();

    hoy = dateUTC(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
    );
}

const juevesActual = mostRecentThursday(hoy);

const juevesAnterior = addDays(juevesActual, -7);
const juevesSiguiente = addDays(juevesActual, 7);

/*
 Creamos tres ciclos:
 anterior
 actual
 siguiente

 Esto facilita histórico y navegación.
*/
const ciclos = [
    ensureCycle(juevesAnterior, hoy),
    ensureCycle(juevesActual, hoy),
    ensureCycle(juevesSiguiente, hoy)
];

console.log("");
console.log("=== CICLOS GENERADOS / ACTUALIZADOS ===");

for (const ciclo of ciclos) {
    console.log({
        codigo: ciclo.codigo_ciclo,
        recepcion:
            `${ciclo.fecha_inicio_recepcion} -> ${ciclo.fecha_fin_recepcion}`,
        vigencia:
            `${ciclo.fecha_inicio_vigencia} -> ${ciclo.fecha_fin_vigencia}`,
        estado: ciclo.estado
    });
}

console.log("");
console.log("=== CICLOS EN BD ===");

const registros = db.prepare(`
SELECT
    id,
    codigo_ciclo,
    anio,
    semana_recepcion,
    fecha_inicio_recepcion,
    fecha_fin_recepcion,
    fecha_inicio_vigencia,
    fecha_fin_vigencia,
    estado
FROM ciclos_cotizacion
ORDER BY fecha_inicio_recepcion
`).all();

console.table(registros);

db.close();

console.log("");
console.log("FASE 2A: migración ejecutada correctamente.");
