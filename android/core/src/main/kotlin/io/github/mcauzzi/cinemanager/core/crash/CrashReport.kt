package io.github.mcauzzi.cinemanager.core.crash

import kotlinx.serialization.Serializable

/**
 * Segnalazione di crash (`POST /api/app/crash`, docs/api.md). Versione dell'app e telefono sono
 * quelli del momento del crash: l'invio avviene al riavvio successivo, magari dopo un aggiornamento.
 */
@Serializable
data class CrashReport(
    /** `crash` (eccezione Java/Kotlin), `anr` (app bloccata), `native` (crash nativo). */
    val kind: String,
    /** ISO-8601 UTC. */
    val occurredAt: String,
    val appVersionCode: Int,
    val appVersion: String,
    val device: String,
    val android: String,
    val thread: String? = null,
    val exception: String? = null,
    val message: String? = null,
    val stackTrace: String? = null,
) {
    companion object {
        /** Oltre si tronca: un lotto di segnalazioni deve stare nel limite di 256 KB delle richieste dell'app. */
        const val STACK_MAX = 24 * 1024
        const val MESSAGE_MAX = 2_000

        /** Segnalazione di un'eccezione non gestita, con le cause (`Caused by:`) nello stack. */
        fun fromThrowable(error: Throwable, threadName: String, occurredAt: String, env: CrashEnvironment) = CrashReport(
            kind = "crash",
            occurredAt = occurredAt,
            appVersionCode = env.appVersionCode,
            appVersion = env.appVersion,
            device = env.device,
            android = env.android,
            thread = threadName,
            exception = error.javaClass.name,
            message = error.message?.let { truncate(it, MESSAGE_MAX) },
            stackTrace = truncate(error.stackTraceToString(), STACK_MAX),
        )

        fun truncate(s: String, max: Int): String = if (s.length <= max) s else s.take(max) + "\n…[troncato]"
    }
}

/** Dati fissi dell'app e del telefono, raccolti all'avvio. */
data class CrashEnvironment(val appVersionCode: Int, val appVersion: String, val device: String, val android: String)
